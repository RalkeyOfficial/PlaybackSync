import type {
	AdminSecretInfo,
	AdminSettingsPatch,
	AdminSettingsSection,
	AdminSettingsSnapshot,
	DaemonSettings,
	RoomSettings,
	WsTuningSettings,
} from '../types/adminSettings.ts'

import { showError, showSuccess } from '@nextcloud/dialogs'
import { translate as t } from '@nextcloud/l10n'
import { getLoggerBuilder } from '@nextcloud/logger'
import { defineStore } from 'pinia'
import {
	fetchAdminSettings,
	regenerateAdminSecret,
	updateAdminSettings,
} from '../services/adminSettingsApi.ts'

const logger = getLoggerBuilder().setApp('playbacksync').detectUser().build()

interface AdminSettingsState {
	wsTuning: WsTuningSettings | null
	daemon: DaemonSettings | null
	rooms: RoomSettings | null
	secret: AdminSecretInfo | null
	loaded: boolean
	loading: boolean
	saving: AdminSettingsSection | null
	regenerating: boolean
}

export const useAdminSettingsStore = defineStore('adminSettings', {
	state: (): AdminSettingsState => ({
		wsTuning: null,
		daemon: null,
		rooms: null,
		secret: null,
		loaded: false,
		loading: false,
		saving: null,
		regenerating: false,
	}),

	actions: {
		async load() {
			this.loading = true
			try {
				const snapshot = await fetchAdminSettings()
				this.applySnapshot(snapshot)
				this.loaded = true
			} catch (error) {
				logger.error('Failed to load admin settings', { error })
				showError(t('playbacksync', 'Could not load settings.'))
			} finally {
				this.loading = false
			}
		},

		async saveSection(section: AdminSettingsSection): Promise<boolean> {
			const patch = this.collectSection(section)
			if (patch === null) {
				return false
			}
			this.saving = section
			try {
				const snapshot = await updateAdminSettings(patch)
				this.applySnapshot(snapshot)
				showSuccess(t('playbacksync', 'Saved'))
				return true
			} catch (error) {
				logger.error('Failed to save admin settings', { error, section })
				const message = extractErrorMessage(error) ?? t('playbacksync', 'Could not save settings.')
				showError(message)
				return false
			} finally {
				this.saving = null
			}
		},

		async regenerateSecret(): Promise<boolean> {
			this.regenerating = true
			try {
				this.secret = await regenerateAdminSecret()
				showSuccess(t('playbacksync', 'Admin secret regenerated'))
				return true
			} catch (error) {
				logger.error('Failed to regenerate admin secret', { error })
				showError(t('playbacksync', 'Could not regenerate admin secret.'))
				return false
			} finally {
				this.regenerating = false
			}
		},

		applySnapshot(snapshot: AdminSettingsSnapshot) {
			this.wsTuning = { ...snapshot.wsTuning }
			this.daemon = { ...snapshot.daemon }
			this.rooms = { ...snapshot.rooms }
			this.secret = { ...snapshot.secret }
		},

		collectSection(section: AdminSettingsSection): AdminSettingsPatch | null {
			if (section === 'wsTuning' && this.wsTuning) {
				return stripNulls(this.wsTuning)
			}
			if (section === 'daemon' && this.daemon) {
				return stripNulls(this.daemon)
			}
			if (section === 'rooms' && this.rooms) {
				return stripNulls(this.rooms)
			}
			return null
		},
	},
})

/**
 * Drop keys whose value is `null` from a settings section before it becomes a
 * patch. The server validator rejects null values outright, and a `null` here
 * only means "admin hasn't filled in this field yet" — there is nothing to
 * persist. Returning a fresh object avoids leaking the store's reactive proxy
 * into the network layer.
 *
 * @param section the loaded section from the store, which may contain nulls
 * @return a patch with all null-valued keys removed
 */
function stripNulls<T extends Record<string, unknown>>(section: T): AdminSettingsPatch {
	const patch: Record<string, unknown> = {}
	for (const [key, value] of Object.entries(section)) {
		if (value !== null) {
			patch[key] = value
		}
	}
	return patch as AdminSettingsPatch
}

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
