<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\Service;

use OCA\PlaybackSync\AppInfo\Application;
use OCP\Http\Client\IClientService;
use OCP\IAppConfig;
use Psr\Log\LoggerInterface;
use Throwable;

/**
 * Loopback HTTP client for the daemon's event-stream endpoints.
 *
 * Sibling of `AdminKickClient` — same HMAC scheme (`hash_hmac('sha256', "{METHOD}\n{requestTarget}\n{nowMs}", secret)`),
 * same config keys (`ws_admin_secret`, `ws_admin_host`, `ws_admin_port`).
 *
 * Streaming uses libcurl directly because the controller wants byte-level
 * control over `WRITEFUNCTION` so it can echo + flush each chunk straight to
 * the browser without re-buffering, and abort the upstream by returning a
 * short write count when the client disconnects.
 */
class AdminEventClient {

	public const CONNECT_TIMEOUT_SECONDS = 5;
	public const RECORD_TIMEOUT_SECONDS = 0.2;

	public function __construct(
		private readonly IClientService $clientService,
		private readonly IAppConfig $appConfig,
		private readonly LoggerInterface $logger,
	) {
	}

	/**
	 * Best-effort fire-and-forget POST to `/admin/events`. The daemon assigns
	 * `ts` + `id` and routes the envelope to the right ring (per-room when
	 * `$roomUuid` matches a live runtime, otherwise the cross-room global ring).
	 *
	 * Transport errors are SWALLOWED — an event-log write must never fail a
	 * user-facing request — and surface only as warning-level log entries. The
	 * 200ms timeout mirrors `AdminKickClient` so a wedged daemon can't pin a
	 * PHP-FPM worker on event-emission.
	 *
	 * @param string               $type      Envelope type (`room_created`, `settings_updated`, …).
	 * @param string               $category  One of `playback|presence|lifecycle|admin`.
	 * @param string               $actor     One of `client|owner|admin|system`.
	 * @param string|null          $actorId   Identifier for the actor (userId for admin/owner, null for system).
	 * @param string|null          $roomUuid  Target room, or null for non-room admin events.
	 * @param array<string, mixed> $data      Type-specific payload.
	 */
	public function record(
		string $type,
		string $category,
		string $actor,
		?string $actorId,
		?string $roomUuid,
		array $data = [],
	): void {
		$secret = $this->appConfig->getValueString(Application::APP_ID, 'ws_admin_secret', '');
		if ($secret === '') {
			$this->logger->warning('AdminEventClient::record skipped — ws_admin_secret is not configured');
			return;
		}

		$host = $this->appConfig->getValueString(Application::APP_ID, 'ws_admin_host');
		$port = $this->appConfig->getValueInt(Application::APP_ID, 'ws_admin_port');

		$path = '/admin/events';
		$nowMs = (int)(microtime(true) * 1000);
		$canonical = "POST\n" . $path . "\n" . $nowMs;
		$sig = hash_hmac('sha256', $canonical, $secret);
		$header = 't=' . $nowMs . ',sig=' . $sig;

		$payload = [
			'type' => $type,
			'category' => $category,
			'actor' => $actor,
			'actorId' => $actorId,
			'roomUuid' => $roomUuid,
			'data' => $data,
		];
		$body = json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
		if ($body === false) {
			$this->logger->warning('AdminEventClient::record failed to encode payload');
			return;
		}

		$url = 'http://' . $host . ':' . $port . $path;

		try {
			$this->clientService->newClient()->post($url, [
				'headers' => [
					'X-PBSync-Admin' => $header,
					'Content-Type' => 'application/json',
					'Accept' => 'application/json',
					'Content-Length' => (string)strlen($body),
				],
				'body' => $body,
				'timeout' => self::RECORD_TIMEOUT_SECONDS,
				'connect_timeout' => self::RECORD_TIMEOUT_SECONDS,
				'nextcloud' => ['allow_local_address' => true],
				'http_errors' => false,
			]);
		} catch (Throwable $e) {
			$this->logger->warning('AdminEventClient::record transport error', ['exception' => $e]);
		}
	}

	/**
	 * Open a streaming GET to `/admin/rooms/{uuid}/events/stream` and invoke
	 * `$onChunk($bytes)` for every chunk received. The callback should return
	 * the number of bytes it consumed; returning anything else causes libcurl
	 * to abort the transfer — that's how the controller propagates a client
	 * disconnect upstream.
	 *
	 * Blocks until the upstream closes or the callback aborts.
	 *
	 * @param callable(string): int $onChunk
	 */
	public function streamRoom(string $roomUuid, ?int $lastEventId, callable $onChunk): void {
		$secret = $this->appConfig->getValueString(Application::APP_ID, 'ws_admin_secret', '');
		if ($secret === '') {
			$this->logger->warning('AdminEventClient: ws_admin_secret is not configured');
			return;
		}

		$host = $this->appConfig->getValueString(Application::APP_ID, 'ws_admin_host');
		$port = $this->appConfig->getValueInt(Application::APP_ID, 'ws_admin_port');

		$path = '/admin/rooms/' . rawurlencode($roomUuid) . '/events/stream';
		$query = $lastEventId !== null ? '?lastEventId=' . $lastEventId : '';
		// The daemon's HMAC canonical uses `getRequestTarget()` (path-with-query),
		// so we must match that exactly here — every byte the server sees.
		$requestTarget = $path . $query;

		$nowMs = (int)(microtime(true) * 1000);
		$canonical = "GET\n" . $requestTarget . "\n" . $nowMs;
		$sig = hash_hmac('sha256', $canonical, $secret);
		$header = 't=' . $nowMs . ',sig=' . $sig;

		$url = 'http://' . $host . ':' . $port . $requestTarget;

		$ch = curl_init($url);
		if ($ch === false) {
			$this->logger->warning('AdminEventClient: curl_init failed');
			return;
		}

		curl_setopt_array($ch, [
			CURLOPT_HTTPHEADER => [
				'X-PBSync-Admin: ' . $header,
				'Accept: text/event-stream',
				'Cache-Control: no-store',
			],
			CURLOPT_RETURNTRANSFER => false,
			CURLOPT_HEADER => false,
			CURLOPT_CONNECTTIMEOUT => self::CONNECT_TIMEOUT_SECONDS,
			// No total timeout — SSE streams are long-lived by definition.
			CURLOPT_TIMEOUT => 0,
			CURLOPT_FAILONERROR => false,
			CURLOPT_WRITEFUNCTION => static function ($ch, string $chunk) use ($onChunk): int {
				return $onChunk($chunk);
			},
		]);

		curl_exec($ch);
		$errno = curl_errno($ch);
		if ($errno !== 0 && $errno !== CURLE_WRITE_ERROR && $errno !== CURLE_ABORTED_BY_CALLBACK) {
			$this->logger->warning('AdminEventClient: curl error during stream', [
				'errno' => $errno,
				'error' => curl_error($ch),
			]);
		}
		curl_close($ch);
	}

	/**
	 * Open a streaming GET to `/admin/events/stream` (the cross-room admin
	 * feed) and invoke `$onChunk($bytes)` for each chunk received. Same
	 * contract as `streamRoom` — return short to abort the upstream.
	 *
	 * @param callable(string): int $onChunk
	 */
	public function streamGlobal(?int $lastEventId, callable $onChunk): void {
		$secret = $this->appConfig->getValueString(Application::APP_ID, 'ws_admin_secret', '');
		if ($secret === '') {
			$this->logger->warning('AdminEventClient: ws_admin_secret is not configured');
			return;
		}

		$host = $this->appConfig->getValueString(Application::APP_ID, 'ws_admin_host');
		$port = $this->appConfig->getValueInt(Application::APP_ID, 'ws_admin_port');

		$path = '/admin/events/stream';
		$query = $lastEventId !== null ? '?lastEventId=' . $lastEventId : '';
		$requestTarget = $path . $query;

		$nowMs = (int)(microtime(true) * 1000);
		$canonical = "GET\n" . $requestTarget . "\n" . $nowMs;
		$sig = hash_hmac('sha256', $canonical, $secret);
		$header = 't=' . $nowMs . ',sig=' . $sig;

		$url = 'http://' . $host . ':' . $port . $requestTarget;

		$ch = curl_init($url);
		if ($ch === false) {
			$this->logger->warning('AdminEventClient: curl_init failed');
			return;
		}

		curl_setopt_array($ch, [
			CURLOPT_HTTPHEADER => [
				'X-PBSync-Admin: ' . $header,
				'Accept: text/event-stream',
				'Cache-Control: no-store',
			],
			CURLOPT_RETURNTRANSFER => false,
			CURLOPT_HEADER => false,
			CURLOPT_CONNECTTIMEOUT => self::CONNECT_TIMEOUT_SECONDS,
			CURLOPT_TIMEOUT => 0,
			CURLOPT_FAILONERROR => false,
			CURLOPT_WRITEFUNCTION => static function ($ch, string $chunk) use ($onChunk): int {
				return $onChunk($chunk);
			},
		]);

		curl_exec($ch);
		$errno = curl_errno($ch);
		if ($errno !== 0 && $errno !== CURLE_WRITE_ERROR && $errno !== CURLE_ABORTED_BY_CALLBACK) {
			$this->logger->warning('AdminEventClient: curl error during global stream', [
				'errno' => $errno,
				'error' => curl_error($ch),
			]);
		}
		curl_close($ch);
	}
}
