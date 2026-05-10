<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\Service;

use OCA\PlaybackSync\AppInfo\Application;
use OCP\Http\Client\IClientService;
use OCP\IAppConfig;
use Psr\Log\LoggerInterface;
use Throwable;

/**
 * Loopback HTTP client for the daemon's `GET /healthz` endpoint.
 *
 * Sibling of `PresenceClient`: same `IClientService`, same loopback
 * `allow_local_address` flag, same 200 ms timeout. Differences:
 *   - No `X-PBSync-Admin` header — `/healthz` is unauthenticated by design.
 *   - Failure NEVER throws. Healthcheck callers (load balancers, k8s probes,
 *     admins reading a status page) do not want a 5xx; transport errors
 *     collapse to `['reachable' => false, 'error' => …]` so the public
 *     route can stay HTTP 200 with a `degraded` status.
 */
class HealthClient {

	public const DEFAULT_TIMEOUT_SECONDS = 0.2;

	public function __construct(
		private readonly IClientService $clientService,
		private readonly IAppConfig $appConfig,
		private readonly LoggerInterface $logger,
	) {
	}

	/**
	 * Probe the daemon's healthcheck endpoint.
	 *
	 * @return array{reachable: true, latency_ms: int, body: array<string, mixed>}
	 *         |array{reachable: false, error: string}
	 */
	public function fetch(): array {
		$host = $this->appConfig->getValueString(Application::APP_ID, 'ws_admin_host', '127.0.0.1');
		$port = $this->appConfig->getValueInt(Application::APP_ID, 'ws_admin_port', 8766);
		$url = 'http://' . $host . ':' . $port . '/healthz';

		$startedNs = hrtime(true);

		try {
			$response = $this->clientService->newClient()->get($url, [
				'headers' => ['Accept' => 'application/json'],
				'timeout' => self::DEFAULT_TIMEOUT_SECONDS,
				'connect_timeout' => self::DEFAULT_TIMEOUT_SECONDS,
				'nextcloud' => ['allow_local_address' => true],
				// Read non-2xx ourselves so a degraded daemon doesn't surface
				// as an exception.
				'http_errors' => false,
			]);
		} catch (Throwable $e) {
			$this->logger->warning('HealthClient request failed', ['exception' => $e]);
			return ['reachable' => false, 'error' => 'request_failed'];
		}

		$latencyMs = (int)((hrtime(true) - $startedNs) / 1_000_000);

		$status = $response->getStatusCode();
		if ($status !== 200) {
			$this->logger->warning('HealthClient got non-200 from daemon', ['status' => $status]);
			return ['reachable' => false, 'error' => 'http_' . $status];
		}

		$body = (string)$response->getBody();
		$decoded = json_decode($body, true);
		if (!is_array($decoded)) {
			$this->logger->warning('HealthClient got malformed body from daemon');
			return ['reachable' => false, 'error' => 'invalid_json'];
		}

		return [
			'reachable' => true,
			'latency_ms' => $latencyMs,
			'body' => $decoded,
		];
	}
}
