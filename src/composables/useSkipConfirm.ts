import type { Ref } from 'vue'

import { ref, watch } from 'vue'

export const SKIP_CONFIRM_DELETE_ROOM = 'playbacksync:confirm:delete-room'
export const SKIP_CONFIRM_KICK_CLIENT = 'playbacksync:confirm:kick-client'

/**
 * Reactive "skip this confirmation prompt" flag, backed by `localStorage`.
 *
 * When `true`, callers should bypass their confirmation dialog and run the
 * destructive action directly. Writes are persisted on every change; reads on
 * init come from `localStorage` and fall back to `false` when no value is set
 * or the storage API throws (private mode, SSR, disabled cookies).
 *
 * @param storageKey the localStorage key to read and write
 * @return a two-way reactive boolean; assignments propagate to localStorage
 */
export function useSkipConfirm(storageKey: string): Ref<boolean> {
	const skip = ref(readInitial(storageKey))

	watch(skip, (value) => {
		try {
			window.localStorage.setItem(storageKey, value ? '1' : '0')
		} catch {
			// localStorage may be unavailable (private mode, SSR); preference is in-memory only.
		}
	})

	return skip
}

/**
 * Pull the persisted flag from `localStorage`, defaulting to `false` when no
 * value is stored or the storage API throws.
 *
 * @param storageKey the key to read
 * @return the resolved initial skip state
 */
function readInitial(storageKey: string): boolean {
	try {
		return window.localStorage.getItem(storageKey) === '1'
	} catch {
		return false
	}
}
