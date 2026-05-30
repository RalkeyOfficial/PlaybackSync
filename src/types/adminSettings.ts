/**
 * Persisted-or-null shape used everywhere admin settings cross PHP↔TS. The
 * server returns `null` for any key that has never been written to IAppConfig
 * — in practice that only happens if an admin manually deleted a seeded key,
 * because `EnsureDefaultSettings` populates all of them on install. The
 * frontend renders `null` as an empty input with a placeholder suggesting the
 * install-time default; it never substitutes a value of its own.
 */
export interface WsTuningSettings {
	ws_join_timeout_ms: number | null
	ws_idle_close_ms: number | null
	ws_tombstone_ms: number | null
	ws_kick_block_ms: number | null
	ws_event_log_size: number | null
	ws_rate_limit_events_per_sec: number | null
	ws_drift_nudge_threshold_ms: number | null
	ws_drift_seek_threshold_ms: number | null
	ws_drift_cooldown_ms: number | null
}

export interface DaemonSettings {
	ws_host: string | null
	ws_port: number | null
	ws_admin_host: string | null
	ws_admin_port: number | null
}

export interface RoomSettings {
	restrict_to_admins: boolean | null
	default_ttl_seconds: number | null
	max_ttl_seconds: number | null
	max_clients_per_room: number | null
}

export interface AdminSecretInfo {
	configured: boolean
	masked: string
	length: number
}

/**
 * GitHub release-check status. PlaybackSync ships from GitHub, not the
 * Nextcloud App Store, so this is the app's own "update available?" signal.
 * `latestVersion` and `lastCheckedAt` are null until the first check succeeds.
 */
export interface UpdateStatus {
	/** Whether the daily background check is allowed to call out to GitHub. */
	enabled: boolean
	/** The installed app version, from appinfo/info.xml. */
	currentVersion: string
	/** Newest version seen on GitHub, or null if never checked. */
	latestVersion: string | null
	/** True when `latestVersion` is strictly newer than `currentVersion`. */
	updateAvailable: boolean
	/** Link to the release (or the releases page as a fallback). */
	releaseUrl: string
	/** Unix seconds of the last successful check, or null if never. */
	lastCheckedAt: number | null
}

export interface AdminSettingsSnapshot {
	wsTuning: WsTuningSettings
	daemon: DaemonSettings
	rooms: RoomSettings
	secret: AdminSecretInfo
	updates: UpdateStatus
}

export type AdminSettingsSection = 'wsTuning' | 'daemon' | 'rooms'

/**
 * Flat patch shape accepted by `PUT /api/v1/admin/settings`. Every key is
 * optional; the server treats whatever is sent as the full set of changes
 * to apply atomically. Null values are stripped before the patch is sent —
 * the server validator rejects them.
 */
export type AdminSettingsPatch = Partial<{
	[K in keyof (WsTuningSettings & DaemonSettings & RoomSettings)]:
	NonNullable<(WsTuningSettings & DaemonSettings & RoomSettings)[K]>
} & {
	/** The update auto-check toggle is patched on its own, outside the form sections. */
	update_check_enabled: boolean
}>
