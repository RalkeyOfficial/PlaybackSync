import type {
	RoomsSortOrder,
	ShareCopyFormat,
	TimestampFormat,
	UserSettingsPatch,
	UserSettingsSnapshot,
} from '../types/userSettings.ts'

import { showError, showSuccess } from '@nextcloud/dialogs'
import { translate as t } from '@nextcloud/l10n'
import { getLoggerBuilder } from '@nextcloud/logger'
import { defineStore } from 'pinia'
import { fetchUserSettings, updateUserSettings } from '../services/userSettingsApi.ts'

const logger = getLoggerBuilder().setApp('playbacksync').detectUser().build()

// Mirrors of the server's STRING_DEFAULTS/INT_DEFAULTS. Used until the
// initial fetch resolves, and as a permanent fallback if the fetch fails so
// the UI never has to deal with a missing setting.
const DEFAULT_AUTO_REFRESH_INTERVAL_MS = 15_000
const DEFAULT_TIMESTAMP_FORMAT: TimestampFormat = 'relative'
const DEFAULT_SHARE_COPY_FORMAT: ShareCopyFormat = 'link'
const DEFAULT_ROOMS_SORT_ORDER: RoomsSortOrder = 'newest'

interface UserSettingsState {
	autoRefreshIntervalMs: number
	timestampFormat: TimestampFormat
	shareCopyFormat: ShareCopyFormat
	roomsSortOrder: RoomsSortOrder
	loaded: boolean
	loading: boolean
	saving: boolean
}

export const useUserSettingsStore = defineStore('userSettings', {
	state: (): UserSettingsState => ({
		autoRefreshIntervalMs: DEFAULT_AUTO_REFRESH_INTERVAL_MS,
		timestampFormat: DEFAULT_TIMESTAMP_FORMAT,
		shareCopyFormat: DEFAULT_SHARE_COPY_FORMAT,
		roomsSortOrder: DEFAULT_ROOMS_SORT_ORDER,
		loaded: false,
		loading: false,
		saving: false,
	}),

	actions: {
		async load() {
			this.loading = true
			try {
				const snapshot = await fetchUserSettings()
				this.applySnapshot(snapshot)
				this.loaded = true
			} catch (error) {
				// Background fetch the user didn't initiate — keep the
				// in-memory default and log instead of nagging with a toast.
				logger.error('Failed to load user settings', { error })
			} finally {
				this.loading = false
			}
		},

		async save(patch: UserSettingsPatch): Promise<boolean> {
			this.saving = true
			try {
				const snapshot = await updateUserSettings(patch)
				this.applySnapshot(snapshot)
				this.loaded = true
				showSuccess(t('playbacksync', 'Saved'))
				return true
			} catch (error) {
				logger.error('Failed to save user settings', { error })
				const message = extractErrorMessage(error) ?? t('playbacksync', 'Could not save settings.')
				showError(message)
				return false
			} finally {
				this.saving = false
			}
		},

		applySnapshot(snapshot: UserSettingsSnapshot) {
			this.autoRefreshIntervalMs = snapshot.autoRefreshIntervalMs
			this.timestampFormat = snapshot.timestampFormat
			this.shareCopyFormat = snapshot.shareCopyFormat
			this.roomsSortOrder = snapshot.roomsSortOrder
		},
	},
})

/**
 * Pull the server-supplied error message out of an axios failure when one is
 * present so we surface the validation reason instead of a generic toast.
 *
 * @param error the value caught from a failed axios call
 * @return the server's error message, or null if none could be extracted
 */
function extractErrorMessage(error: unknown): string | null {
	if (typeof error === 'object' && error !== null && 'response' in error) {
		const response = (error as { response?: { data?: { error?: string } } }).response
		if (response?.data?.error) {
			return response.data.error
		}
	}
	return null
}
