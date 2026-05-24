<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\Service;

use OCA\PlaybackSync\AppInfo\Application;
use OCA\PlaybackSync\Service\Dto\RoomLiveState;
use OCP\Http\Client\IClientService;
use OCP\IAppConfig;
use Psr\Log\LoggerInterface;
use Throwable;

/**
 * HTTP client for the daemon's loopback admin endpoint.
 *
 * Single batched call: the rooms-API enricher asks for many UUIDs at once,
 * we sign one request, parse the JSON map of presence payloads, return the
 * map keyed by UUID.
 *
 * Failure modes — daemon down, HMAC mismatch, timeout, malformed body — all
 * collapse to the empty map plus one warn-log per request. The rooms API
 * still returns; affected rooms surface as `live: null` upstream.
 */
class PresenceClient {

	public const DEFAULT_TIMEOUT_SECONDS = 0.2;

	public function __construct(
		private readonly IClientService $clientService,
		private readonly IAppConfig $appConfig,
		private readonly LoggerInterface $logger,
	) {
	}

	/**
	 * Fetch presence for the given room UUIDs.
	 *
	 * @param list<string> $uuids
	 * @return array<string, RoomLiveState>  Map keyed by UUID. UUIDs the daemon
	 *                                       has no live runtime for are absent
	 *                                       from the result, NOT mapped to null.
	 */
	public function fetch(array $uuids): array {
		if ($uuids === []) {
			return [];
		}

		$secret = $this->appConfig->getValueString(Application::APP_ID, 'ws_admin_secret', '');
		if ($secret === '') {
			// No secret = no admin server is running — quiet, expected during
			// the install-but-not-yet-configured phase.
			return [];
		}

		$host = $this->appConfig->getValueString(Application::APP_ID, 'ws_admin_host');
		$port = $this->appConfig->getValueInt(Application::APP_ID, 'ws_admin_port');

		$query = 'uuids=' . implode(',', $uuids);
		$path = '/admin/rooms/presence';
		$requestTarget = $path . '?' . $query;
		$nowMs = (int)(microtime(true) * 1000);
		$canonical = "GET\n" . $requestTarget . "\n" . $nowMs;
		$sig = hash_hmac('sha256', $canonical, $secret);
		$header = 't=' . $nowMs . ',sig=' . $sig;

		$url = 'http://' . $host . ':' . $port . $path;

		try {
			$response = $this->clientService->newClient()->get($url, [
				'query' => ['uuids' => implode(',', $uuids)],
				'headers' => [
					'X-PBSync-Admin' => $header,
					'Accept' => 'application/json',
				],
				'timeout' => self::DEFAULT_TIMEOUT_SECONDS,
				'connect_timeout' => self::DEFAULT_TIMEOUT_SECONDS,
				'nextcloud' => ['allow_local_address' => true],
			]);
		} catch (Throwable $e) {
			$this->logger->warning('PresenceClient request failed', ['exception' => $e]);
			return [];
		}

		if ($response->getStatusCode() !== 200) {
			$this->logger->warning('PresenceClient got non-200 from admin endpoint', [
				'status' => $response->getStatusCode(),
			]);
			return [];
		}

		$body = (string)$response->getBody();
		$decoded = json_decode($body, true);
		if (!is_array($decoded) || !isset($decoded['rooms']) || !is_array($decoded['rooms'])) {
			$this->logger->warning('PresenceClient got malformed body from admin endpoint');
			return [];
		}

		$out = [];
		foreach ($decoded['rooms'] as $uuid => $payload) {
			if (!is_string($uuid) || !is_array($payload)) {
				continue;
			}
			$dto = RoomLiveState::fromArray($payload);
			if ($dto !== null) {
				$out[$uuid] = $dto;
			}
		}
		return $out;
	}
}
