<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\Settings;

/**
 * Single source of truth for the values written to `IAppConfig` the first time
 * the app is installed (or upgraded past the seed migration). After the
 * `EnsureDefaultSettings` repair step runs, readers across the codebase can
 * trust that these keys are present and read them without inline fallbacks.
 *
 * Adding a key here means it is automatically seeded by the next repair pass.
 * Removing one does not retroactively clear it from existing installs — write
 * a separate repair step for that.
 */
final class SettingsDefaults {

	/**
	 * Keys that map to `setValueInt` / `getValueInt`.
	 *
	 * @var array<string, int>
	 */
	public const INT_DEFAULTS = [
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
		'ws_port' => 8765,
		'ws_admin_port' => 8766,
		'default_ttl_seconds' => 86_400,
		'max_ttl_seconds' => 86_400,
		'max_clients_per_room' => 50,
		// Unix seconds of the last successful GitHub update check; 0 = never.
		// Written by UpdateCheckerService, not user-editable.
		'update_last_checked_at' => 0,
	];

	/**
	 * Keys that map to `setValueString` / `getValueString`.
	 *
	 * @var array<string, string>
	 */
	public const STRING_DEFAULTS = [
		'ws_host' => '127.0.0.1',
		'ws_admin_host' => '127.0.0.1',
		// Newest release version + its URL as last seen on GitHub; '' = unknown.
		// Written by UpdateCheckerService, not user-editable.
		'update_latest_version' => '',
		'update_latest_url' => '',
	];

	/**
	 * Keys that map to `setValueBool` / `getValueBool`.
	 *
	 * @var array<string, bool>
	 */
	public const BOOL_DEFAULTS = [
		'restrict_to_admins' => false,
		// Whether the daily background job is allowed to call out to GitHub.
		'update_check_enabled' => true,
	];
}
