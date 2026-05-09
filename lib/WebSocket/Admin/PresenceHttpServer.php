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
 * One route in v1: `GET /admin/rooms/presence?uuids=<csv>`. Every other path
 * returns 404. Authentication runs first and a missing/invalid HMAC closes
 * the connection with 401 — no body — to make probing cheap to the operator
 * and uninteresting to an attacker.
 *
 * Connections are short-lived (one request, one response, then close) — same
 * model as the surrounding `Ratchet\Http\HttpServer` decorator expects.
 */
class PresenceHttpServer implements HttpServerInterface {

	public const ROUTE = '/admin/rooms/presence';

	public function __construct(
		private readonly AdminAuthMiddleware $auth,
		private readonly PresenceController $controller,
		private readonly LoggerInterface $logger,
	) {
	}

	public function onOpen(ConnectionInterface $conn, ?RequestInterface $request = null): void {
		if ($request === null) {
			$this->respond($conn, 400, ['error' => 'missing_request']);
			return;
		}

		try {
			$nowMs = (int)(microtime(true) * 1000);
			if (!$this->auth->verify($request, $nowMs)) {
				$this->respond($conn, 401, ['error' => 'unauthorized']);
				return;
			}

			if ($request->getMethod() !== 'GET') {
				$this->respond($conn, 405, ['error' => 'method_not_allowed']);
				return;
			}

			$path = $request->getUri()->getPath();
			if ($path !== self::ROUTE) {
				$this->respond($conn, 404, ['error' => 'not_found']);
				return;
			}

			$uuids = $this->parseUuids($request);
			$presence = $this->controller->presenceFor($uuids);
			// Cast to object so an empty map serializes as `{}` not `[]`.
			$this->respond($conn, 200, ['rooms' => (object)$presence]);
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
