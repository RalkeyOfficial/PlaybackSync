<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\Service;

use OCA\PlaybackSync\AppInfo\Application;
use OCP\Http\Client\IClientService;
use OCP\IAppConfig;
use Psr\Log\LoggerInterface;
use Throwable;

/**
 * HTTP client for the daemon's loopback "destroy room" endpoint.
 *
 * Sibling of `AdminKickClient` — same HMAC scheme, same config keys, same
 * 200 ms timeout. Differs in failure handling: this is fired *after* the DB
 * row for the room has already been deleted, so the DB is the source of
 * truth. A daemon-unreachable failure (or a 404 because no runtime was
 * live) is logged at info and swallowed — there is no caller-meaningful
 * distinction between "destroyed live runtime" and "no live runtime to
 * destroy". `Tick` will eventually clean up any orphaned runtime via the
 * TTL path if this call missed.
 */
class AdminRoomDestroyClient {

	public const DEFAULT_TIMEOUT_SECONDS = 0.2;

	public function __construct(
		private readonly IClientService $clientService,
		private readonly IAppConfig $appConfig,
		private readonly LoggerInterface $logger,
	) {
	}

	/**
	 * Tell the daemon to close all sockets for the room and forget the
	 * runtime. Best-effort; never throws.
	 *
	 * @param string $roomUuid UUID of the room whose live runtime should be
	 *                         torn down.
	 */
	public function destroy(string $roomUuid): void {
		$secret = $this->appConfig->getValueString(Application::APP_ID, 'ws_admin_secret', '');
		if ($secret === '') {
			$this->logger->info('AdminRoomDestroyClient skipped: admin secret not configured');
			return;
		}

		$host = $this->appConfig->getValueString(Application::APP_ID, 'ws_admin_host');
		$port = $this->appConfig->getValueInt(Application::APP_ID, 'ws_admin_port');

		$path = '/admin/rooms/' . rawurlencode($roomUuid) . '/destroy';
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
				'http_errors' => false,
			]);
		} catch (Throwable $e) {
			$this->logger->info('AdminRoomDestroyClient request failed; daemon unreachable', [
				'exception' => $e,
			]);
			return;
		}

		$status = $response->getStatusCode();
		if ($status === 200 || $status === 404) {
			return;
		}

		$this->logger->info('AdminRoomDestroyClient got unexpected status from admin endpoint', [
			'status' => $status,
		]);
	}
}
