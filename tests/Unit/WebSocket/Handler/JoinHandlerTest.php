<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\Tests\Unit\WebSocket\Handler;

use OCA\PlaybackSync\Db\Room;
use OCA\PlaybackSync\Db\RoomMapper;
use OCA\PlaybackSync\Service\RoomService;
use OCA\PlaybackSync\WebSocket\ConnectionContext;
use OCA\PlaybackSync\WebSocket\Handler\JoinHandler;
use OCA\PlaybackSync\WebSocket\MessageEncoder;
use OCA\PlaybackSync\WebSocket\MessageException;
use OCA\PlaybackSync\WebSocket\RoomRegistry;
use OCA\PlaybackSync\WebSocket\WsConfig;
use OCP\AppFramework\Db\DoesNotExistException;
use PHPUnit\Framework\MockObject\MockObject;
use PHPUnit\Framework\TestCase;
use Ratchet\ConnectionInterface;

class JoinHandlerTest extends TestCase {

	private RoomMapper&MockObject $mapper;
	private RoomService&MockObject $service;
	private RoomRegistry $registry;
	private MessageEncoder $encoder;
	private WsConfig $config;
	private JoinHandler $handler;

	private const ROOM_UUID = '11111111-1111-4111-9111-111111111111';
	private const NOW_MS = 1_000_000;

	protected function setUp(): void {
		parent::setUp();
		$this->mapper = $this->createMock(RoomMapper::class);
		$this->service = $this->createMock(RoomService::class);
		$this->registry = new RoomRegistry(eventLogSize: 50);
		$this->encoder = new MessageEncoder();
		$this->config = new WsConfig(5000, 30000, 30000, 30000, 50, 10, 200, 500, 3000, 50);
		$this->handler = new JoinHandler($this->mapper, $this->service, $this->registry, $this->encoder, $this->config);
	}

	private function makeRoom(int $expiresAtMs): Room {
		$room = new Room();
		$room->setUuid(self::ROOM_UUID);
		$room->setOwnerUserId('alice');
		$room->setPasswordHash('hash');
		$room->setCreatedAt(0);
		$room->setExpiresAt($expiresAtMs);
		return $room;
	}

	public function testJoinFailsWhenRoomDoesNotExist(): void {
		$this->mapper->method('findByUuid')->willThrowException(new DoesNotExistException('nope'));

		$conn = $this->createMock(ConnectionInterface::class);
		$conn->expects($this->never())->method('send');

		$this->expectException(MessageException::class);
		$this->expectExceptionMessage('Room not found');
		$this->handler->handle($conn, new ConnectionContext(self::ROOM_UUID), $this->payload(), self::NOW_MS);
	}

	public function testJoinFailsWhenRoomExpired(): void {
		$this->mapper->method('findByUuid')->willReturn($this->makeRoom(self::NOW_MS - 1));

		$conn = $this->createMock(ConnectionInterface::class);

		$this->expectException(MessageException::class);
		$this->expectExceptionMessage('Room has expired');
		$this->handler->handle($conn, new ConnectionContext(self::ROOM_UUID), $this->payload(), self::NOW_MS);
	}

	public function testJoinFailsOnWrongPassword(): void {
		$this->mapper->method('findByUuid')->willReturn($this->makeRoom(self::NOW_MS + 60_000));
		$this->service->method('verifyPassword')->willReturn(false);

		$conn = $this->createMock(ConnectionInterface::class);

		$this->expectException(MessageException::class);
		$this->expectExceptionMessage('Incorrect room password');
		$this->handler->handle($conn, new ConnectionContext(self::ROOM_UUID), $this->payload(), self::NOW_MS);
	}

	public function testJoinSucceedsAndSendsRoomState(): void {
		$this->mapper->method('findByUuid')->willReturn($this->makeRoom(self::NOW_MS + 60_000));
		$this->service->method('verifyPassword')->willReturn(true);

		$conn = $this->createMock(ConnectionInterface::class);
		$captured = null;
		$conn->expects($this->once())
			->method('send')
			->willReturnCallback(function (string $frame) use (&$captured): void {
				$captured = $frame;
			});

		$ctx = new ConnectionContext(self::ROOM_UUID);
		$this->handler->handle($conn, $ctx, $this->payload(), self::NOW_MS);

		$this->assertTrue($ctx->joined);
		$this->assertNotNull($ctx->clientId);

		$decoded = json_decode($captured, true);
		$this->assertSame('ROOM_STATE', $decoded['type']);
		$this->assertSame($ctx->clientId, $decoded['clientId']);
		$this->assertSame(0, $decoded['lastEventId']);
		$this->assertArrayNotHasKey('recentEvents', $decoded);
	}

	public function testReconnectionWithLastEventIdTriggersReplay(): void {
		$this->mapper->method('findByUuid')->willReturn($this->makeRoom(self::NOW_MS + 60_000));
		$this->service->method('verifyPassword')->willReturn(true);

		// Pre-populate the room with three events; client claims to have seen up to id=1.
		$runtime = $this->registry->getOrCreate(self::ROOM_UUID, self::NOW_MS + 60_000);
		$runtime->state->applyPlay(self::NOW_MS - 100);
		$runtime->pushEvent('play', null, 'someone', self::NOW_MS - 100, $runtime->state->eventId);
		$runtime->state->applySeek(120.0, self::NOW_MS - 50);
		$runtime->pushEvent('seek', 120.0, 'someone', self::NOW_MS - 50, $runtime->state->eventId);
		$runtime->state->applyPause(self::NOW_MS - 25);
		$runtime->pushEvent('pause', null, 'someone', self::NOW_MS - 25, $runtime->state->eventId);

		$conn = $this->createMock(ConnectionInterface::class);
		$captured = null;
		$conn->expects($this->once())->method('send')
			->willReturnCallback(function (string $frame) use (&$captured): void {
				$captured = $frame;
			});

		$payload = $this->payload();
		$payload['lastEventId'] = 1;
		$this->handler->handle($conn, new ConnectionContext(self::ROOM_UUID), $payload, self::NOW_MS);

		$decoded = json_decode($captured, true);
		$this->assertArrayHasKey('recentEvents', $decoded);
		$this->assertCount(2, $decoded['recentEvents']);
		$this->assertSame(2, $decoded['recentEvents'][0]['eventId']);
		$this->assertSame(3, $decoded['recentEvents'][1]['eventId']);
	}

	public function testTombstoneReattachReusesClientId(): void {
		$this->mapper->method('findByUuid')->willReturn($this->makeRoom(self::NOW_MS + 60_000));
		$this->service->method('verifyPassword')->willReturn(true);

		// First connect.
		$conn1 = $this->createMock(ConnectionInterface::class);
		$conn1->method('send');
		$ctx1 = new ConnectionContext(self::ROOM_UUID);
		$this->handler->handle($conn1, $ctx1, $this->payload(), self::NOW_MS);
		$savedClientId = $ctx1->clientId;
		$this->assertNotNull($savedClientId);

		// Simulate disconnect: tombstone the client manually.
		$runtime = $this->registry->find(self::ROOM_UUID);
		$runtime->getClient($savedClientId)->tombstone(self::NOW_MS + 30_000);

		// Reconnect with the same clientId.
		$conn2 = $this->createMock(ConnectionInterface::class);
		$conn2->method('send');
		$ctx2 = new ConnectionContext(self::ROOM_UUID);
		$payload = $this->payload();
		$payload['clientId'] = $savedClientId;
		$this->handler->handle($conn2, $ctx2, $payload, self::NOW_MS + 1000);

		$this->assertSame($savedClientId, $ctx2->clientId);
		$this->assertSame(1, $runtime->clientCount(), 'tombstoned slot should be reused');
		$this->assertSame($conn2, $runtime->getClient($savedClientId)->conn);
	}

	public function testJoinFailsWhenClientIdIsBlockedAfterKick(): void {
		$this->mapper->method('findByUuid')->willReturn($this->makeRoom(self::NOW_MS + 60_000));
		$this->service->method('verifyPassword')->willReturn(true);

		// Stage a previously-connected client and kick it, mirroring the real
		// flow that records the reconnect block.
		$runtime = $this->registry->getOrCreate(self::ROOM_UUID, self::NOW_MS + 60_000);
		$runtime->addClient(new \OCA\PlaybackSync\WebSocket\ClientConnection(
			'bannedId',
			'WittyBanned42',
			$this->createMock(ConnectionInterface::class),
			self::NOW_MS,
			0,
			new \OCA\PlaybackSync\WebSocket\RateLimiter(10, self::NOW_MS),
		));
		$runtime->kickClient('bannedId', $this->encoder, blockMs: 30_000, nowMs: self::NOW_MS);

		$conn = $this->createMock(ConnectionInterface::class);
		$payload = $this->payload();
		$payload['clientId'] = 'bannedId';

		$this->expectException(MessageException::class);
		$this->expectExceptionMessage('Disconnected by room owner');
		$this->handler->handle($conn, new ConnectionContext(self::ROOM_UUID), $payload, self::NOW_MS + 1000);
	}

	// CONTENT_MISMATCH (content-identity reconciliation) was removed in the
	// CONTENT_MODEL_DATA substrate spec — JoinHandler no longer steers
	// joiners based on the (providerId, episodeId, pageUrl) wire fields.
	// Steering belongs to CONTENT_MODEL_PROTOCOL and will be re-tested there.

	private function payload(): array {
		return [
			'password' => 'secret',
			'clientId' => null,
			'lastEventId' => null,
			'episodeId' => null,
			'providerId' => null,
			'pageUrl' => null,
		];
	}
}
