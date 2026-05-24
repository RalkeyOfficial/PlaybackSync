<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\Service;

use OCA\PlaybackSync\AppInfo\Application;
use OCA\PlaybackSync\Service\Exceptions\PlaybackCommandFailedException;
use OCP\Http\Client\IClientService;
use OCP\IAppConfig;
use Psr\Log\LoggerInterface;
use Throwable;

/**
 * HTTP client for the daemon's loopback `POST /admin/rooms/{uuid}/broadcast`
 * endpoint. Sibling of `AdminPlaybackClient`: same HMAC scheme, same config
 * keys, same 200 ms timeout.
 *
 * Triggered by Nextcloud-side HTTP controllers after a DB write so the
 * daemon re-hydrates its runtime cache and fans out the appropriate WS
 * frame to connected clients. When the daemon reports `no_runtime`
 * (nobody is connected to the room yet) we swallow the response — the
 * next `JOIN` will hydrate from DB anyway, so there's nothing to fix.
 */
class AdminRoomBroadcastClient {

	public const DEFAULT_TIMEOUT_SECONDS = 0.2;

	public const KIND_CURSOR_CHANGE = 'cursor_change';
	public const KIND_PLAYLIST_UPDATE = 'playlist_update';
	public const KIND_ROOM_STATE = 'room_state';

	public function __construct(
		private readonly IClientService $clientService,
		private readonly IAppConfig $appConfig,
		private readonly LoggerInterface $logger,
	) {
	}

	/**
	 * @param string      $roomUuid    Room the daemon should re-hydrate + broadcast.
	 * @param string      $kind        One of the `KIND_*` constants.
	 * @param string|null $ownerUserId Nextcloud userId driving the change; forwarded to the event log envelope.
	 */
	public function broadcast(string $roomUuid, string $kind, ?string $ownerUserId = null): void {
		$secret = $this->appConfig->getValueString(Application::APP_ID, 'ws_admin_secret', '');
		if ($secret === '') {
			throw new PlaybackCommandFailedException('Admin secret is not configured.');
		}

		$host = $this->appConfig->getValueString(Application::APP_ID, 'ws_admin_host');
		$port = $this->appConfig->getValueInt(Application::APP_ID, 'ws_admin_port');

		$path = '/admin/rooms/' . rawurlencode($roomUuid) . '/broadcast';
		$nowMs = (int)(microtime(true) * 1000);
		$canonical = "POST\n" . $path . "\n" . $nowMs;
		$sig = hash_hmac('sha256', $canonical, $secret);
		$header = 't=' . $nowMs . ',sig=' . $sig;

		$payload = ['kind' => $kind];
		if ($ownerUserId !== null) {
			$payload['userId'] = $ownerUserId;
		}
		$body = json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
		if ($body === false) {
			throw new PlaybackCommandFailedException('Failed to encode broadcast payload.');
		}

		$url = 'http://' . $host . ':' . $port . $path;

		try {
			$response = $this->clientService->newClient()->post($url, [
				'headers' => [
					'X-PBSync-Admin' => $header,
					'Content-Type' => 'application/json',
					'Accept' => 'application/json',
					'Content-Length' => (string)strlen($body),
				],
				'body' => $body,
				'timeout' => self::DEFAULT_TIMEOUT_SECONDS,
				'connect_timeout' => self::DEFAULT_TIMEOUT_SECONDS,
				'nextcloud' => ['allow_local_address' => true],
				'http_errors' => false,
			]);
		} catch (Throwable $e) {
			// Broadcast failures are not fatal for the HTTP write — the
			// DB has already changed, the next JOIN re-hydrates. Log and
			// move on rather than rolling back the user's request.
			$this->logger->info('AdminRoomBroadcastClient request failed', ['exception' => $e]);
			return;
		}

		$status = $response->getStatusCode();
		if ($status === 200 || $status === 404) {
			// 200 = applied or no_runtime; 404 = room not in DB (gone).
			return;
		}

		$this->logger->warning('AdminRoomBroadcastClient got unexpected status', [
			'status' => $status,
			'kind' => $kind,
		]);
	}
}
