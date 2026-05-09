import type { CreatedRoom, CreateRoomPayload, Room } from '../types/room.ts'

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
