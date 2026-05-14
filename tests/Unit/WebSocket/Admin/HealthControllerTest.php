<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\Tests\Unit\WebSocket\Admin;

use OCA\PlaybackSync\WebSocket\Admin\HealthController;
use OCA\PlaybackSync\WebSocket\ClientConnection;
use OCA\PlaybackSync\WebSocket\MessageEncoder;
use OCA\PlaybackSync\WebSocket\RateLimiter;
use OCA\PlaybackSync\WebSocket\RoomRegistry;
use OCA\PlaybackSync\WebSocket\Tick;
use OCA\PlaybackSync\WebSocket\WsConfig;
use PHPUnit\Framework\TestCase;
use Psr\Log\NullLogger;

class HealthControllerTest extends TestCase {

	private function makeTick(RoomRegistry $registry): Tick {
		$config = new WsConfig(
			joinTimeoutMs: 5_000,
			idleCloseMs: 30_000,
			tombstoneMs: 30_000,
			kickBlockMs: 30_000,
			eventLogSize: 200,
			rateLimitEventsPerSec: 10, rateLimitPlaylistPerSec: 2,
			driftNudgeThresholdMs: 200,
			driftSeekThresholdMs: 500,
			driftCooldownMs: 3_000,
			maxClientsPerRoom: 50,
		);
		return new Tick($registry, new MessageEncoder(), $config, new NullLogger());
	}

	private function addClient(\OCA\PlaybackSync\WebSocket\RoomRuntime $runtime, string $clientId): void {
		$runtime->addClient(new ClientConnection(
			$clientId,
			'Nick' . $clientId,
			null,
			nowMs: 0,
			lastEventId: 0,
			rateLimiter: new RateLimiter(10, 0),
			playlistRateLimiter: new RateLimiter(2, 0),
		));
	}

	public function testReturnsZeroCountsForEmptyRegistry(): void {
		$registry = new RoomRegistry(eventLogSize: 200);
		$tick = $this->makeTick($registry);
		$controller = new HealthController($registry, $tick, daemonVersion: '0.3.0', startedAtMs: 1_000);

		$result = $controller->health(nowMs: 5_000);

		$this->assertSame('ok', $result['status']);
		$this->assertSame('0.3.0', $result['daemon_version']);
		$this->assertSame(4, $result['uptime_seconds']);
		$this->assertSame(5_000, $result['timestamp_ms']);
		$this->assertSame(['active' => 0], $result['rooms']);
		$this->assertSame(['connected' => 0], $result['clients']);
		// No tick has run yet — flag the loop as not running.
		$this->assertFalse($result['tick']['running']);
		$this->assertNull($result['tick']['last_tick_ms_ago']);
	}

	public function testCountsRoomsAndClientsAcrossRegistry(): void {
		$registry = new RoomRegistry(eventLogSize: 200);
		$roomA = $registry->getOrCreate('11111111-1111-1111-1111-111111111111', expiresAtMs: 9_999_999_999_999);
		$this->addClient($roomA, 'a1');
		$this->addClient($roomA, 'a2');
		$this->addClient($roomA, 'a3');
		$roomB = $registry->getOrCreate('22222222-2222-2222-2222-222222222222', expiresAtMs: 9_999_999_999_999);
		$this->addClient($roomB, 'b1');
		// Empty room — counted in `rooms.active` but contributes zero clients.
		$registry->getOrCreate('33333333-3333-3333-3333-333333333333', expiresAtMs: 9_999_999_999_999);

		$controller = new HealthController(
			$registry,
			$this->makeTick($registry),
			daemonVersion: '1.2.3',
			startedAtMs: 0,
		);

		$result = $controller->health(nowMs: 60_000);

		$this->assertSame(['active' => 3], $result['rooms']);
		$this->assertSame(['connected' => 4], $result['clients']);
		$this->assertSame(60, $result['uptime_seconds']);
	}

	public function testTickRunningWhenRecentTickRecorded(): void {
		$registry = new RoomRegistry(eventLogSize: 200);
		$tick = $this->makeTick($registry);
		$tick->runOnce(nowMs: 10_000);

		$controller = new HealthController($registry, $tick, daemonVersion: '0.3.0', startedAtMs: 0);
		$result = $controller->health(nowMs: 11_000);

		$this->assertTrue($result['tick']['running']);
		$this->assertSame(1_000, $result['tick']['last_tick_ms_ago']);
	}

	public function testTickNotRunningWhenStale(): void {
		$registry = new RoomRegistry(eventLogSize: 200);
		$tick = $this->makeTick($registry);
		$tick->runOnce(nowMs: 10_000);

		$controller = new HealthController($registry, $tick, daemonVersion: '0.3.0', startedAtMs: 0);
		// 6 s past the tick — over the 5 s freshness window.
		$result = $controller->health(nowMs: 16_000);

		$this->assertFalse($result['tick']['running']);
		$this->assertSame(6_000, $result['tick']['last_tick_ms_ago']);
	}

	public function testUptimeNeverNegativeWhenClockSkewed(): void {
		$registry = new RoomRegistry(eventLogSize: 200);
		$controller = new HealthController(
			$registry,
			$this->makeTick($registry),
			daemonVersion: '0.3.0',
			startedAtMs: 10_000,
		);

		// Pathological: now < startedAt (clock went backwards). Uptime must
		// floor at zero rather than reporting a negative integer.
		$result = $controller->health(nowMs: 5_000);
		$this->assertSame(0, $result['uptime_seconds']);
	}
}
