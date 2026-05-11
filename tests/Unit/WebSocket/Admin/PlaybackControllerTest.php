<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\Tests\Unit\WebSocket\Admin;

use OCA\PlaybackSync\WebSocket\Admin\PlaybackController;
use OCA\PlaybackSync\WebSocket\ClientConnection;
use OCA\PlaybackSync\WebSocket\MessageEncoder;
use OCA\PlaybackSync\WebSocket\PlaybackState;
use OCA\PlaybackSync\WebSocket\RateLimiter;
use OCA\PlaybackSync\WebSocket\RoomRegistry;
use PHPUnit\Framework\TestCase;
use Ratchet\ConnectionInterface;

class PlaybackControllerTest extends TestCase {

	private function makeController(RoomRegistry $registry): PlaybackController {
		return new PlaybackController($registry, new MessageEncoder());
	}

	public function testReturnsRoomNotFoundWhenRuntimeAbsent(): void {
		$registry = new RoomRegistry(eventLogSize: 200);

		$result = $this->makeController($registry)->apply(
			'11111111-1111-1111-1111-111111111111',
			PlaybackController::ACTION_PLAY,
			null,
			nowMs: 1000,
		);

		$this->assertSame(PlaybackController::RESULT_ROOM_NOT_FOUND, $result);
	}

	public function testReturnsInvalidActionForUnknownAction(): void {
		$registry = new RoomRegistry(eventLogSize: 200);
		$uuid = '22222222-2222-2222-2222-222222222222';
		$registry->getOrCreate($uuid, expiresAtMs: 9_999_999_999_999);

		$result = $this->makeController($registry)->apply(
			$uuid,
			'fastforward',
			null,
			nowMs: 1000,
		);

		$this->assertSame(PlaybackController::RESULT_INVALID_ACTION, $result);
	}

	public function testSeekRequiresNonNegativePosition(): void {
		$registry = new RoomRegistry(eventLogSize: 200);
		$uuid = '33333333-3333-3333-3333-333333333333';
		$registry->getOrCreate($uuid, expiresAtMs: 9_999_999_999_999);
		$controller = $this->makeController($registry);

		$this->assertSame(
			PlaybackController::RESULT_INVALID_POSITION,
			$controller->apply($uuid, PlaybackController::ACTION_SEEK, null, nowMs: 1000),
		);
		$this->assertSame(
			PlaybackController::RESULT_INVALID_POSITION,
			$controller->apply($uuid, PlaybackController::ACTION_SEEK, -1.0, nowMs: 1000),
		);
	}

	public function testPlayMutatesStateAndBroadcasts(): void {
		$registry = new RoomRegistry(eventLogSize: 200);
		$uuid = '44444444-4444-4444-4444-444444444444';
		$runtime = $registry->getOrCreate($uuid, expiresAtMs: 9_999_999_999_999);

		$conn = $this->createMock(ConnectionInterface::class);
		$conn->expects($this->once())->method('send');
		$runtime->addClient(new ClientConnection(
			'viewer',
			$conn,
			nowMs: 0,
			lastEventId: 0,
			rateLimiter: new RateLimiter(10, 0),
		));

		$result = $this->makeController($registry)->apply(
			$uuid,
			PlaybackController::ACTION_PLAY,
			null,
			nowMs: 1000,
		);

		$this->assertSame(PlaybackController::RESULT_APPLIED, $result);
		$this->assertSame(PlaybackState::PLAYING, $runtime->state->playerState);
		$this->assertSame(1, $runtime->state->eventId);
		$this->assertCount(1, $runtime->recentEventsSince(0));
	}

	public function testPauseMutatesStateAndBroadcasts(): void {
		$registry = new RoomRegistry(eventLogSize: 200);
		$uuid = '55555555-5555-5555-5555-555555555555';
		$runtime = $registry->getOrCreate($uuid, expiresAtMs: 9_999_999_999_999);
		$runtime->state->applyPlay(500);

		$result = $this->makeController($registry)->apply(
			$uuid,
			PlaybackController::ACTION_PAUSE,
			null,
			nowMs: 1500,
		);

		$this->assertSame(PlaybackController::RESULT_APPLIED, $result);
		$this->assertSame(PlaybackState::PAUSED, $runtime->state->playerState);
	}

	public function testSeekMutatesStateAndBroadcastsToAllClients(): void {
		$registry = new RoomRegistry(eventLogSize: 200);
		$uuid = '66666666-6666-6666-6666-666666666666';
		$runtime = $registry->getOrCreate($uuid, expiresAtMs: 9_999_999_999_999);

		$connA = $this->createMock(ConnectionInterface::class);
		$connA->expects($this->once())->method('send');
		$connB = $this->createMock(ConnectionInterface::class);
		$connB->expects($this->once())->method('send');
		$runtime->addClient(new ClientConnection('a', $connA, 0, 0, new RateLimiter(10, 0)));
		$runtime->addClient(new ClientConnection('b', $connB, 0, 0, new RateLimiter(10, 0)));

		$result = $this->makeController($registry)->apply(
			$uuid,
			PlaybackController::ACTION_SEEK,
			120.5,
			nowMs: 1000,
		);

		$this->assertSame(PlaybackController::RESULT_APPLIED, $result);
		$this->assertSame(120.5, $runtime->state->videoPos);
	}

	public function testResetPausesAndZeroes(): void {
		$registry = new RoomRegistry(eventLogSize: 200);
		$uuid = '77777777-7777-7777-7777-777777777777';
		$runtime = $registry->getOrCreate($uuid, expiresAtMs: 9_999_999_999_999);
		$runtime->state->applyPlay(500);
		$runtime->state->applySeek(90.0, 600);

		$result = $this->makeController($registry)->apply(
			$uuid,
			PlaybackController::ACTION_RESET,
			null,
			nowMs: 1000,
		);

		$this->assertSame(PlaybackController::RESULT_APPLIED, $result);
		$this->assertSame(PlaybackState::PAUSED, $runtime->state->playerState);
		$this->assertSame(0.0, $runtime->state->videoPos);
		// Two events appended (pause + seek)
		$this->assertGreaterThanOrEqual(2, count($runtime->recentEventsSince(0)));
	}
}
