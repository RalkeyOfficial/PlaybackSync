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
	restartDaemon as restartDaemonRequest,
	updateAdminSettings,
} from '../services/adminSettingsApi.ts'
import { fetchWsStatus } from '../services/wsStatusApi.ts'
import { useWsStatusStore } from './wsStatus.ts'

const logger = getLoggerBuilder().setApp('playbacksync').detectUser().build()

// After accepting the restart the daemon exits ~0.25s later; wait past that so
// we poll the fresh process, not the one on its way out. Then poll the status
// endpoint until the supervisor has the new daemon up (or give up).
const RESTART_GRACE_MS = 2_000
const RESTART_POLL_INTERVAL_MS = 1_000
const RESTART_POLL_ATTEMPTS = 20

/**
 * Resolve after the given delay. Used to space out the restart-readiness poll.
 *
 * @param ms milliseconds to wait
 * @return a promise that resolves once the delay elapses
 */
function delay(ms: number): Promise<void> {
	return new Promise((resolve) => {
		window.setTimeout(resolve, ms)
	})
}

interface AdminSettingsState {
	wsTuning: WsTuningSettings | null
	daemon: DaemonSettings | null
	rooms: RoomSettings | null
	secret: AdminSecretInfo | null
	loaded: boolean
	loading: boolean
	saving: AdminSettingsSection | null
	regenerating: boolean
	restarting: boolean
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
		restarting: false,
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

		/**
		 * Ask the daemon to restart, then wait for it to come back.
		 *
		 * The POST only triggers a graceful exit; the daemon returns only if an
		 * external supervisor restarts it. So after a grace delay (long enough
		 * for the old process to be gone) we poll the WS status endpoint until it
		 * reports available again, refresh the shared status store so the badge
		 * updates, and surface success. A timeout means there is almost certainly
		 * no supervisor — say so.
		 *
		 * @return true once the daemon is confirmed back up; false on a transport
		 *         failure or if it never came back within the poll window
		 */
		async restartDaemon(): Promise<boolean> {
			this.restarting = true
			try {
				try {
					await restartDaemonRequest()
				} catch (error) {
					logger.error('Failed to request daemon restart', { error })
					const message = extractErrorMessage(error) ?? t('playbacksync', 'Could not restart the WebSocket daemon.')
					showError(message)
					return false
				}

				await delay(RESTART_GRACE_MS)

				const wsStatus = useWsStatusStore()
				for (let attempt = 0; attempt < RESTART_POLL_ATTEMPTS; attempt++) {
					try {
						const status = await fetchWsStatus()
						if (status.available) {
							await wsStatus.load()
							showSuccess(t('playbacksync', 'WebSocket daemon restarted'))
							return true
						}
					} catch (error) {
						// Expected while the daemon is down between processes — keep polling.
						logger.debug('WS status poll failed during restart', { error })
					}
					await delay(RESTART_POLL_INTERVAL_MS)
				}

				await wsStatus.load()
				showError(t('playbacksync', 'The daemon did not come back online. It only restarts automatically when run under a supervisor (Docker Compose with restart: unless-stopped, systemd, etc.). See the operator guide.'))
				return false
			} finally {
				this.restarting = false
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
