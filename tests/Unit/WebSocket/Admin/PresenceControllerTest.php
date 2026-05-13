<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\Tests\Unit\WebSocket\Admin;

use OCA\PlaybackSync\WebSocket\Admin\PresenceController;
use OCA\PlaybackSync\WebSocket\ClientConnection;
use OCA\PlaybackSync\WebSocket\ContentIdentity;
use OCA\PlaybackSync\WebSocket\PlaybackState;
use OCA\PlaybackSync\WebSocket\RateLimiter;
use OCA\PlaybackSync\WebSocket\RoomRegistry;
use OCA\PlaybackSync\WebSocket\RoomRuntime;
use PHPUnit\Framework\TestCase;
use Ratchet\ConnectionInterface;

class PresenceControllerTest extends TestCase {

	public function testReturnsEmptyMapWhenNoUuidsRequested(): void {
		$registry = new RoomRegistry(eventLogSize: 200);
		$controller = new PresenceController($registry);

		$this->assertSame([], $controller->presenceFor([]));
	}

	public function testSkipsUnknownRooms(): void {
		$registry = new RoomRegistry(eventLogSize: 200);
		$controller = new PresenceController($registry);

		$this->assertSame([], $controller->presenceFor(['11111111-1111-1111-1111-111111111111']));
	}

	public function testSerializesActiveClientsAndPlaybackState(): void {
		$registry = new RoomRegistry(eventLogSize: 200);
		$controller = new PresenceController($registry);
		$uuid = '22222222-2222-2222-2222-222222222222';
		$runtime = $registry->getOrCreate($uuid, expiresAtMs: 9_999_999_999_999);

		// Two live clients + one tombstoned (must be filtered out).
		$runtime->addClient($this->makeClient('alice', nowMs: 1_700_000_001_000, conn: $this->fakeConn()));
		$runtime->addClient($this->makeClient('bob', nowMs: 1_700_000_002_500, conn: $this->fakeConn()));
		$ghost = $this->makeClient('ghost', nowMs: 1_700_000_000_000, conn: $this->fakeConn());
		$ghost->tombstone(1_700_000_005_000);
		$runtime->addClient($ghost);

		$runtime->state->applyPlay(1_700_000_000_000);

		$result = $controller->presenceFor([$uuid]);
		$this->assertArrayHasKey($uuid, $result);
		$entry = $result[$uuid];

		$this->assertSame(2, $entry['connectedCount'], 'tombstoned client must not be counted');
		$this->assertCount(2, $entry['clients']);
		$ids = array_column($entry['clients'], 'clientId');
		$this->assertContains('alice', $ids);
		$this->assertContains('bob', $ids);
		$this->assertNotContains('ghost', $ids);

		$this->assertSame(PlaybackState::PLAYING, $entry['playerState']);
		$this->assertIsFloat($entry['videoPos']);
		$this->assertNull($entry['contentIdentity']);
		$this->assertSame(1_700_000_002_500, $entry['lastActivityMs']);
	}

	public function testSerializesContentIdentityWhenSet(): void {
		$registry = new RoomRegistry(eventLogSize: 200);
		$uuid = '33333333-3333-3333-3333-333333333333';
		$runtime = $registry->getOrCreate($uuid, expiresAtMs: 9_999_999_999_999);
		$runtime->contentIdentity = new ContentIdentity('netflix', 'S01E03', 'https://example.test/watch/12345');

		$result = $registry === null ? [] : (new PresenceController($registry))->presenceFor([$uuid]);
		$this->assertArrayHasKey($uuid, $result);

		$identity = $result[$uuid]['contentIdentity'];
		$this->assertNotNull($identity);
		$this->assertSame('netflix', $identity['providerId']);
		$this->assertSame('S01E03', $identity['episodeId']);
		$this->assertSame('https://example.test/watch/12345', $identity['pageUrl']);
		$this->assertSame(64, strlen($identity['contentKey']), 'contentKey is sha256 hex');
	}

	public function testTruncatesClientListAtCap(): void {
		$registry = new RoomRegistry(eventLogSize: 200);
		$uuid = '44444444-4444-4444-4444-444444444444';
		$runtime = $registry->getOrCreate($uuid, expiresAtMs: 9_999_999_999_999);

		$total = PresenceController::MAX_CLIENTS_PER_ROOM + 7;
		for ($i = 0; $i < $total; $i++) {
			$runtime->addClient($this->makeClient('c' . $i, nowMs: 1_700_000_000_000 + $i, conn: $this->fakeConn()));
		}

		$result = (new PresenceController($registry))->presenceFor([$uuid]);
		$entry = $result[$uuid];

		$this->assertSame($total, $entry['connectedCount'], 'count is the true total even when truncated');
		$this->assertCount(PresenceController::MAX_CLIENTS_PER_ROOM, $entry['clients']);
	}

	public function testLastActivityFallsBackToNullForRoomWithNoClientsOrEvents(): void {
		$registry = new RoomRegistry(eventLogSize: 200);
		$uuid = '55555555-5555-5555-5555-555555555555';
		$registry->getOrCreate($uuid, expiresAtMs: 9_999_999_999_999);

		$result = (new PresenceController($registry))->presenceFor([$uuid]);
		$this->assertArrayHasKey($uuid, $result);
		$this->assertNull($result[$uuid]['lastActivityMs']);
		$this->assertSame(0, $result[$uuid]['connectedCount']);
	}

	private function makeClient(string $id, int $nowMs, ?ConnectionInterface $conn): ClientConnection {
		return new ClientConnection(
			clientId: $id,
			nickname: 'Nick' . $id,
			conn: $conn,
			nowMs: $nowMs,
			lastEventId: 0,
			rateLimiter: new RateLimiter(ratePerSecond: 10, nowMs: $nowMs),
		);
	}

	private function fakeConn(): ConnectionInterface {
		return $this->createMock(ConnectionInterface::class);
	}
}
