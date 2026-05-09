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
	loading: boolean
	loaded: boolean
}

export const useWsStatusStore = defineStore('wsStatus', {
	state: (): WsStatusState => ({
		available: null,
		loading: false,
		loaded: false,
	}),

	getters: {
		// Convenience: only block actions when we definitively know the
		// service is unavailable — not while we're still checking.
		isUnavailable: (state): boolean => state.loaded && state.available === false,
		isAvailable: (state): boolean => state.loaded && state.available === true,
	},

	actions: {
		async load() {
			this.loading = true
			try {
				this.available = await fetchWsStatus()
				this.loaded = true
			} catch (error) {
				// Treat any failure to fetch the status as "unavailable" —
				// if the endpoint is unreachable the rest of the app
				// almost certainly is too, but we still want the badge to
				// show a clear unavailable state instead of staying in
				// limbo.
				logger.error('Failed to fetch WS status', { error })
				this.available = false
				this.loaded = true
			} finally {
				this.loading = false
			}
		},
	},
})
