import type { PlaybackAction } from '../services/roomsApi.ts'
import type { CreatedRoom, CreateRoomPayload, Room, RoomLiveState } from '../types/room.ts'

import { showError } from '@nextcloud/dialogs'
import { translate as t } from '@nextcloud/l10n'
import { getLoggerBuilder } from '@nextcloud/logger'
import { defineStore } from 'pinia'
import {
	createRoom,
	deleteRoom,
	kickRoomClient,
	listRooms,
	sendPlaybackCommand,
} from '../services/roomsApi.ts'

const logger = getLoggerBuilder().setApp('playbacksync').detectUser().build()

interface RoomsState {
	rooms: Room[]
	loading: boolean
	creating: boolean
	loaded: boolean
	lastCreated: CreatedRoom | null
}

export const useRoomsStore = defineStore('rooms', {
	state: (): RoomsState => ({
		rooms: [],
		loading: false,
		creating: false,
		loaded: false,
		lastCreated: null,
	}),

	actions: {
		async load() {
			this.loading = true
			try {
				this.rooms = await listRooms()
				this.loaded = true
			} catch (error) {
				logger.error('Failed to load rooms', { error })
				showError(t('playbacksync', 'Could not load rooms.'))
			} finally {
				this.loading = false
			}
		},

		async refresh() {
			// Silent refresh: keeps `loading` untouched so the empty-state spinner
			// and any disabled-button states tied to it do not flicker on every
			// tick, and swallows transient errors so we do not toast on every
			// failed poll.
			try {
				this.rooms = await listRooms()
				this.loaded = true
			} catch (error) {
				logger.error('Failed to refresh rooms', { error })
			}
		},

		async create(payload: CreateRoomPayload): Promise<boolean> {
			this.creating = true
			try {
				const created = await createRoom(payload)
				this.rooms = [created, ...this.rooms]
				this.lastCreated = created
				return true
			} catch (error) {
				const message = extractErrorMessage(error) ?? t('playbacksync', 'Could not create room.')
				showError(message)
				return false
			} finally {
				this.creating = false
			}
		},

		async remove(uuid: string): Promise<boolean> {
			try {
				await deleteRoom(uuid)
				this.rooms = this.rooms.filter((r) => r.uuid !== uuid)
				return true
			} catch (error) {
				logger.error('Failed to delete room', { error })
				showError(t('playbacksync', 'Could not delete room.'))
				return false
			}
		},

		async kickClient(uuid: string, clientId: string): Promise<boolean> {
			try {
				await kickRoomClient(uuid, clientId)
				return true
			} catch (error) {
				logger.error('Failed to kick client', { error, uuid, clientId })
				const message = extractErrorMessage(error) ?? t('playbacksync', 'Could not disconnect client.')
				showError(message)
				return false
			}
		},

		/**
		 * Send an owner-initiated playback command and optimistically reflect
		 * the new state in the local room model. On API failure the snapshot
		 * is restored; on success we trigger a `refresh()` to reconcile with
		 * the daemon's authoritative state.
		 *
		 * @param uuid     the room's UUID
		 * @param action   one of `play`, `pause`, `seek`, `reset`
		 * @param videoPos target position in seconds; required for `seek`
		 * @return true on success, false on any failure (toast already shown)
		 */
		async sendPlaybackCommand(
			uuid: string,
			action: PlaybackAction,
			videoPos?: number,
		): Promise<boolean> {
			const room = this.rooms.find((r) => r.uuid === uuid)
			const snapshot: RoomLiveState | null = room?.live ? { ...room.live } : null

			if (room?.live) {
				applyOptimisticPlayback(room.live, action, videoPos)
			}

			try {
				await sendPlaybackCommand(uuid, action, videoPos)
				// Reconcile with daemon truth — fire-and-forget so the caller
				// doesn't have to await two round-trips before re-enabling
				// buttons.
				void this.refresh()
				return true
			} catch (error) {
				if (room && snapshot !== null) {
					room.live = snapshot
				}
				logger.error('Failed to send playback command', { error, uuid, action, videoPos })

				const status = extractStatus(error)
				if (status === 409) {
					showError(t('playbacksync', 'No clients are connected to this room yet.'))
				} else {
					const message = extractErrorMessage(error)
						?? t('playbacksync', 'Could not send playback command.')
					showError(message)
				}
				return false
			}
		},

		dismissLastCreated() {
			this.lastCreated = null
		},
	},
})

/**
 * Patch a room's live state in place to reflect a freshly-sent playback
 * command, before the daemon confirms it. Only the fields that change for a
 * given action are touched.
 *
 * @param live     the room's live state (mutated in place)
 * @param action   the command that was just sent
 * @param videoPos target position for `seek`
 */
function applyOptimisticPlayback(
	live: RoomLiveState,
	action: PlaybackAction,
	videoPos?: number,
): void {
	switch (action) {
		case 'play':
			live.playerState = 'playing'
			break
		case 'pause':
			live.playerState = 'paused'
			break
		case 'seek':
			if (videoPos !== undefined) {
				live.videoPos = videoPos
			}
			break
		case 'reset':
			live.playerState = 'paused'
			live.videoPos = 0
			break
	}
}

/**
 * Extract an HTTP status code from an axios failure, when one is present.
 *
 * @param error the value caught from a failed axios call
 * @return the status code, or null if none could be extracted
 */
function extractStatus(error: unknown): number | null {
	if (typeof error === 'object' && error !== null && 'response' in error) {
		const response = (error as { response?: { status?: number } }).response
		if (typeof response?.status === 'number') {
			return response.status
		}
	}
	return null
}

/**
 * Pull the server-supplied error message out of an axios failure, when one
 * is present. Returns null for non-axios errors or responses without a body
 * `error` field, so the caller can fall back to a generic toast.
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
