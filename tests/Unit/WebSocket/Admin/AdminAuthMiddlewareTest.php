<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\Tests\Unit\WebSocket\Admin;

use GuzzleHttp\Psr7\Request;
use OCA\PlaybackSync\WebSocket\Admin\AdminAuthMiddleware;
use PHPUnit\Framework\TestCase;

class AdminAuthMiddlewareTest extends TestCase {

	private const SECRET = 'super-secret-32-bytes-of-entropy-aabb';

	public function testAcceptsValidHmac(): void {
		$mw = new AdminAuthMiddleware(self::SECRET);
		$ts = 1_700_000_000_000;
		$header = $this->signedHeader('GET', '/admin/rooms/presence?uuids=abc', $ts, self::SECRET);
		$request = new Request('GET', '/admin/rooms/presence?uuids=abc', [AdminAuthMiddleware::HEADER => $header]);

		$this->assertTrue($mw->verify($request, $ts));
	}

	public function testAcceptsValidHmacWithinReplayWindow(): void {
		$mw = new AdminAuthMiddleware(self::SECRET, replayWindowMs: 30_000);
		$ts = 1_700_000_000_000;
		$header = $this->signedHeader('GET', '/admin/rooms/presence', $ts, self::SECRET);
		$request = new Request('GET', '/admin/rooms/presence', [AdminAuthMiddleware::HEADER => $header]);

		// 25 seconds in the future is still inside the 30s window.
		$this->assertTrue($mw->verify($request, $ts + 25_000));
	}

	public function testRejectsTimestampOutsideReplayWindow(): void {
		$mw = new AdminAuthMiddleware(self::SECRET, replayWindowMs: 30_000);
		$ts = 1_700_000_000_000;
		$header = $this->signedHeader('GET', '/admin/rooms/presence', $ts, self::SECRET);
		$request = new Request('GET', '/admin/rooms/presence', [AdminAuthMiddleware::HEADER => $header]);

		$this->assertFalse($mw->verify($request, $ts + 60_000));
		$this->assertFalse($mw->verify($request, $ts - 60_000));
	}

	public function testRejectsTamperedQueryString(): void {
		$mw = new AdminAuthMiddleware(self::SECRET);
		$ts = 1_700_000_000_000;
		// Sign for one path...
		$header = $this->signedHeader('GET', '/admin/rooms/presence?uuids=alice', $ts, self::SECRET);
		// ...present with another. Must reject.
		$request = new Request('GET', '/admin/rooms/presence?uuids=bob', [AdminAuthMiddleware::HEADER => $header]);

		$this->assertFalse($mw->verify($request, $ts));
	}

	public function testRejectsBadSignature(): void {
		$mw = new AdminAuthMiddleware(self::SECRET);
		$ts = 1_700_000_000_000;
		$header = 't=' . $ts . ',sig=' . str_repeat('0', 64);
		$request = new Request('GET', '/admin/rooms/presence', [AdminAuthMiddleware::HEADER => $header]);

		$this->assertFalse($mw->verify($request, $ts));
	}

	public function testRejectsMissingHeader(): void {
		$mw = new AdminAuthMiddleware(self::SECRET);
		$request = new Request('GET', '/admin/rooms/presence');

		$this->assertFalse($mw->verify($request, 1_700_000_000_000));
	}

	public function testRejectsMalformedHeader(): void {
		$mw = new AdminAuthMiddleware(self::SECRET);
		$request = new Request('GET', '/admin/rooms/presence', [AdminAuthMiddleware::HEADER => 'garbage']);

		$this->assertFalse($mw->verify($request, 1_700_000_000_000));
	}

	public function testRejectsEverythingWhenSecretIsEmpty(): void {
		$mw = new AdminAuthMiddleware('');
		$ts = 1_700_000_000_000;
		// Even a "valid" signature against the empty secret must fail.
		$header = $this->signedHeader('GET', '/admin/rooms/presence', $ts, '');
		$request = new Request('GET', '/admin/rooms/presence', [AdminAuthMiddleware::HEADER => $header]);

		$this->assertFalse($mw->verify($request, $ts));
	}

	public function testSignatureHexIsCaseInsensitive(): void {
		$mw = new AdminAuthMiddleware(self::SECRET);
		$ts = 1_700_000_000_000;
		$canonical = "GET\n/admin/rooms/presence\n" . $ts;
		$sigUpper = strtoupper(hash_hmac('sha256', $canonical, self::SECRET));
		$request = new Request('GET', '/admin/rooms/presence', [
			AdminAuthMiddleware::HEADER => 't=' . $ts . ',sig=' . $sigUpper,
		]);
		$this->assertTrue($mw->verify($request, $ts));
	}

	private function signedHeader(string $method, string $target, int $ts, string $secret): string {
		$canonical = $method . "\n" . $target . "\n" . $ts;
		$sig = hash_hmac('sha256', $canonical, $secret);
		return 't=' . $ts . ',sig=' . $sig;
	}
}
