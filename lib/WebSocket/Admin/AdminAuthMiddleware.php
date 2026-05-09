<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\WebSocket\Admin;

use Psr\Http\Message\RequestInterface;

/**
 * Validates the `X-PBSync-Admin: t=<unix-ms>,sig=<hex>` header on requests
 * to the daemon's loopback admin endpoints.
 *
 * The signature is `hmac_sha256(secret, "{method}\n{requestTarget}\n{t}")`.
 * `requestTarget` is the path-with-query as it appeared on the wire — that
 * way an attacker can't tamper with `?uuids=...` without invalidating the
 * sig. `t` is unix milliseconds; requests outside `replayWindowMs` of the
 * server's clock are rejected, capping replay risk.
 *
 * Stateless and non-blocking — safe to call inside the React event loop.
 */
class AdminAuthMiddleware {

	public const HEADER = 'X-PBSync-Admin';

	public function __construct(
		private readonly string $secret,
		private readonly int $replayWindowMs = 30_000,
	) {
	}

	/**
	 * @return bool true if the request carries a valid HMAC; false otherwise.
	 *              The reason for failure is intentionally not surfaced — the
	 *              endpoint just returns 401 either way.
	 */
	public function verify(RequestInterface $request, int $nowMs): bool {
		if ($this->secret === '') {
			return false;
		}

		$header = $request->getHeaderLine(self::HEADER);
		if ($header === '') {
			return false;
		}

		$parts = $this->parseHeader($header);
		if ($parts === null) {
			return false;
		}
		[$ts, $providedSig] = $parts;

		if (abs($nowMs - $ts) > $this->replayWindowMs) {
			return false;
		}

		$canonical = $request->getMethod() . "\n" . $request->getRequestTarget() . "\n" . $ts;
		$expected = hash_hmac('sha256', $canonical, $this->secret);

		return hash_equals($expected, $providedSig);
	}

	/**
	 * @return array{0: int, 1: string}|null `[timestamp, signature]` or null on
	 *                                       any parse failure.
	 */
	private function parseHeader(string $header): ?array {
		$ts = null;
		$sig = null;
		foreach (explode(',', $header) as $segment) {
			$kv = explode('=', trim($segment), 2);
			if (count($kv) !== 2) {
				continue;
			}
			[$k, $v] = $kv;
			$k = trim($k);
			$v = trim($v);
			if ($k === 't' && ctype_digit($v)) {
				$ts = (int)$v;
			} elseif ($k === 'sig' && ctype_xdigit($v) && strlen($v) === 64) {
				$sig = strtolower($v);
			}
		}
		if ($ts === null || $sig === null) {
			return null;
		}
		return [$ts, $sig];
	}
}
