import type { PlaylistEntry } from '../types/room.ts'

import axios from '@nextcloud/axios'
import { generateUrl } from '@nextcloud/router'

/**
 * Wire shape of `GET /api/v1/rooms/{uuid}/playlist` and the response
 * of `POST /api/v1/rooms/{uuid}/playlist/entries`. `playlistVersion`
 * is a hash over the entries that callers compare against the last
 * snapshot they saw, so a redundant reconcile can be skipped.
 */
export interface PlaylistSnapshot {
	entries: PlaylistEntry[]
	cursorEntryId: string | null
	playlistVersion: string
}

/**
 * Payload accepted by `POST /api/v1/rooms/{uuid}/playlist/entries` —
 * the dashboard "add curated entry" form supplies these fields. The
 * server assigns `entryId`, `position`, `addedAt`, etc.
 */
export interface AddPlaylistEntryPayload {
	providerId: string
	videoId: string
	pageUrl: string
	label?: string | null
	episodeNumber?: number | null
	seasonNumber?: number | null
}

function roomUrl(uuid: string, path: string = ''): string {
	return generateUrl('/apps/playbacksync/api/v1/rooms/' + encodeURIComponent(uuid) + path)
}

/**
 * Flip one or both mode toggles. `singleMode` and `freeformMode` are
 * mutually exclusive; the server rejects `(true, true)` with HTTP 400
 * `toggle_conflict`.
 *
 * @param uuid the room's UUID
 * @param singleMode new value for the `singleMode` toggle, or `null` to leave it alone
 * @param freeformMode new value for the `freeformMode` toggle, or `null` to leave it alone
 */
export async function updateRoomSettings(
	uuid: string,
	singleMode: boolean | null,
	freeformMode: boolean | null,
): Promise<void> {
	const body: { singleMode?: boolean | null, freeformMode?: boolean | null } = {}
	if (singleMode !== null) body.singleMode = singleMode
	if (freeformMode !== null) body.freeformMode = freeformMode
	await axios.post(roomUrl(uuid, '/settings'), body)
}

/**
 * Add one curated entry to the room's playlist. Rejected with 409
 * `single_mode_locked` when the room is in single mode.
 *
 * @param uuid the room's UUID
 * @param entry the curated entry to add (server fills the rest)
 * @return the full playlist snapshot after the merge
 */
export async function addPlaylistEntry(uuid: string, entry: AddPlaylistEntryPayload): Promise<PlaylistSnapshot> {
	const { data } = await axios.post<PlaylistSnapshot>(roomUrl(uuid, '/playlist/entries'), entry)
	return data
}

/**
 * Remove an entry from the playlist. Rejected with 409
 * `single_mode_locked` in single mode, or `cursor_locked_entry` when
 * the entry is the current cursor.
 *
 * @param uuid the room's UUID
 * @param entryId the entry to remove
 */
export async function removePlaylistEntry(uuid: string, entryId: string): Promise<void> {
	await axios.delete(roomUrl(uuid, '/playlist/entries/' + encodeURIComponent(entryId)))
}

/**
 * Move the cursor to an existing playlist entry. Same reaction matrix
 * as the WS `CURSOR_CHANGE_REQUEST` — single-mode locks rejects with
 * 409, default-mode unknown entries with 400 `not_in_playlist`.
 *
 * @param uuid the room's UUID
 * @param targetEntryId the entry to set as the cursor
 */
export async function setRoomCursor(uuid: string, targetEntryId: string): Promise<void> {
	await axios.post(roomUrl(uuid, '/cursor'), { targetEntryId })
}

/**
 * Fetch the room's full playlist. Used to refresh the dashboard
 * picker after a `cursor_change` / `playlist_update` SSE event or on
 * detail-dialog open.
 *
 * @param uuid the room's UUID
 */
export async function getRoomPlaylist(uuid: string): Promise<PlaylistSnapshot> {
	const { data } = await axios.get<PlaylistSnapshot>(roomUrl(uuid, '/playlist'))
	return data
}
