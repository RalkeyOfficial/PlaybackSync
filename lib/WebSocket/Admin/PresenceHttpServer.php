<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\WebSocket\Admin;

use GuzzleHttp\Psr7\Message;
use GuzzleHttp\Psr7\Response;
use Psr\Http\Message\RequestInterface;
use Psr\Log\LoggerInterface;
use Ratchet\ConnectionInterface;
use Ratchet\Http\HttpServerInterface;
use Throwable;

/**
 * Ratchet HTTP entry point bound to the daemon's loopback admin port.
 *
 * Routes:
 *   - `GET  /healthz` — daemon liveness + light stats. **Unauthenticated**:
 *     loopback-bound, no sensitive data in the response. Single-path carve-out
 *     evaluated *before* the HMAC check.
 *   - `GET  /admin/rooms/presence?uuids=<csv>` — point-in-time presence map.
 *   - `POST /admin/rooms/{uuid}/clients/{clientId}/disconnect` — owner kick.
 *   - `POST /admin/rooms/{uuid}/playback` — owner-driven play/pause/seek/reset.
 *
 * Every other path returns 404. Authentication runs first (except for
 * `/healthz`) and a missing/invalid HMAC closes the connection with 401 — no
 * body — to make probing cheap to the operator and uninteresting to an
 * attacker.
 *
 * Connections are short-lived (one request, one response, then close) — same
 * model as the surrounding `Ratchet\Http\HttpServer` decorator expects.
 */
class PresenceHttpServer implements HttpServerInterface {

	public const ROUTE = '/admin/rooms/presence';
	public const HEALTH_ROUTE = '/healthz';
	public const GLOBAL_EVENTS_STREAM_ROUTE = '/admin/events/stream';
	public const EVENTS_INGEST_ROUTE = '/admin/events';

	private const KICK_PATTERN = '#^/admin/rooms/(?P<uuid>[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/clients/(?P<clientId>[0-9a-f]{1,64})/disconnect$#';
	private const PLAYBACK_PATTERN = '#^/admin/rooms/(?P<uuid>[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/playback$#';
	private const BROADCAST_PATTERN = '#^/admin/rooms/(?P<uuid>[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/broadcast$#';
	private const EVENTS_STREAM_PATTERN = '#^/admin/rooms/(?P<uuid>[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/events/stream$#';
	private const DESTROY_PATTERN = '#^/admin/rooms/(?P<uuid>[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/destroy$#';

	private ?HealthController $healthController = null;

	public function __construct(
		private readonly AdminAuthMiddleware $auth,
		private readonly PresenceController $controller,
		private readonly KickController $kickController,
		private readonly PlaybackController $playbackController,
		private readonly RoomBroadcastController $broadcastController,
		private readonly EventStreamController $eventStreamController,
		private readonly EventIngestController $eventIngestController,
		private readonly RoomDestroyController $destroyController,
		private readonly LoggerInterface $logger,
	) {
	}

	/**
	 * Wire the healthcheck handler. Done via setter (rather than constructor
	 * injection) so `WsServe::execute()` can supply a `HealthController` built
	 * with the daemon's actual `startedAtMs` instead of whatever wall-clock
	 * the container happened to resolve at.
	 */
	public function setHealthController(HealthController $healthController): void {
		$this->healthController = $healthController;
	}

	public function onOpen(ConnectionInterface $conn, ?RequestInterface $request = null): void {
		if ($request === null) {
			$this->respond($conn, 400, ['error' => 'missing_request']);
			return;
		}

		try {
			$nowMs = (int)(microtime(true) * 1000);
			$method = $request->getMethod();
			$path = $request->getUri()->getPath();

			// /healthz is the one path that bypasses HMAC. Match it explicitly
			// (not via a general allowlist) so the carve-out is easy to audit.
			if ($path === self::HEALTH_ROUTE) {
				if ($method !== 'GET') {
					$this->respond($conn, 405, ['error' => 'method_not_allowed']);
					return;
				}
				if ($this->healthController === null) {
					// Defensive: the daemon should always wire this before
					// binding the socket. If it's missing, something is wrong
					// with boot order, not with the request.
					$this->respond($conn, 503, ['error' => 'health_unavailable']);
					return;
				}
				$this->respond($conn, 200, $this->healthController->health($nowMs));
				return;
			}

			if (!$this->auth->verify($request, $nowMs)) {
				$this->respond($conn, 401, ['error' => 'unauthorized']);
				return;
			}

			if ($method === 'GET' && $path === self::ROUTE) {
				$uuids = $this->parseUuids($request);
				$presence = $this->controller->presenceFor($uuids);
				// Cast to object so an empty map serializes as `{}` not `[]`.
				$this->respond($conn, 200, ['rooms' => (object)$presence]);
				return;
			}

			if ($method === 'POST' && preg_match(self::KICK_PATTERN, strtolower($path), $m) === 1) {
				$payload = $this->parseJsonBody($request);
				$ownerUserId = is_array($payload) && is_string($payload['userId'] ?? null) ? $payload['userId'] : null;
				$result = $this->kickController->kick($m['uuid'], $m['clientId'], $nowMs, $ownerUserId);
				match ($result) {
					KickController::RESULT_KICKED => $this->respond($conn, 200, ['result' => 'kicked']),
					KickController::RESULT_ROOM_NOT_FOUND => $this->respond($conn, 404, ['error' => 'room_not_found']),
					KickController::RESULT_CLIENT_NOT_FOUND => $this->respond($conn, 404, ['error' => 'client_not_found']),
				};
				return;
			}

			if ($method === 'POST' && preg_match(self::DESTROY_PATTERN, strtolower($path), $m) === 1) {
				$result = $this->destroyController->destroy($m['uuid'], $nowMs);
				match ($result) {
					RoomDestroyController::RESULT_DESTROYED => $this->respond($conn, 200, ['result' => 'destroyed']),
					RoomDestroyController::RESULT_ROOM_NOT_FOUND => $this->respond($conn, 404, ['error' => 'room_not_found']),
				};
				return;
			}

			if ($method === 'GET' && preg_match(self::EVENTS_STREAM_PATTERN, strtolower($path), $m) === 1) {
				$lastEventId = $this->parseLastEventId($request);
				$this->eventStreamController->openRoomStream($conn, $m['uuid'], $lastEventId);
				// Do NOT close — the stream stays open until the client disconnects.
				return;
			}

			if ($method === 'GET' && $path === self::GLOBAL_EVENTS_STREAM_ROUTE) {
				$lastEventId = $this->parseLastEventId($request);
				$this->eventStreamController->openGlobalStream($conn, $lastEventId);
				return;
			}

			if ($method === 'POST' && $path === self::EVENTS_INGEST_ROUTE) {
				$payload = $this->parseJsonBody($request);
				if ($payload === null) {
					$this->respond($conn, 400, ['error' => 'invalid_json']);
					return;
				}
				$result = $this->eventIngestController->apply($payload, $nowMs);
				if ($result['result'] === EventIngestController::RESULT_ACCEPTED) {
					$this->respond($conn, 200, $result);
				} else {
					$this->respond($conn, 400, $result);
				}
				return;
			}

			if ($method === 'POST' && preg_match(self::BROADCAST_PATTERN, strtolower($path), $m) === 1) {
				$payload = $this->parseJsonBody($request);
				if ($payload === null) {
					$this->respond($conn, 400, ['error' => 'invalid_json']);
					return;
				}
				$kind = is_string($payload['kind'] ?? null) ? $payload['kind'] : '';
				$ownerUserId = is_string($payload['userId'] ?? null) ? $payload['userId'] : null;
				$result = $this->broadcastController->broadcast($m['uuid'], $kind, $nowMs, $ownerUserId);
				match ($result) {
					RoomBroadcastController::RESULT_BROADCAST => $this->respond($conn, 200, ['result' => 'broadcast']),
					RoomBroadcastController::RESULT_NO_RUNTIME => $this->respond($conn, 200, ['result' => 'no_runtime']),
					RoomBroadcastController::RESULT_ROOM_NOT_FOUND => $this->respond($conn, 404, ['error' => 'room_not_found']),
					RoomBroadcastController::RESULT_INVALID_KIND => $this->respond($conn, 400, ['error' => 'invalid_kind']),
				};
				return;
			}

			if ($method === 'POST' && preg_match(self::PLAYBACK_PATTERN, strtolower($path), $m) === 1) {
				$payload = $this->parseJsonBody($request);
				if ($payload === null) {
					$this->respond($conn, 400, ['error' => 'invalid_json']);
					return;
				}
				$action = is_string($payload['action'] ?? null) ? $payload['action'] : '';
				$rawPos = $payload['videoPos'] ?? null;
				$videoPos = null;
				if ($rawPos !== null) {
					if (!is_int($rawPos) && !is_float($rawPos)) {
						$this->respond($conn, 400, ['error' => 'invalid_position']);
						return;
					}
					$videoPos = (float)$rawPos;
				}
				$ownerUserId = is_string($payload['userId'] ?? null) ? $payload['userId'] : null;
				$result = $this->playbackController->apply($m['uuid'], $action, $videoPos, $nowMs, $ownerUserId);
				match ($result) {
					PlaybackController::RESULT_APPLIED => $this->respond($conn, 200, ['result' => 'applied']),
					PlaybackController::RESULT_ROOM_NOT_FOUND => $this->respond($conn, 404, ['error' => 'room_not_found']),
					PlaybackController::RESULT_INVALID_ACTION => $this->respond($conn, 400, ['error' => 'invalid_action']),
					PlaybackController::RESULT_INVALID_POSITION => $this->respond($conn, 400, ['error' => 'invalid_position']),
				};
				return;
			}

			// Path didn't match any known route. If it looks like a kick or
			// playback path but with the wrong method, signal that explicitly.
			if (
				preg_match(self::KICK_PATTERN, strtolower($path)) === 1
				|| preg_match(self::PLAYBACK_PATTERN, strtolower($path)) === 1
				|| preg_match(self::BROADCAST_PATTERN, strtolower($path)) === 1
				|| preg_match(self::EVENTS_STREAM_PATTERN, strtolower($path)) === 1
				|| preg_match(self::DESTROY_PATTERN, strtolower($path)) === 1
				|| $path === self::ROUTE
				|| $path === self::GLOBAL_EVENTS_STREAM_ROUTE
				|| $path === self::EVENTS_INGEST_ROUTE
			) {
				$this->respond($conn, 405, ['error' => 'method_not_allowed']);
				return;
			}
			$this->respond($conn, 404, ['error' => 'not_found']);
		} catch (Throwable $e) {
			$this->logger->error('PresenceHttpServer failed to handle request', [
				'exception' => $e,
			]);
			$this->respond($conn, 500, ['error' => 'internal_error']);
		}
	}

	public function onMessage(ConnectionInterface $from, $msg): void {
		// HTTP requests are fully buffered before onOpen fires; any trailing
		// bytes here are unexpected. Drop the connection.
		$from->close();
	}

	public function onClose(ConnectionInterface $conn): void {
		// SSE consumers register subscriber + heartbeat-timer state in the
		// EventStreamController; tear them down on socket close. Other paths
		// close synchronously in respond() so this is a no-op for them.
		$this->eventStreamController->closeStream($conn);
	}

	public function onError(ConnectionInterface $conn, \Exception $e): void {
		$this->logger->warning('PresenceHttpServer connection error', ['exception' => $e]);
		$conn->close();
	}

	/**
	 * @return list<string> Lowercased, syntactically-valid UUIDs only. Bad
	 *                     entries are silently dropped — the daemon doesn't
	 *                     know what's in the DB, the PHP side does.
	 */
	private function parseUuids(RequestInterface $request): array {
		parse_str($request->getUri()->getQuery(), $params);
		$raw = $params['uuids'] ?? '';
		if (!is_string($raw) || $raw === '') {
			return [];
		}
		$pattern = '/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/';
		$out = [];
		foreach (explode(',', $raw) as $candidate) {
			$candidate = strtolower(trim($candidate));
			if (preg_match($pattern, $candidate) === 1) {
				$out[] = $candidate;
			}
		}
		return $out;
	}

	/**
	 * Pull the SSE replay cursor from `Last-Event-ID` header or, as a
	 * fallback for proxies that strip headers, the `?lastEventId=` query.
	 * Returns null when no usable cursor is present.
	 */
	private function parseLastEventId(RequestInterface $request): ?int {
		$header = $request->getHeaderLine('Last-Event-ID');
		if ($header !== '' && ctype_digit($header)) {
			return (int)$header;
		}
		parse_str($request->getUri()->getQuery(), $params);
		$raw = $params['lastEventId'] ?? null;
		if (is_string($raw) && ctype_digit($raw)) {
			return (int)$raw;
		}
		return null;
	}

	/**
	 * Decode the request body as a JSON object. Returns null on any decode
	 * failure or non-object payload — caller maps that to 400.
	 *
	 * @return array<string, mixed>|null
	 */
	private function parseJsonBody(RequestInterface $request): ?array {
		$raw = (string)$request->getBody();
		if ($raw === '') {
			return [];
		}
		try {
			$decoded = json_decode($raw, true, flags: JSON_THROW_ON_ERROR);
		} catch (\JsonException) {
			return null;
		}
		if (!is_array($decoded)) {
			return null;
		}
		return $decoded;
	}

	private function respond(ConnectionInterface $conn, int $status, array $body): void {
		$json = json_encode($body, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
		$response = new Response(
			$status,
			[
				'Content-Type' => 'application/json',
				'Content-Length' => (string)strlen($json),
				'Connection' => 'close',
			],
			$json,
		);
		$conn->send(Message::toString($response));
		$conn->close();
	}
}
