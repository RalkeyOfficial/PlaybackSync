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

export interface AdminSettingsSnapshot {
	wsTuning: WsTuningSettings
	daemon: DaemonSettings
	rooms: RoomSettings
	secret: AdminSecretInfo
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
}>
