import type { CreatedRoom, Room } from '../types/room.ts'
import type { ShareCopyFormat } from '../types/userSettings.ts'

/**
 * Render a human-friendly title for a room, falling back to the first eight
 * hex characters of the UUID when the user didn't pick a name. Mirrors the
 * title rendered on the room card so the clipboard text matches what the
 * user sees in the UI.
 *
 * @param room any room shape that carries `name` and `uuid`
 * @return the display title — never empty
 */
export function roomTitle(room: Pick<Room, 'name' | 'uuid'>): string {
	return room.name?.trim() || room.uuid.replace(/-/g, '').slice(0, 8)
}

/**
 * Format a room's share link for the clipboard according to the user's
 * preferred share-copy format. The password is not known at this point —
 * use `formatCreatedRoom` for the post-creation context where it is.
 *
 * @param room   the room providing `shareLink`, `name`, and `uuid`
 * @param format the user's preferred share-copy format
 * @return the string to write to the clipboard
 */
export function formatShareLink(room: Room, format: ShareCopyFormat): string {
	switch (format) {
		case 'markdown':
			return `[${roomTitle(room)}](${room.shareLink})`
		case 'discord':
			// Wrapping in `<…>` suppresses Discord's automatic link preview.
			return `<${room.shareLink}>`
		case 'link':
		default:
			return room.shareLink
	}
}

/**
 * Format a freshly created room's link AND password for the clipboard, in
 * the user's preferred style. Used by the post-creation dialog where the
 * plaintext password is briefly available.
 *
 * @param room   the created room providing `shareLink`, `password`, `name`, `uuid`
 * @param format the user's preferred share-copy format
 * @return the multi-line string to write to the clipboard
 */
export function formatCreatedRoom(room: CreatedRoom, format: ShareCopyFormat): string {
	const title = roomTitle(room)
	switch (format) {
		case 'markdown':
			return `**${title}**\n[${room.shareLink}](${room.shareLink})\nPassword: \`${room.password}\``
		case 'discord':
			return `**PlaybackSync Room**\n🔗 <${room.shareLink}>\n🔑 \`${room.password}\``
		case 'link':
		default:
			return `${room.shareLink}\nPassword: ${room.password}`
	}
}
