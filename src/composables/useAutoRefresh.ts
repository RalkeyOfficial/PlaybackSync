import type { ComputedRef, Ref } from 'vue'

import { computed, onScopeDispose, ref, watch } from 'vue'

interface UseAutoRefreshOptions {
	intervalMs: number
	storageKey?: string
	defaultEnabled?: boolean
}

interface UseAutoRefreshHandle {
	enabled: Ref<boolean>
	isHidden: ComputedRef<boolean>
	progress: Ref<number>
	toggle: () => void
}

/**
 * Drive a callback on a fixed cadence while the document is visible, exposing
 * a 0..1 progress value that climbs toward the next tick so the UI can render
 * a fill animation (e.g. a progress ring).
 *
 * Behavior:
 * - On user toggle off, progress freezes at its current value. Toggling back
 *   on resumes from that frozen position — no immediate fire — so the
 *   pause/resume feels like a stopwatch the user controls.
 * - On document hidden, ticking pauses without firing. On becoming visible
 *   again while enabled, the callback fires once and progress resets to 0,
 *   because data is likely stale after the user was away.
 * - Optional `localStorage` persistence of the enabled flag.
 *
 * @param callback work to run on each completed cycle; may be async
 * @param options  cadence, optional persistence key, and default enabled state
 * @return reactive handles: `enabled` (two-way), `isHidden` (document
 *         visibility, true when the page is in the background), `progress`
 *         (0..1 toward the next tick), and `toggle` (flip the enabled flag)
 */
export function useAutoRefresh(
	callback: () => void | Promise<void>,
	options: UseAutoRefreshOptions,
): UseAutoRefreshHandle {
	const { intervalMs, storageKey, defaultEnabled = false } = options

	const enabled = ref(readInitialEnabled(storageKey, defaultEnabled))
	const hidden = ref(typeof document !== 'undefined' && document.visibilityState === 'hidden')
	const progress = ref(0)

	let rafId: number | null = null
	let lastFrameAt: number | null = null

	/**
	 * Reset the cycle: zero the progress, anchor a fresh delta baseline, and
	 * invoke the user callback. Used both at end-of-cycle and on
	 * become-visible-after-hidden.
	 */
	function fireAndReset() {
		progress.value = 0
		lastFrameAt = performance.now()
		void callback()
	}

	/**
	 * RAF callback: advance `progress` by the wall-clock delta since the
	 * previous frame, fire the cycle when progress crosses 1, and schedule
	 * the next frame. Skips work when the toggle is off or the tab is hidden.
	 */
	function tick() {
		rafId = null
		if (!enabled.value || hidden.value) {
			return
		}
		const now = performance.now()
		const delta = lastFrameAt === null ? 0 : now - lastFrameAt
		lastFrameAt = now
		const next = progress.value + delta / intervalMs
		if (next >= 1) {
			fireAndReset()
		} else {
			progress.value = next
		}
		scheduleTick()
	}

	/**
	 * Queue the next animation frame, guarding against double-scheduling so
	 * the visibility/enabled handlers can call this idempotently.
	 */
	function scheduleTick() {
		if (rafId !== null) {
			return
		}
		rafId = requestAnimationFrame(tick)
	}

	/**
	 * Cancel any pending frame and drop the delta anchor. Leaves
	 * `progress.value` untouched so a paused ring stays at its frozen
	 * position until ticking resumes.
	 */
	function stop() {
		if (rafId !== null) {
			cancelAnimationFrame(rafId)
			rafId = null
		}
		lastFrameAt = null
	}

	const onVisibilityChange = () => {
		const isHidden = document.visibilityState === 'hidden'
		hidden.value = isHidden
		if (isHidden) {
			stop()
			return
		}
		if (enabled.value) {
			fireAndReset()
			scheduleTick()
		}
	}

	if (typeof document !== 'undefined') {
		document.addEventListener('visibilitychange', onVisibilityChange)
	}

	watch(
		enabled,
		(value) => {
			if (value) {
				// Resume from whatever progress was at: 0 on first mount,
				// or the frozen value if the user is un-pausing.
				lastFrameAt = performance.now()
				if (!hidden.value) {
					scheduleTick()
				}
			} else {
				stop()
				// progress.value retained intentionally
			}
			if (storageKey) {
				try {
					window.localStorage.setItem(storageKey, value ? '1' : '0')
				} catch {
					// localStorage may be unavailable (private mode, SSR); preference is in-memory only.
				}
			}
		},
		{ immediate: true },
	)

	onScopeDispose(() => {
		stop()
		if (typeof document !== 'undefined') {
			document.removeEventListener('visibilitychange', onVisibilityChange)
		}
	})

	const isHidden = computed(() => hidden.value)
	const toggle = () => {
		enabled.value = !enabled.value
	}

	return { enabled, isHidden, progress, toggle }
}

/**
 * Pull the persisted enabled flag from `localStorage`, falling back to the
 * provided default when no value is stored or the storage API throws (Safari
 * private mode, SSR, disabled cookies).
 *
 * @param storageKey     the key to read, or undefined to skip persistence
 * @param defaultEnabled the value to return when no persisted value is found
 * @return the resolved initial enabled state
 */
function readInitialEnabled(storageKey: string | undefined, defaultEnabled: boolean): boolean {
	if (!storageKey) {
		return defaultEnabled
	}
	try {
		const raw = window.localStorage.getItem(storageKey)
		if (raw === '1') {
			return true
		}
		if (raw === '0') {
			return false
		}
	} catch {
		// Fall through to default.
	}
	return defaultEnabled
}
