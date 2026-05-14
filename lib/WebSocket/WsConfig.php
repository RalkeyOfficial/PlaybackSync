<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\WebSocket;

use OCA\PlaybackSync\AppInfo\Application;
use OCP\IAppConfig;

/**
 * Snapshot of the daemon's tunable parameters.
 *
 * Read once at startup so individual handlers don't each pay a
 * round-trip to the IAppConfig store on every message.
 */
class WsConfig {
	public function __construct(
		public readonly int $joinTimeoutMs,
		public readonly int $idleCloseMs,
		public readonly int $tombstoneMs,
		public readonly int $kickBlockMs,
		public readonly int $eventLogSize,
		public readonly int $rateLimitEventsPerSec,
		public readonly int $rateLimitPlaylistPerSec,
		public readonly int $driftNudgeThresholdMs,
		public readonly int $driftSeekThresholdMs,
		public readonly int $driftCooldownMs,
		public readonly int $maxClientsPerRoom,
	) {
	}

	public static function fromAppConfig(IAppConfig $cfg): self {
		$app = Application::APP_ID;
		return new self(
			joinTimeoutMs: $cfg->getValueInt($app, 'ws_join_timeout_ms', 5_000),
			idleCloseMs: $cfg->getValueInt($app, 'ws_idle_close_ms', 30_000),
			tombstoneMs: $cfg->getValueInt($app, 'ws_tombstone_ms', 30_000),
			kickBlockMs: $cfg->getValueInt($app, 'ws_kick_block_ms', 30_000),
			eventLogSize: $cfg->getValueInt($app, 'ws_event_log_size', 200),
			rateLimitEventsPerSec: $cfg->getValueInt($app, 'ws_rate_limit_events_per_sec', 10),
			rateLimitPlaylistPerSec: $cfg->getValueInt($app, 'ws_rate_limit_playlist_per_sec', 2),
			driftNudgeThresholdMs: $cfg->getValueInt($app, 'ws_drift_nudge_threshold_ms', 200),
			driftSeekThresholdMs: $cfg->getValueInt($app, 'ws_drift_seek_threshold_ms', 500),
			driftCooldownMs: $cfg->getValueInt($app, 'ws_drift_cooldown_ms', 3_000),
			maxClientsPerRoom: $cfg->getValueInt($app, 'max_clients_per_room', 50),
		);
	}
}
