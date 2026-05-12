import type { Room } from '../types/room.ts'
import type { RoomsSortOrder } from '../types/userSettings.ts'

import { roomTitle } from './useShareCopy.ts'

/**
 * Return a new array with the rooms ordered according to the user's
 * preferred sort. Always returns a copy — never mutates the input — so
 * Vue reactivity tracking on the original list stays intact.
 *
 * Sort orders:
 * - `newest`:    most recently created first (server's natural order)
 * - `oldest`:    least recently created first
 * - `name`:      alphabetical by display title (name with UUID fallback)
 * - `expiring`:  soonest-to-expire first
 *
 * @param rooms the source list, untouched on return
 * @param order the user's preferred ordering
 * @return a freshly sorted copy of `rooms`
 */
export function sortRooms(rooms: Room[], order: RoomsSortOrder): Room[] {
	const copy = [...rooms]
	switch (order) {
		case 'oldest':
			return copy.sort((a, b) => a.createdAt - b.createdAt)
		case 'name':
			return copy.sort((a, b) => roomTitle(a).localeCompare(roomTitle(b)))
		case 'expiring':
			return copy.sort((a, b) => a.expiresAt - b.expiresAt)
		case 'newest':
		default:
			return copy.sort((a, b) => b.createdAt - a.createdAt)
	}
}
