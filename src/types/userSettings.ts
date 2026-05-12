export type TimestampFormat = 'relative' | 'absolute'

export type ShareCopyFormat = 'link' | 'markdown' | 'discord'

export type RoomsSortOrder = 'newest' | 'oldest' | 'name' | 'expiring'

/**
 * The shape returned by `GET /api/v1/user/settings`. Keys are camelCased to
 * keep the frontend payload idiomatic; the underlying config keys on the
 * server side stay snake_case (see `UserSettingsPatch`).
 */
export interface UserSettingsSnapshot {
	autoRefreshIntervalMs: number
	timestampFormat: TimestampFormat
	shareCopyFormat: ShareCopyFormat
	roomsSortOrder: RoomsSortOrder
}

/**
 * Flat patch shape accepted by `PUT /api/v1/user/settings`. Every key is
 * optional; the server treats whatever is sent as the full set of changes
 * to apply atomically. Keys mirror the server-side config names.
 */
export interface UserSettingsPatch {
	auto_refresh_interval_ms?: number
	timestamp_format?: TimestampFormat
	share_copy_format?: ShareCopyFormat
	rooms_sort_order?: RoomsSortOrder
}
