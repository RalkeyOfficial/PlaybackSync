<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\Service;

use OCA\PlaybackSync\AppInfo\Application;
use OCA\PlaybackSync\Service\Exceptions\ClientNotFoundException;
use OCA\PlaybackSync\Service\Exceptions\KickFailedException;
use OCP\Http\Client\IClientService;
use OCP\IAppConfig;
use Psr\Log\LoggerInterface;
use Throwable;

/**
 * HTTP client for the daemon's loopback kick endpoint.
 *
 * Sibling of `PresenceClient` — same HMAC scheme, same config keys, same
 * 200 ms timeout. Different in two ways:
 *   - failure is loud: callers explicitly need to know whether the kick was
 *     accepted, so transport errors raise `KickFailedException` rather than
 *     collapsing to a quiet empty result.
 *   - 404 from the daemon is mapped to `ClientNotFoundException` (the room
 *     or the live client wasn't there); other non-200 responses surface as
 *     `KickFailedException`.
 */
class AdminKickClient {

	public const DEFAULT_TIMEOUT_SECONDS = 0.2;

	public function __construct(
		private readonly IClientService $clientService,
		private readonly IAppConfig $appConfig,
		private readonly LoggerInterface $logger,
	) {
	}

	/**
	 * Disconnect the named client from the daemon's live runtime for the room.
	 *
	 * @throws ClientNotFoundException when the daemon answered that no such
	 *                                 room/client is currently connected.
	 * @throws KickFailedException     when the call could not be completed —
	 *                                 daemon down, HMAC misconfigured, etc.
	 */
	public function kick(string $roomUuid, string $clientId): void {
		$secret = $this->appConfig->getValueString(Application::APP_ID, 'ws_admin_secret', '');
		if ($secret === '') {
			throw new KickFailedException('Admin secret is not configured.');
		}

		$host = $this->appConfig->getValueString(Application::APP_ID, 'ws_admin_host', '127.0.0.1');
		$port = $this->appConfig->getValueInt(Application::APP_ID, 'ws_admin_port', 8766);

		$path = '/admin/rooms/' . rawurlencode($roomUuid) . '/clients/' . rawurlencode($clientId) . '/disconnect';
		$nowMs = (int)(microtime(true) * 1000);
		$canonical = "POST\n" . $path . "\n" . $nowMs;
		$sig = hash_hmac('sha256', $canonical, $secret);
		$header = 't=' . $nowMs . ',sig=' . $sig;

		$url = 'http://' . $host . ':' . $port . $path;

		try {
			$response = $this->clientService->newClient()->post($url, [
				'headers' => [
					'X-PBSync-Admin' => $header,
					'Accept' => 'application/json',
					'Content-Length' => '0',
				],
				'body' => '',
				'timeout' => self::DEFAULT_TIMEOUT_SECONDS,
				'connect_timeout' => self::DEFAULT_TIMEOUT_SECONDS,
				'nextcloud' => ['allow_local_address' => true],
				// Don't let Guzzle/Nextcloud throw on non-2xx — we read the status ourselves.
				'http_errors' => false,
			]);
		} catch (Throwable $e) {
			$this->logger->warning('AdminKickClient request failed', ['exception' => $e]);
			throw new KickFailedException('WebSocket daemon unreachable.', 0, $e);
		}

		$status = $response->getStatusCode();
		if ($status === 200) {
			return;
		}
		if ($status === 404) {
			throw new ClientNotFoundException('Client is not connected to this room.');
		}

		$this->logger->warning('AdminKickClient got unexpected status from admin endpoint', [
			'status' => $status,
		]);
		throw new KickFailedException('Unexpected status from WebSocket daemon: ' . $status);
	}
}
