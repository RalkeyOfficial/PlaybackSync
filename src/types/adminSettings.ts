export interface WsTuningSettings {
	ws_join_timeout_ms: number
	ws_idle_close_ms: number
	ws_tombstone_ms: number
	ws_kick_block_ms: number
	ws_event_log_size: number
	ws_rate_limit_events_per_sec: number
	ws_drift_nudge_threshold_ms: number
	ws_drift_seek_threshold_ms: number
	ws_drift_cooldown_ms: number
}

export interface DaemonSettings {
	ws_host: string
	ws_port: number
	ws_admin_host: string
	ws_admin_port: number
}

export interface RoomSettings {
	restrict_to_admins: boolean
	default_ttl_seconds: number
	max_ttl_seconds: number
	max_clients_per_room: number
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
 * to apply atomically.
 */
export type AdminSettingsPatch = Partial<
	WsTuningSettings & DaemonSettings & RoomSettings
>
