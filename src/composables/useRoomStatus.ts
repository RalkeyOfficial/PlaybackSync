import type { RoomLiveState } from '../types/room.ts'

import { translate as t } from '@nextcloud/l10n'

export type RoomStatusVariant = 'success' | 'info' | 'warning' | 'pending' | 'neutral'

export interface RoomStatus {
	variant: RoomStatusVariant
	label: string
}

/**
 * Derive the at-a-glance status of a room from its TTL and live state.
 *
 * The mapping prefers the most actionable state: an expired room is always
 * grey regardless of any stale live payload; a non-null `live` block with
 * no content identity is "Nothing playing" before we look at playerState,
 * because playerState is meaningless without a loaded video. `live === null`
 * is the normal empty-room state (no daemon runtime for this uuid), not a
 * daemon-down indicator — that is handled separately by the global
 * "Sync server unavailable" banner.
 *
 * @param input the room fields needed for status — its live block (or null
 *        when the daemon has no runtime for this room) and its expiry
 *        timestamp.
 * @param input.live the live state block, or null when the daemon has no
 *        runtime for this room (empty / never-joined / daemon-down).
 * @param input.expiresAt unix-millisecond timestamp at which the room
 *        becomes invalid.
 * @param now current unix-millisecond timestamp (pass `useNow().value`).
 * @return the StatusDot variant and a localized label suitable for use as
 *         an aria-label or in an adjacent text span.
 */
export function getRoomStatus(
	input: { live: RoomLiveState | null, expiresAt: number },
	now: number,
): RoomStatus {
	if (input.expiresAt <= now) {
		return { variant: 'neutral', label: t('playbacksync', 'Expired') }
	}
	const live = input.live
	if (!live || !live.contentIdentity) {
		return { variant: 'warning', label: t('playbacksync', 'Nothing playing') }
	}
	switch (live.playerState) {
		case 'playing':
			return { variant: 'success', label: t('playbacksync', 'Playing') }
		case 'paused':
			return { variant: 'info', label: t('playbacksync', 'Paused') }
		case 'buffering':
			return { variant: 'pending', label: t('playbacksync', 'Buffering') }
		default:
			return { variant: 'neutral', label: t('playbacksync', 'Idle') }
	}
}
