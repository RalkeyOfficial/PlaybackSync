<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\Tests\Unit\WebSocket;

use OCA\PlaybackSync\WebSocket\ClientConnection;
use OCA\PlaybackSync\WebSocket\RateLimiter;
use PHPUnit\Framework\TestCase;
use Ratchet\ConnectionInterface;

class ClientConnectionTest extends TestCase {

	private function makeClient(?ConnectionInterface $conn, int $nowMs = 1000): ClientConnection {
		return new ClientConnection(
			'client-id',
			$conn,
			$nowMs,
			0,
			new RateLimiter(10, $nowMs),
		);
	}

	public function testTombstoneClearsConnectionAndSetsDeadline(): void {
		$client = $this->makeClient($this->createMock(ConnectionInterface::class));
		$client->tombstone(5000);
		$this->assertNull($client->conn);
		$this->assertSame(5000, $client->tombstonedUntilMs);
	}

	public function testIsTombstonedDuringWindow(): void {
		$client = $this->makeClient(null);
		$client->tombstone(10_000);
		$this->assertTrue($client->isTombstoned(5000));
		$this->assertFalse($client->isTombstoned(10_000));
		$this->assertFalse($client->isTombstoned(20_000));
	}

	public function testIsExpiredTombstoneOnceWindowPassed(): void {
		$client = $this->makeClient(null);
		$client->tombstone(10_000);
		$this->assertFalse($client->isExpiredTombstone(5000));
		$this->assertTrue($client->isExpiredTombstone(10_000));
	}

	public function testReattachRestoresConnectionAndClearsTombstone(): void {
		$client = $this->makeClient(null);
		$client->tombstone(10_000);
		$replacement = $this->createMock(ConnectionInterface::class);
		$client->reattach($replacement, 6000);
		$this->assertSame($replacement, $client->conn);
		$this->assertNull($client->tombstonedUntilMs);
		$this->assertSame(6000, $client->lastSeenMs);
	}

	public function testIsIdleOnlyWhenConnectedAndQuiet(): void {
		$client = $this->makeClient($this->createMock(ConnectionInterface::class), nowMs: 1000);
		$this->assertFalse($client->isIdle(2000, 30_000));
		$client->markSeen(1500);
		$this->assertFalse($client->isIdle(31_499, 30_000));
		$this->assertTrue($client->isIdle(31_500, 30_000));
	}
}
