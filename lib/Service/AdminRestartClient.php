<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\Service;

use OCA\PlaybackSync\AppInfo\Application;
use OCA\PlaybackSync\Service\Exceptions\DaemonRestartFailedException;
use OCP\Http\Client\IClientService;
use OCP\IAppConfig;
use Psr\Log\LoggerInterface;
use Throwable;

/**
 * HTTP client for the daemon's loopback restart endpoint.
 *
 * Sibling of `AdminKickClient` — same HMAC scheme and config keys. It asks the
 * daemon to exit gracefully so an external supervisor (`restart: unless-stopped`
 * sidecar, systemd) starts a fresh process. The daemon answers `200` and then
 * stops its event loop a moment later, so a `200` here means "exit accepted",
 * *not* "daemon is back up" — the caller confirms recovery by polling the WS
 * status endpoint.
 */
class AdminRestartClient {

	// Slightly more generous than AdminKickClient's 200 ms: the daemon answers
	// before it stops its loop, but a hair more connect margin avoids a spurious
	// failure if the loopback is briefly busy.
	public const DEFAULT_TIMEOUT_SECONDS = 1.0;

	public function __construct(
		private readonly IClientService $clientService,
		private readonly IAppConfig $appConfig,
		private readonly LoggerInterface $logger,
	) {
	}

	/**
	 * Ask the daemon to exit so its supervisor restarts it.
	 *
	 * @throws DaemonRestartFailedException when the call could not be completed —
	 *                                      daemon unreachable, HMAC misconfigured,
	 *                                      or a non-200 response.
	 */
	public function restart(): void {
		$secret = $this->appConfig->getValueString(Application::APP_ID, 'ws_admin_secret', '');
		if ($secret === '') {
			throw new DaemonRestartFailedException('Admin secret is not configured.');
		}

		$host = $this->appConfig->getValueString(Application::APP_ID, 'ws_admin_host');
		$port = $this->appConfig->getValueInt(Application::APP_ID, 'ws_admin_port');

		$path = '/admin/restart';
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
				],
				'timeout' => self::DEFAULT_TIMEOUT_SECONDS,
				'connect_timeout' => self::DEFAULT_TIMEOUT_SECONDS,
				'nextcloud' => ['allow_local_address' => true],
				// Read the status ourselves instead of letting Guzzle throw on non-2xx.
				'http_errors' => false,
			]);
		} catch (Throwable $e) {
			$this->logger->warning('AdminRestartClient request failed', ['exception' => $e]);
			throw new DaemonRestartFailedException('WebSocket daemon unreachable.', 0, $e);
		}

		$status = $response->getStatusCode();
		if ($status === 200) {
			return;
		}

		$this->logger->warning('AdminRestartClient got unexpected status from admin endpoint', [
			'status' => $status,
		]);
		throw new DaemonRestartFailedException('Unexpected status from WebSocket daemon: ' . $status);
	}
}
