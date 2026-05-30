<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\Service;

use OCA\PlaybackSync\AppInfo\Application;
use OCA\PlaybackSync\Service\Exceptions\DaemonReloadFailedException;
use OCP\Http\Client\IClientService;
use OCP\IAppConfig;
use Psr\Log\LoggerInterface;
use Throwable;

/**
 * HTTP client for the daemon's loopback config-reload endpoint.
 *
 * Sibling of `AdminRestartClient` — same HMAC scheme and config keys. Asks the
 * running daemon to re-read its tunables from `IAppConfig` in place (no socket
 * teardown, no reconnect), unlike the restart client which makes it exit. The
 * daemon answers `200` with the set of changed values.
 */
class AdminReloadClient {

	public const DEFAULT_TIMEOUT_SECONDS = 1.0;

	public function __construct(
		private readonly IClientService $clientService,
		private readonly IAppConfig $appConfig,
		private readonly LoggerInterface $logger,
	) {
	}

	/**
	 * Ask the daemon to reload its tunables.
	 *
	 * @return array<string, array{from: int, to: int}> the tunables the daemon
	 *         reported as changed, keyed by property name (empty if none)
	 * @throws DaemonReloadFailedException when the call could not be completed —
	 *                                     daemon unreachable, HMAC misconfigured,
	 *                                     or a non-200 response.
	 */
	public function reload(): array {
		$secret = $this->appConfig->getValueString(Application::APP_ID, 'ws_admin_secret', '');
		if ($secret === '') {
			throw new DaemonReloadFailedException('Admin secret is not configured.');
		}

		$host = $this->appConfig->getValueString(Application::APP_ID, 'ws_admin_host');
		$port = $this->appConfig->getValueInt(Application::APP_ID, 'ws_admin_port');

		$path = '/admin/reload';
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
				'http_errors' => false,
			]);
		} catch (Throwable $e) {
			$this->logger->warning('AdminReloadClient request failed', ['exception' => $e]);
			throw new DaemonReloadFailedException('WebSocket daemon unreachable.', 0, $e);
		}

		$status = $response->getStatusCode();
		if ($status !== 200) {
			$this->logger->warning('AdminReloadClient got unexpected status from admin endpoint', [
				'status' => $status,
			]);
			throw new DaemonReloadFailedException('Unexpected status from WebSocket daemon: ' . $status);
		}

		$decoded = json_decode((string)$response->getBody(), true);
		if (is_array($decoded) && is_array($decoded['changed'] ?? null)) {
			/** @var array<string, array{from: int, to: int}> */
			return $decoded['changed'];
		}
		return [];
	}
}
