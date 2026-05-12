<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\Tests\Unit\WebSocket\Admin;

use OCA\PlaybackSync\WebSocket\Admin\EventIngestController;
use OCA\PlaybackSync\WebSocket\RoomRegistry;
use PHPUnit\Framework\TestCase;

class EventIngestControllerTest extends TestCase {

	private function makeController(RoomRegistry $registry): EventIngestController {
		return new EventIngestController($registry);
	}

	public function testRejectsMissingType(): void {
		$registry = new RoomRegistry(eventLogSize: 10);
		$result = $this->makeController($registry)->apply([
			'category' => 'admin',
			'actor' => 'admin',
		], nowMs: 1000);

		$this->assertSame(EventIngestController::RESULT_INVALID_PAYLOAD, $result['result']);
		$this->assertSame('type', $result['error']);
	}

	public function testRejectsUnknownCategory(): void {
		$registry = new RoomRegistry(eventLogSize: 10);
		$result = $this->makeController($registry)->apply([
			'type' => 'settings_updated',
			'category' => 'something_else',
			'actor' => 'admin',
		], nowMs: 1000);

		$this->assertSame(EventIngestController::RESULT_INVALID_PAYLOAD, $result['result']);
		$this->assertSame('category', $result['error']);
	}

	public function testRejectsUnknownActor(): void {
		$registry = new RoomRegistry(eventLogSize: 10);
		$result = $this->makeController($registry)->apply([
			'type' => 'room_created',
			'category' => 'lifecycle',
			'actor' => 'rogue',
		], nowMs: 1000);

		$this->assertSame(EventIngestController::RESULT_INVALID_PAYLOAD, $result['result']);
	}

	public function testAppendsToGlobalRingWhenRoomUuidHasNoRuntime(): void {
		$registry = new RoomRegistry(eventLogSize: 10);
		$received = [];
		$registry->subscribeGlobal(function (array $env) use (&$received): void {
			$received[] = $env;
		});

		$result = $this->makeController($registry)->apply([
			'type' => 'room_created',
			'category' => 'lifecycle',
			'actor' => 'owner',
			'actorId' => 'alice',
			'roomUuid' => 'room-a',
			'data' => ['name' => 'Movie night'],
		], nowMs: 1234);

		$this->assertSame(EventIngestController::RESULT_ACCEPTED, $result['result']);
		$this->assertGreaterThan(0, $result['id']);
		$this->assertCount(1, $received);
		$this->assertSame('room_created', $received[0]['type']);
		$this->assertSame('room-a', $received[0]['roomUuid']);
		$this->assertSame(1234, $received[0]['ts']);
	}

	public function testRoutesToRuntimeWhenRoomUuidMatchesLiveRoom(): void {
		$registry = new RoomRegistry(eventLogSize: 10);
		$runtime = $registry->getOrCreate('room-a', expiresAtMs: 9_999_999_999_999);
		$roomReceived = [];
		$registry->subscribeRoom('room-a', function (array $env) use (&$roomReceived): void {
			$roomReceived[] = $env;
		});

		$result = $this->makeController($registry)->apply([
			'type' => 'settings_updated',
			'category' => 'admin',
			'actor' => 'admin',
			'actorId' => 'bob',
			'roomUuid' => 'room-a',
			'data' => ['keys' => ['x']],
		], nowMs: 5000);

		$this->assertSame(EventIngestController::RESULT_ACCEPTED, $result['result']);
		$this->assertCount(1, $roomReceived);
		// Envelope should land in the per-runtime ring, not the global one.
		$this->assertCount(0, $registry->globalEventLog());
		$this->assertCount(1, $runtime->envelopesSince(0));
	}

	public function testAcceptsNullRoomUuid(): void {
		$registry = new RoomRegistry(eventLogSize: 10);
		$result = $this->makeController($registry)->apply([
			'type' => 'settings_updated',
			'category' => 'admin',
			'actor' => 'admin',
			'actorId' => 'admin-user',
			'roomUuid' => null,
		], nowMs: 5000);

		$this->assertSame(EventIngestController::RESULT_ACCEPTED, $result['result']);
		$this->assertCount(1, $registry->globalEventLog());
	}
}
