<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\Tests\Unit\WebSocket\Admin;

use OCA\PlaybackSync\WebSocket\Admin\KickController;
use OCA\PlaybackSync\WebSocket\ClientConnection;
use OCA\PlaybackSync\WebSocket\MessageEncoder;
use OCA\PlaybackSync\WebSocket\RateLimiter;
use OCA\PlaybackSync\WebSocket\RoomRegistry;
use OCA\PlaybackSync\WebSocket\WsConfig;
use PHPUnit\Framework\TestCase;
use Ratchet\ConnectionInterface;

class KickControllerTest extends TestCase {

	private function makeController(RoomRegistry $registry, int $kickBlockMs = 30_000): KickController {
		$config = new WsConfig(
			joinTimeoutMs: 5_000,
			idleCloseMs: 30_000,
			tombstoneMs: 30_000,
			kickBlockMs: $kickBlockMs,
			eventLogSize: 200,
			rateLimitEventsPerSec: 10,
			driftNudgeThresholdMs: 200,
			driftSeekThresholdMs: 500,
			driftCooldownMs: 3_000,
			maxClientsPerRoom: 50,
		);
		return new KickController($registry, new MessageEncoder(), $config);
	}

	public function testReturnsRoomNotFoundWhenRuntimeAbsent(): void {
		$registry = new RoomRegistry(eventLogSize: 200);
		$result = $this->makeController($registry)->kick(
			'11111111-1111-1111-1111-111111111111',
			'deadbeef',
			nowMs: 1000,
		);

		$this->assertSame(KickController::RESULT_ROOM_NOT_FOUND, $result);
	}

	public function testReturnsClientNotFoundWhenIdAbsent(): void {
		$registry = new RoomRegistry(eventLogSize: 200);
		$uuid = '22222222-2222-2222-2222-222222222222';
		$registry->getOrCreate($uuid, expiresAtMs: 9_999_999_999_999);

		$result = $this->makeController($registry)->kick($uuid, 'ghost', nowMs: 1000);

		$this->assertSame(KickController::RESULT_CLIENT_NOT_FOUND, $result);
	}

	public function testKicksLiveClientAndRecordsBlock(): void {
		$registry = new RoomRegistry(eventLogSize: 200);
		$uuid = '33333333-3333-3333-3333-333333333333';
		$runtime = $registry->getOrCreate($uuid, expiresAtMs: 9_999_999_999_999);

		$conn = $this->createMock(ConnectionInterface::class);
		$conn->expects($this->once())->method('send');
		$conn->expects($this->once())->method('close');
		$runtime->addClient(new ClientConnection(
			'victim',
			$conn,
			nowMs: 0,
			lastEventId: 0,
			rateLimiter: new RateLimiter(10, 0),
		));

		$result = $this->makeController($registry, kickBlockMs: 5000)
			->kick($uuid, 'victim', nowMs: 1000);

		$this->assertSame(KickController::RESULT_KICKED, $result);
		$this->assertNull($runtime->getClient('victim'));
		$this->assertTrue($runtime->isClientBlocked('victim', 1000));
	}
}
