import type { WsUnavailableReason } from '../services/wsStatusApi.ts'

import { getLoggerBuilder } from '@nextcloud/logger'
import { defineStore } from 'pinia'
import { fetchWsStatus } from '../services/wsStatusApi.ts'

const logger = getLoggerBuilder().setApp('playbacksync').detectUser().build()

interface WsStatusState {
	// null while we haven't asked yet; boolean once we have an answer.
	// Distinguishing "unknown" from "false" matters for the UI: a fresh
	// page load shouldn't disable the create button just because the
	// status request hasn't returned yet.
	available: boolean | null
	// null when available, or while we haven't asked yet. Otherwise carries
	// the server's explanation so the UI can branch on `not_installed` vs
	// `not_running`.
	reason: WsUnavailableReason | null
	loading: boolean
	loaded: boolean
}

export const useWsStatusStore = defineStore('wsStatus', {
	state: (): WsStatusState => ({
		available: null,
		reason: null,
		loading: false,
		loaded: false,
	}),

	getters: {
		// Convenience: only block actions when we definitively know the
		// service is unavailable — not while we're still checking.
		isUnavailable: (state): boolean => state.loaded && state.available === false,
		isAvailable: (state): boolean => state.loaded && state.available === true,
		isNotInstalled: (state): boolean => state.loaded && state.reason === 'not_installed',
		isNotRunning: (state): boolean => state.loaded && state.reason === 'not_running',
	},

	actions: {
		async load() {
			this.loading = true
			try {
				const status = await fetchWsStatus()
				this.available = status.available
				this.reason = status.reason
				this.loaded = true
			} catch (error) {
				// Treat any failure to fetch the status as "not installed" —
				// if we can't even reach our own controller, the rest of the
				// app almost certainly isn't working either, and the install
				// dialog's wording is the right one to surface (the running
				// dialog talks about a daemon that we'd have to assume exists).
				logger.error('Failed to fetch WS status', { error })
				this.available = false
				this.reason = 'not_installed'
				this.loaded = true
			} finally {
				this.loading = false
			}
		},
	},
})
