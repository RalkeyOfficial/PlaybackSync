<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\Tests\Unit\WebSocket;

use OCA\PlaybackSync\WebSocket\ClientConnection;
use OCA\PlaybackSync\WebSocket\MessageEncoder;
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

	public function testPushEnvelopePreservesPlaybackEventIdAtTopLevelForReconnectReplay(): void {
		$room = new RoomRuntime('uuid-1', expiresAtMs: 9_999_999);
		$room->pushEnvelope([
			'ts' => 100,
			'type' => 'seek',
			'category' => 'playback',
			'actor' => 'owner',
			'actorId' => 'alice',
			'data' => ['value' => 42.0],
			'playbackEventId' => 7,
		]);

		// `recentEventsSince` reads `playbackEventId` from the envelope's top
		// level — the legacy adapter contract that client reconnect-replay
		// depends on. The owner's userId becomes the legacy `clientId`.
		$tail = $room->recentEventsSince(0);
		$this->assertCount(1, $tail);
		$this->assertSame(7, $tail[0]['eventId']);
		$this->assertSame('seek', $tail[0]['type']);
		$this->assertSame(42.0, $tail[0]['value']);
		$this->assertSame('alice', $tail[0]['clientId']);
	}

	public function testEnvelopesSinceReturnsFullEnvelopeShape(): void {
		$registry = new \OCA\PlaybackSync\WebSocket\RoomRegistry(eventLogSize: 50);
		$room = $registry->getOrCreate('uuid-1', expiresAtMs: 9_999_999);
		$room->pushEnvelope([
			'ts' => 555,
			'type' => 'client_joined',
			'category' => 'presence',
			'actor' => 'client',
			'actorId' => 'c1',
			'data' => ['clientId' => 'c1'],
		]);

		$out = $room->envelopesSince(0);
		$this->assertCount(1, $out);
		$this->assertSame('presence', $out[0]['category']);
		$this->assertSame('client_joined', $out[0]['type']);
		$this->assertSame('uuid-1', $out[0]['roomUuid']);
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

	public function testKickClientReturnsFalseForUnknownId(): void {
		$room = new RoomRuntime('uuid-1', expiresAtMs: 9_999_999);
		$this->assertFalse($room->kickClient('nope', new MessageEncoder(), blockMs: 30_000, nowMs: 1000));
	}

	public function testKickClientSendsErrorClosesAndRecordsBlock(): void {
		$room = new RoomRuntime('uuid-1', expiresAtMs: 9_999_999);
		$conn = $this->createMock(ConnectionInterface::class);
		$conn->expects($this->once())
			->method('send')
			->with($this->callback(static function (string $payload): bool {
				$decoded = json_decode($payload, true);
				return is_array($decoded)
					&& ($decoded['type'] ?? null) === 'ERROR'
					&& ($decoded['code'] ?? null) === 'KICKED';
			}));
		$conn->expects($this->once())->method('close');

		$room->addClient($this->makeClient('victim', $conn));

		$kicked = $room->kickClient('victim', new MessageEncoder(), blockMs: 30_000, nowMs: 1000);

		$this->assertTrue($kicked);
		$this->assertNull($room->getClient('victim'));
		$this->assertTrue($room->isClientBlocked('victim', 1000));
		$this->assertTrue($room->isClientBlocked('victim', 30_999));
		$this->assertFalse($room->isClientBlocked('victim', 31_000));
	}

	public function testKickClientStillBlocksWhenConnectionAlreadyDropped(): void {
		// Tombstoned client (conn=null) — kick should still record a block
		// so a same-id reconnect during the window is rejected.
		$room = new RoomRuntime('uuid-1', expiresAtMs: 9_999_999);
		$ghost = $this->makeClient('ghost', null);
		$ghost->tombstone(50_000);
		$room->addClient($ghost);

		$kicked = $room->kickClient('ghost', new MessageEncoder(), blockMs: 30_000, nowMs: 1000);

		$this->assertTrue($kicked);
		$this->assertTrue($room->isClientBlocked('ghost', 1000));
	}

	public function testPruneExpiredKickBlocksDropsOnlyTheExpiredOnes(): void {
		$room = new RoomRuntime('uuid-1', expiresAtMs: 9_999_999);
		$encoder = new MessageEncoder();

		$room->addClient($this->makeClient('a', $this->createMock(ConnectionInterface::class)));
		$room->addClient($this->makeClient('b', $this->createMock(ConnectionInterface::class)));
		$room->kickClient('a', $encoder, blockMs: 1000, nowMs: 0);
		$room->kickClient('b', $encoder, blockMs: 5000, nowMs: 0);

		$room->pruneExpiredKickBlocks(2000);

		$this->assertFalse($room->isClientBlocked('a', 2000));
		$this->assertTrue($room->isClientBlocked('b', 2000));
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
