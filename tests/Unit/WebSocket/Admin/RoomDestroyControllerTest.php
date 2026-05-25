<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\Tests\Unit\WebSocket\Admin;

use OCA\PlaybackSync\WebSocket\Admin\RoomDestroyController;
use OCA\PlaybackSync\WebSocket\ClientConnection;
use OCA\PlaybackSync\WebSocket\MessageEncoder;
use OCA\PlaybackSync\WebSocket\RateLimiter;
use OCA\PlaybackSync\WebSocket\RoomRegistry;
use PHPUnit\Framework\TestCase;
use Ratchet\ConnectionInterface;

class RoomDestroyControllerTest extends TestCase {

	private function makeController(RoomRegistry $registry): RoomDestroyController {
		return new RoomDestroyController($registry, new MessageEncoder());
	}

	public function testReturnsRoomNotFoundWhenRuntimeAbsent(): void {
		$registry = new RoomRegistry(eventLogSize: 200);
		$result = $this->makeController($registry)->destroy(
			'11111111-1111-1111-1111-111111111111',
			nowMs: 1000,
		);

		$this->assertSame(RoomDestroyController::RESULT_ROOM_NOT_FOUND, $result);
	}

	public function testDestroysRuntimeAndClosesAllClients(): void {
		$registry = new RoomRegistry(eventLogSize: 200);
		$uuid = '22222222-2222-2222-2222-222222222222';
		$runtime = $registry->getOrCreate($uuid, expiresAtMs: 9_999_999_999_999);

		$received = [];
		$mkConn = function () use (&$received): ConnectionInterface {
			$conn = $this->createMock(ConnectionInterface::class);
			$conn->expects($this->once())
				->method('send')
				->with($this->callback(function (string $payload) use (&$received): bool {
					$received[] = $payload;
					return true;
				}));
			$conn->expects($this->once())->method('close');
			return $conn;
		};

		$runtime->addClient(new ClientConnection(
			'one',
			'WittyOne42',
			$mkConn(),
			nowMs: 0,
			lastEventId: 0,
			rateLimiter: new RateLimiter(10, 0),
			playlistRateLimiter: new RateLimiter(2, 0),
		));
		$runtime->addClient(new ClientConnection(
			'two',
			'WittyTwo42',
			$mkConn(),
			nowMs: 0,
			lastEventId: 0,
			rateLimiter: new RateLimiter(10, 0),
			playlistRateLimiter: new RateLimiter(2, 0),
		));

		$result = $this->makeController($registry)->destroy($uuid, nowMs: 1000);

		$this->assertSame(RoomDestroyController::RESULT_DESTROYED, $result);
		$this->assertNull($registry->find($uuid));
		$this->assertCount(2, $received);
		foreach ($received as $payload) {
			$decoded = json_decode($payload, true);
			$this->assertSame('ERROR', $decoded['type']);
			$this->assertSame('ROOM_DELETED', $decoded['code']);
		}
	}

	public function testDestroysRuntimeWithNoClients(): void {
		$registry = new RoomRegistry(eventLogSize: 200);
		$uuid = '33333333-3333-3333-3333-333333333333';
		$registry->getOrCreate($uuid, expiresAtMs: 9_999_999_999_999);

		$result = $this->makeController($registry)->destroy($uuid, nowMs: 1000);

		$this->assertSame(RoomDestroyController::RESULT_DESTROYED, $result);
		$this->assertNull($registry->find($uuid));
	}
}
