import { onScopeDispose, ref } from 'vue'

const now = ref(Date.now())
let intervalId: ReturnType<typeof setInterval> | null = null
let refCount = 0

/**
 * Provide a shared, reactive `Date.now()` ref that ticks every second.
 *
 * A single `setInterval` is shared across all callers; it is started on the
 * first subscriber and torn down when the last subscriber's effect scope is
 * disposed, so unmounted cards stop driving updates.
 *
 * @return a Vue ref whose value is the current unix-millisecond timestamp,
 *         updated once per second
 */
export function useNow() {
	refCount++
	if (intervalId === null) {
		intervalId = setInterval(() => {
			now.value = Date.now()
		}, 1000)
	}

	onScopeDispose(() => {
		refCount--
		if (refCount === 0 && intervalId !== null) {
			clearInterval(intervalId)
			intervalId = null
		}
	})

	return now
}
