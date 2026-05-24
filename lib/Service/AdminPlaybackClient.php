<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\Service;

use OCA\PlaybackSync\AppInfo\Application;
use OCA\PlaybackSync\Service\Exceptions\PlaybackCommandFailedException;
use OCA\PlaybackSync\Service\Exceptions\RoomNotLiveException;
use OCP\Http\Client\IClientService;
use OCP\IAppConfig;
use Psr\Log\LoggerInterface;
use Throwable;

/**
 * HTTP client for the daemon's loopback playback endpoint.
 *
 * Sibling of `AdminKickClient` — same HMAC scheme, same config keys, same
 * 200 ms timeout. Different in two ways:
 *   - the body is a JSON payload describing the action and (for seek) the
 *     target position in seconds.
 *   - 404 from the daemon means the room has no live runtime (no client has
 *     joined yet) and surfaces as `RoomNotLiveException`; other non-200
 *     responses surface as `PlaybackCommandFailedException`.
 */
class AdminPlaybackClient {

	public const DEFAULT_TIMEOUT_SECONDS = 0.2;

	public function __construct(
		private readonly IClientService $clientService,
		private readonly IAppConfig $appConfig,
		private readonly LoggerInterface $logger,
	) {
	}

	/**
	 * Send a playback command to the daemon's live runtime for the room.
	 *
	 * @param string      $roomUuid Room to target.
	 * @param string      $action   One of `play`, `pause`, `seek`, `reset`.
	 * @param float|null  $videoPos Target position in seconds when `$action` is
	 *                              `seek`. Ignored otherwise.
	 * @param string|null $userId   Nextcloud userId of the room owner that
	 *                              triggered this command. Forwarded to the
	 *                              daemon so the emitted playback envelope can
	 *                              carry `actor: 'owner', actorId: $userId`.
	 *
	 * @throws RoomNotLiveException             when the daemon reports no live
	 *                                          runtime for the room.
	 * @throws PlaybackCommandFailedException   when the call could not be
	 *                                          completed — daemon down, HMAC
	 *                                          misconfigured, invalid payload,
	 *                                          or any other non-200 response.
	 */
	public function apply(string $roomUuid, string $action, ?float $videoPos, ?string $userId = null): void {
		$secret = $this->appConfig->getValueString(Application::APP_ID, 'ws_admin_secret', '');
		if ($secret === '') {
			throw new PlaybackCommandFailedException('Admin secret is not configured.');
		}

		$host = $this->appConfig->getValueString(Application::APP_ID, 'ws_admin_host');
		$port = $this->appConfig->getValueInt(Application::APP_ID, 'ws_admin_port');

		$path = '/admin/rooms/' . rawurlencode($roomUuid) . '/playback';
		$nowMs = (int)(microtime(true) * 1000);
		$canonical = "POST\n" . $path . "\n" . $nowMs;
		$sig = hash_hmac('sha256', $canonical, $secret);
		$header = 't=' . $nowMs . ',sig=' . $sig;

		$payload = ['action' => $action];
		if ($videoPos !== null) {
			$payload['videoPos'] = $videoPos;
		}
		if ($userId !== null) {
			$payload['userId'] = $userId;
		}
		$body = json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
		if ($body === false) {
			throw new PlaybackCommandFailedException('Failed to encode playback payload.');
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
				// Don't let Guzzle/Nextcloud throw on non-2xx — we read the status ourselves.
				'http_errors' => false,
			]);
		} catch (Throwable $e) {
			$this->logger->warning('AdminPlaybackClient request failed', ['exception' => $e]);
			throw new PlaybackCommandFailedException('WebSocket daemon unreachable.', 0, $e);
		}

		$status = $response->getStatusCode();
		if ($status === 200) {
			return;
		}
		if ($status === 404) {
			throw new RoomNotLiveException('Room has no active clients.');
		}

		$this->logger->warning('AdminPlaybackClient got unexpected status from admin endpoint', [
			'status' => $status,
		]);
		throw new PlaybackCommandFailedException('Unexpected status from WebSocket daemon: ' . $status);
	}
}
