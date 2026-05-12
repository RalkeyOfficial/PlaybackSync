<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\Tests\Unit\WebSocket;

use OCA\PlaybackSync\WebSocket\RoomRegistry;
use PHPUnit\Framework\TestCase;
use RuntimeException;

/**
 * Unit tests for `RoomRegistry`'s SSE-facing infrastructure: id allocation,
 * per-room + global pub/sub, exception isolation, the cross-room ring's
 * capacity eviction, and `mergedEventsSince` ordering.
 *
 * Plain `new RoomRegistry()` — the class is pure value transformation, no
 * external dependencies, so we exercise the real implementation.
 */
class RoomRegistryTest extends TestCase {

	public function testAllocateEventIdIsMonotonic(): void {
		$registry = new RoomRegistry(eventLogSize: 10);

		$this->assertSame(1, $registry->allocateEventId());
		$this->assertSame(2, $registry->allocateEventId());
		$this->assertSame(3, $registry->allocateEventId());
	}

	public function testSubscribeRoomFansEnvelopesToRegisteredCallback(): void {
		$registry = new RoomRegistry(eventLogSize: 10);
		$received = [];
		$registry->subscribeRoom('room-a', function (array $env) use (&$received): void {
			$received[] = $env;
		});

		$registry->publishRoomEvent('room-a', ['id' => 1, 'type' => 'x']);
		$registry->publishRoomEvent('room-b', ['id' => 2, 'type' => 'y']);

		$this->assertCount(1, $received);
		$this->assertSame('x', $received[0]['type']);
	}

	public function testUnsubscribeRoomStopsFurtherDeliveries(): void {
		$registry = new RoomRegistry(eventLogSize: 10);
		$count = 0;
		$unsubscribe = $registry->subscribeRoom('room-a', function () use (&$count): void {
			$count++;
		});

		$registry->publishRoomEvent('room-a', ['id' => 1]);
		$unsubscribe();
		$registry->publishRoomEvent('room-a', ['id' => 2]);

		$this->assertSame(1, $count);
	}

	public function testThrowingSubscriberDoesNotPreventOtherSubscribersFromReceivingEnvelope(): void {
		$registry = new RoomRegistry(eventLogSize: 10);
		$other = 0;
		$registry->subscribeRoom('room-a', static function (): void {
			throw new RuntimeException('boom');
		});
		$registry->subscribeRoom('room-a', function () use (&$other): void {
			$other++;
		});

		$registry->publishRoomEvent('room-a', ['id' => 1]);

		$this->assertSame(1, $other);
	}

	public function testSubscribeGlobalReceivesPerRoomAndCrossRoomEvents(): void {
		$registry = new RoomRegistry(eventLogSize: 10);
		$received = [];
		$registry->subscribeGlobal(function (array $env) use (&$received): void {
			$received[] = $env['id'] ?? null;
		});

		$registry->publishRoomEvent('room-a', ['id' => 5]);
		$registry->appendGlobalEvent(['type' => 'room_created']);

		$this->assertCount(2, $received);
		$this->assertSame(5, $received[0]);
	}

	public function testAppendGlobalEventEvictsOldestWhenCapacityExceeded(): void {
		$registry = new RoomRegistry(eventLogSize: 3);

		$registry->appendGlobalEvent(['type' => 'a']);
		$registry->appendGlobalEvent(['type' => 'b']);
		$registry->appendGlobalEvent(['type' => 'c']);
		$registry->appendGlobalEvent(['type' => 'd']);

		$ring = $registry->globalEventLog();
		$this->assertCount(3, $ring);
		$this->assertSame('b', $ring[0]['type']);
		$this->assertSame('d', $ring[2]['type']);
	}

	public function testAppendGlobalEventFansOutToRoomSubscribersWhenRoomUuidMatches(): void {
		$registry = new RoomRegistry(eventLogSize: 10);
		$received = [];
		$registry->subscribeRoom('room-a', function (array $env) use (&$received): void {
			$received[] = $env;
		});

		$registry->appendGlobalEvent([
			'type' => 'room_deleted',
			'roomUuid' => 'room-a',
		]);
		$registry->appendGlobalEvent([
			'type' => 'settings_updated',
			'roomUuid' => null,
		]);

		$this->assertCount(1, $received);
		$this->assertSame('room_deleted', $received[0]['type']);
	}

	public function testMergedEventsSinceMergesRuntimeAndGlobalChronologically(): void {
		$registry = new RoomRegistry(eventLogSize: 50);

		$runtime = $registry->getOrCreate('room-a', expiresAtMs: 9_999_999_999_999);
		// id=1 (global)
		$registry->appendGlobalEvent(['type' => 'room_created']);
		// id=2 (runtime)
		$runtime->pushEnvelope([
			'ts' => 100,
			'type' => 'client_joined',
			'category' => 'presence',
			'actor' => 'client',
			'actorId' => 'c1',
			'data' => null,
		]);
		// id=3 (global)
		$registry->appendGlobalEvent(['type' => 'settings_updated']);

		$merged = $registry->mergedEventsSince(0);

		$this->assertSame([1, 2, 3], array_map(static fn (array $e): int => $e['id'], $merged));
	}

	public function testMergedEventsSinceFiltersBySinceId(): void {
		$registry = new RoomRegistry(eventLogSize: 50);
		$registry->appendGlobalEvent(['type' => 'a']);
		$registry->appendGlobalEvent(['type' => 'b']);
		$registry->appendGlobalEvent(['type' => 'c']);

		$merged = $registry->mergedEventsSince(1);

		$this->assertSame([2, 3], array_map(static fn (array $e): int => $e['id'], $merged));
	}
}
