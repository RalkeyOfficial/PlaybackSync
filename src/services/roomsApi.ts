import type { CreatedRoom, CreateRoomPayload, Room, RoomClientsResponse } from '../types/room.ts'

import axios from '@nextcloud/axios'
import { generateUrl } from '@nextcloud/router'

/**
 * Build an absolute URL to the rooms REST API, optionally appending a sub-path.
 *
 * @param path sub-path appended to `/apps/playbacksync/api/v1/rooms`, e.g. `/{uuid}`
 * @return the URL the Nextcloud router expects, ready to pass to axios
 */
function apiUrl(path: string = ''): string {
	return generateUrl('/apps/playbacksync/api/v1/rooms' + path)
}

/**
 * Fetch the current user's active (non-expired) rooms.
 *
 * @return the list of rooms the server returned
 */
export async function listRooms(): Promise<Room[]> {
	const { data } = await axios.get<{ rooms: Room[] }>(apiUrl())
	return data.rooms
}

/**
 * Fetch a single room by UUID. Used by the detail dialog to ensure the
 * `live` block (presence, playback, content identity) reflects the
 * daemon's *current* state at the moment the dialog opens, not whatever
 * was cached in the rooms list.
 *
 * @param uuid the room's UUID
 * @return the room as the server sees it right now
 */
export async function getRoom(uuid: string): Promise<Room> {
	const { data } = await axios.get<Room>(apiUrl('/' + encodeURIComponent(uuid)))
	return data
}

/**
 * Create a new room. The plaintext password is included in the response and
 * must be presented to the owner exactly once — it is not stored server-side.
 *
 * @param payload the create-room form values
 * @return the created room with its one-time password attached
 */
export async function createRoom(payload: CreateRoomPayload): Promise<CreatedRoom> {
	const { data } = await axios.post<CreatedRoom>(apiUrl(), payload)
	return data
}

/**
 * Delete a room owned by the current user. Returns 204 with no body on success.
 *
 * @param uuid the room's UUID
 */
export async function deleteRoom(uuid: string): Promise<void> {
	await axios.delete(apiUrl('/' + encodeURIComponent(uuid)))
}

/**
 * Fetch the connected-client list for a single room. A focused, lower-overhead
 * payload than `listRooms` for callers that only need presence — e.g. a future
 * detail panel that polls more frequently than the rooms list refreshes.
 *
 * @param uuid the room's UUID
 * @return the connected count and per-client metadata, or zero/empty when the
 *         daemon is unreachable or the room has no live state
 */
export async function getRoomClients(uuid: string): Promise<RoomClientsResponse> {
	const { data } = await axios.get<RoomClientsResponse>(apiUrl('/' + encodeURIComponent(uuid) + '/clients'))
	return data
}

/**
 * Forcibly disconnect one connected client from a room owned by the current
 * user. The daemon sends the kicked client a final `KICKED` error frame and
 * blocks the same `clientId` from rejoining for a short window. Returns 204
 * with no body on success; any error from the server is propagated as the
 * underlying axios rejection so callers can branch on `response.status`.
 *
 * @param uuid the room's UUID
 * @param clientId the daemon-issued opaque hex client identifier to kick
 */
export async function kickRoomClient(uuid: string, clientId: string): Promise<void> {
	await axios.delete(apiUrl('/' + encodeURIComponent(uuid) + '/clients/' + encodeURIComponent(clientId)))
}

/** Owner-initiated playback commands the dashboard can send to the daemon. */
export type PlaybackAction = 'play' | 'pause' | 'seek' | 'reset'

/**
 * Send an owner-initiated playback command for a room owned by the current
 * user. The daemon mutates its authoritative playback state and broadcasts a
 * `STATE` frame to every connected client. Returns 204 with no body on
 * success; non-success responses surface as the underlying axios rejection so
 * callers can branch on `response.status` (404 = room missing, 409 = no live
 * runtime, 502 = daemon unreachable).
 *
 * @param uuid     the room's UUID
 * @param action   one of `play`, `pause`, `seek`, `reset`
 * @param videoPos target position in seconds; required for `seek`, ignored otherwise
 */
export async function sendPlaybackCommand(
	uuid: string,
	action: PlaybackAction,
	videoPos?: number,
): Promise<void> {
	const body: { action: PlaybackAction, videoPos?: number } = { action }
	if (videoPos !== undefined) {
		body.videoPos = videoPos
	}
	await axios.post(apiUrl('/' + encodeURIComponent(uuid) + '/playback'), body)
}
