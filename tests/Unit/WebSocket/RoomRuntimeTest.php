<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\Tests\Unit\WebSocket;

use OCA\PlaybackSync\WebSocket\ClientConnection;
use OCA\PlaybackSync\WebSocket\RateLimiter;
use OCA\PlaybackSync\WebSocket\RoomRuntime;
use PHPUnit\Framework\TestCase;
use Ratchet\ConnectionInterface;

class RoomRuntimeTest extends TestCase {

	private function makeClient(string $clientId, ?ConnectionInterface $conn, int $nowMs = 0, int $lastEventId = 0): ClientConnection {
		return new ClientConnection(
			$clientId,
			$conn,
			$nowMs,
			$lastEventId,
			new RateLimiter(10, $nowMs),
		);
	}

	public function testIsExpiredFiresWhenExpiresAtPassed(): void {
		$room = new RoomRuntime('uuid-1', expiresAtMs: 1000);
		$this->assertFalse($room->isExpired(999));
		$this->assertTrue($room->isExpired(1000));
		$this->assertTrue($room->isExpired(2000));
	}

	public function testAddAndRemoveClient(): void {
		$room = new RoomRuntime('uuid-1', expiresAtMs: 9_999_999);
		$conn = $this->createMock(ConnectionInterface::class);
		$room->addClient($this->makeClient('c1', $conn));
		$this->assertSame(1, $room->clientCount());
		$this->assertNotNull($room->getClient('c1'));
		$room->removeClient('c1');
		$this->assertSame(0, $room->clientCount());
		$this->assertNull($room->getClient('c1'));
	}

	public function testEventLogRingBufferDropsOldest(): void {
		$room = new RoomRuntime('uuid-1', expiresAtMs: 9_999_999, eventLogSize: 3);
		for ($i = 1; $i <= 5; $i++) {
			$room->pushEvent('seek', $i * 10, 'c1', $i * 100, $i);
		}
		// Expect only events 3, 4, 5 to remain.
		$tail = $room->recentEventsSince(0);
		$this->assertCount(3, $tail);
		$this->assertSame(3, $tail[0]['eventId']);
		$this->assertSame(5, $tail[2]['eventId']);
	}

	public function testRecentEventsSinceFiltersByEventId(): void {
		$room = new RoomRuntime('uuid-1', expiresAtMs: 9_999_999);
		$room->pushEvent('play', null, 'c1', 100, 1);
		$room->pushEvent('seek', 30.0, 'c1', 200, 2);
		$room->pushEvent('pause', null, 'c2', 300, 3);

		$tail = $room->recentEventsSince(1);
		$this->assertCount(2, $tail);
		$this->assertSame(2, $tail[0]['eventId']);
		$this->assertSame(3, $tail[1]['eventId']);

		$this->assertSame([], $room->recentEventsSince(99));
	}

	public function testActiveConnectionsExcludesTombstonedAndCallerSelf(): void {
		$room = new RoomRuntime('uuid-1', expiresAtMs: 9_999_999);
		$connA = $this->createMock(ConnectionInterface::class);
		$connB = $this->createMock(ConnectionInterface::class);
		$room->addClient($this->makeClient('a', $connA));
		$room->addClient($this->makeClient('b', $connB));
		$tombstoned = $this->makeClient('c', null);
		$tombstoned->tombstone(99_999);
		$room->addClient($tombstoned);

		$broadcast = $room->activeConnectionsExcept('a');
		$this->assertCount(1, $broadcast);
		$this->assertSame($connB, $broadcast[0]);
	}

	public function testPruneExpiredTombstonesDropsOnlyTheExpiredOnes(): void {
		$room = new RoomRuntime('uuid-1', expiresAtMs: 9_999_999);
		$alive = $this->makeClient('alive', $this->createMock(ConnectionInterface::class));
		$fresh = $this->makeClient('fresh', null);
		$fresh->tombstone(5000);
		$stale = $this->makeClient('stale', null);
		$stale->tombstone(1000);

		$room->addClient($alive);
		$room->addClient($fresh);
		$room->addClient($stale);

		$dropped = $room->pruneExpiredTombstones(2000);
		$this->assertSame(['stale'], $dropped);
		$this->assertNotNull($room->getClient('alive'));
		$this->assertNotNull($room->getClient('fresh'));
		$this->assertNull($room->getClient('stale'));
	}

	public function testFindIdleClientsIgnoresTombstoned(): void {
		$room = new RoomRuntime('uuid-1', expiresAtMs: 9_999_999);
		$active = $this->makeClient('active', $this->createMock(ConnectionInterface::class), nowMs: 5_000);
		$idle = $this->makeClient('idle', $this->createMock(ConnectionInterface::class), nowMs: 0);
		$ghost = $this->makeClient('ghost', null);
		$ghost->tombstone(99_999);

		$room->addClient($active);
		$room->addClient($idle);
		$room->addClient($ghost);

		$found = $room->findIdleClients(nowMs: 31_000, idleMs: 30_000);
		$this->assertCount(1, $found);
		$this->assertSame('idle', $found[0]->clientId);
	}
}
