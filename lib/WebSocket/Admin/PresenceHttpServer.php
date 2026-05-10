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

	private const KICK_PATTERN = '#^/admin/rooms/(?P<uuid>[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/clients/(?P<clientId>[0-9a-f]{1,64})/disconnect$#';

	private ?HealthController $healthController = null;

	public function __construct(
		private readonly AdminAuthMiddleware $auth,
		private readonly PresenceController $controller,
		private readonly KickController $kickController,
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
				$result = $this->kickController->kick($m['uuid'], $m['clientId'], $nowMs);
				match ($result) {
					KickController::RESULT_KICKED => $this->respond($conn, 200, ['result' => 'kicked']),
					KickController::RESULT_ROOM_NOT_FOUND => $this->respond($conn, 404, ['error' => 'room_not_found']),
					KickController::RESULT_CLIENT_NOT_FOUND => $this->respond($conn, 404, ['error' => 'client_not_found']),
				};
				return;
			}

			// Path didn't match any known route. If it looks like a kick path
			// but with the wrong method, signal that explicitly.
			if (preg_match(self::KICK_PATTERN, strtolower($path)) === 1 || $path === self::ROUTE) {
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
