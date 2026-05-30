<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\WebSocket;

use OCA\PlaybackSync\AppInfo\Application;
use OCP\IAppConfig;

/**
 * Snapshot of the daemon's tunable parameters.
 *
 * Read once at startup so individual handlers don't each pay a round-trip to
 * the IAppConfig store on every message. The daemon holds a single shared
 * instance and most consumers read values live off it, so the snapshot can be
 * refreshed in place via {@see reloadFrom()} (triggered by SIGHUP or the
 * `POST /admin/reload` admin route) without restarting the process.
 *
 * Not every key takes effect on reload: `eventLogSize` is baked into each room
 * at creation, the rate-limit values are captured per client at JOIN, and the
 * binding keys aren't part of this object at all — see `reloadFrom()`.
 */
class WsConfig {
	public function __construct(
		public int $joinTimeoutMs,
		public int $idleCloseMs,
		public int $tombstoneMs,
		public int $kickBlockMs,
		public int $eventLogSize,
		public int $rateLimitEventsPerSec,
		public int $rateLimitPlaylistPerSec,
		public int $driftNudgeThresholdMs,
		public int $driftSeekThresholdMs,
		public int $driftCooldownMs,
		public int $maxClientsPerRoom,
	) {
	}

	public static function fromAppConfig(IAppConfig $cfg): self {
		$v = self::read($cfg);
		return new self(
			$v['joinTimeoutMs'],
			$v['idleCloseMs'],
			$v['tombstoneMs'],
			$v['kickBlockMs'],
			$v['eventLogSize'],
			$v['rateLimitEventsPerSec'],
			$v['rateLimitPlaylistPerSec'],
			$v['driftNudgeThresholdMs'],
			$v['driftSeekThresholdMs'],
			$v['driftCooldownMs'],
			$v['maxClientsPerRoom'],
		);
	}

	/**
	 * Re-read every tunable from `IAppConfig` and apply it to this instance in
	 * place, so live readers of the shared `WsConfig` pick the new values up on
	 * their next message without a restart.
	 *
	 * @param IAppConfig $cfg the live config store to re-read from
	 * @return array<string, array{from: int, to: int}> changed properties only,
	 *         keyed by property name, for logging / surfacing to the operator
	 */
	public function reloadFrom(IAppConfig $cfg): array {
		// IAppConfig caches every app value for the life of the process. In the
		// long-running daemon that means a plain re-read just returns our own
		// boot-time snapshot — drop the cache first so we actually pick up writes
		// made by the (separate) PHP-FPM request that changed the settings.
		$cfg->clearCache();
		$changed = [];
		foreach (self::read($cfg) as $prop => $value) {
			if ($this->$prop !== $value) {
				$changed[$prop] = ['from' => $this->$prop, 'to' => $value];
			}
			$this->$prop = $value;
		}
		return $changed;
	}

	/**
	 * Read all tunables from the config store into a property-keyed map. Shared
	 * by the constructor factory and the in-place reload so the key list lives
	 * in exactly one spot.
	 *
	 * @param IAppConfig $cfg the config store to read from
	 * @return array<string, int> property name => value
	 */
	private static function read(IAppConfig $cfg): array {
		$app = Application::APP_ID;
		return [
			'joinTimeoutMs' => $cfg->getValueInt($app, 'ws_join_timeout_ms'),
			'idleCloseMs' => $cfg->getValueInt($app, 'ws_idle_close_ms'),
			'tombstoneMs' => $cfg->getValueInt($app, 'ws_tombstone_ms'),
			'kickBlockMs' => $cfg->getValueInt($app, 'ws_kick_block_ms'),
			'eventLogSize' => $cfg->getValueInt($app, 'ws_event_log_size'),
			'rateLimitEventsPerSec' => $cfg->getValueInt($app, 'ws_rate_limit_events_per_sec'),
			'rateLimitPlaylistPerSec' => $cfg->getValueInt($app, 'ws_rate_limit_playlist_per_sec'),
			'driftNudgeThresholdMs' => $cfg->getValueInt($app, 'ws_drift_nudge_threshold_ms'),
			'driftSeekThresholdMs' => $cfg->getValueInt($app, 'ws_drift_seek_threshold_ms'),
			'driftCooldownMs' => $cfg->getValueInt($app, 'ws_drift_cooldown_ms'),
			'maxClientsPerRoom' => $cfg->getValueInt($app, 'max_clients_per_room'),
		];
	}
}
