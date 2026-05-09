import type { CreatedRoom, CreateRoomPayload, Room } from '../types/room.ts'

import { showError } from '@nextcloud/dialogs'
import { translate as t } from '@nextcloud/l10n'
import { getLoggerBuilder } from '@nextcloud/logger'
import { defineStore } from 'pinia'
import { createRoom, deleteRoom, listRooms } from '../services/roomsApi.ts'

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

		dismissLastCreated() {
			this.lastCreated = null
		},
	},
})

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
