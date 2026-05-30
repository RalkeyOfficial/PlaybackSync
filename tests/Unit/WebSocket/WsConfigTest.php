<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\Tests\Unit\WebSocket;

use OCA\PlaybackSync\WebSocket\WsConfig;
use OCP\IAppConfig;
use PHPUnit\Framework\TestCase;

class WsConfigTest extends TestCase {

	/**
	 * The defaults the daemon boots with, in `WsConfig` positional order.
	 *
	 * @var array<string, int>
	 */
	private const BOOT = [
		'ws_join_timeout_ms' => 5_000,
		'ws_idle_close_ms' => 30_000,
		'ws_tombstone_ms' => 30_000,
		'ws_kick_block_ms' => 30_000,
		'ws_event_log_size' => 200,
		'ws_rate_limit_events_per_sec' => 10,
		'ws_rate_limit_playlist_per_sec' => 2,
		'ws_drift_nudge_threshold_ms' => 200,
		'ws_drift_seek_threshold_ms' => 500,
		'ws_drift_cooldown_ms' => 3_000,
		'max_clients_per_room' => 50,
	];

	public function testReloadFromClearsCacheAndReportsOnlyChangedKeys(): void {
		$config = $this->bootConfig();

		// Two keys change; everything else stays put.
		$updated = self::BOOT;
		$updated['ws_drift_nudge_threshold_ms'] = 400;
		$updated['max_clients_per_room'] = 80;

		$cfg = $this->createMock(IAppConfig::class);
		// Critical: the long-running daemon must drop its per-process cache or
		// it would just re-read its own boot snapshot.
		$cfg->expects($this->once())->method('clearCache');
		$cfg->method('getValueInt')->willReturnCallback(
			static fn (string $app, string $key): int => $updated[$key],
		);

		$changed = $config->reloadFrom($cfg);

		$this->assertSame([
			'driftNudgeThresholdMs' => ['from' => 200, 'to' => 400],
			'maxClientsPerRoom' => ['from' => 50, 'to' => 80],
		], $changed);
		// Values applied in place so live readers see them.
		$this->assertSame(400, $config->driftNudgeThresholdMs);
		$this->assertSame(80, $config->maxClientsPerRoom);
		// Untouched key keeps its value.
		$this->assertSame(5_000, $config->joinTimeoutMs);
	}

	public function testReloadFromReturnsEmptyWhenNothingChanged(): void {
		$config = $this->bootConfig();

		$cfg = $this->createMock(IAppConfig::class);
		$cfg->expects($this->once())->method('clearCache');
		$cfg->method('getValueInt')->willReturnCallback(
			static fn (string $app, string $key): int => self::BOOT[$key],
		);

		$this->assertSame([], $config->reloadFrom($cfg));
	}

	private function bootConfig(): WsConfig {
		return new WsConfig(
			joinTimeoutMs: self::BOOT['ws_join_timeout_ms'],
			idleCloseMs: self::BOOT['ws_idle_close_ms'],
			tombstoneMs: self::BOOT['ws_tombstone_ms'],
			kickBlockMs: self::BOOT['ws_kick_block_ms'],
			eventLogSize: self::BOOT['ws_event_log_size'],
			rateLimitEventsPerSec: self::BOOT['ws_rate_limit_events_per_sec'],
			rateLimitPlaylistPerSec: self::BOOT['ws_rate_limit_playlist_per_sec'],
			driftNudgeThresholdMs: self::BOOT['ws_drift_nudge_threshold_ms'],
			driftSeekThresholdMs: self::BOOT['ws_drift_seek_threshold_ms'],
			driftCooldownMs: self::BOOT['ws_drift_cooldown_ms'],
			maxClientsPerRoom: self::BOOT['max_clients_per_room'],
		);
	}
}
