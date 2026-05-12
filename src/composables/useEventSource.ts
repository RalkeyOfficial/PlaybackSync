import type { Ref } from 'vue'
import type { EventLogEntry, EventStreamMeta, EventStreamState } from '../types/event.ts'

import { onScopeDispose, ref, shallowRef } from 'vue'

interface UseEventSourceOptions {
	/** Hard cap on the in-memory event list to bound browser memory. */
	maxEvents?: number
}

interface UseEventSourceHandle {
	state: Ref<EventStreamState>
	events: Ref<EventLogEntry[]>
	meta: Ref<EventStreamMeta | null>
	/** True after at least one error fired and we're in EventSource's backoff. */
	degraded: Ref<boolean>
	/** Start the stream. Idempotent — opening an already-open stream is a no-op. */
	start: () => void
	/** Close and detach all listeners. Idempotent. */
	stop: () => void
}

/**
 * Wrap `EventSource` for an SSE endpoint that emits `event: event` records
 * carrying our `EventLogEntry` envelope and an `event: meta` opening record.
 *
 * The composable surfaces reactive `state`, an append-only `events` array
 * capped at `maxEvents`, and a `meta` ref populated on each connect. The
 * browser's built-in reconnect is left alone — we just observe its state
 * transitions through `onopen` / `onerror`.
 *
 * Lifetime is caller-driven via `start()` / `stop()` so a parent component
 * can open the stream lazily when a tab becomes active and close it when
 * the user navigates away — the auto-dispose hook here is a safety net.
 *
 * @param urlFactory called each `start()` so callers can vary the URL
 *                   (e.g. swap rooms) without recreating the composable
 * @param options    optional `maxEvents` (default 500)
 * @return reactive handle plus `start`/`stop` controls
 */
export function useEventSource(
	urlFactory: () => string,
	options: UseEventSourceOptions = {},
): UseEventSourceHandle {
	const maxEvents = options.maxEvents ?? 500

	const state = ref<EventStreamState>('closed')
	const events = shallowRef<EventLogEntry[]>([])
	const meta = ref<EventStreamMeta | null>(null)
	const degraded = ref(false)

	let source: EventSource | null = null

	/**
	 * Push a new envelope onto the reactive list, evicting the oldest when
	 * the cap is exceeded so the UI never has to render an unbounded list.
	 *
	 * Dedupes by `id` so a daemon backfill that overlaps with what we've
	 * already seen — e.g. after a reconnect race — doesn't surface as a
	 * duplicate row.
	 *
	 * @param entry the freshly-decoded event envelope from the stream
	 */
	function appendEvent(entry: EventLogEntry) {
		const existing = events.value
		if (existing.length > 0 && existing[existing.length - 1].id >= entry.id) {
			// Fast-path: out-of-order or repeat of the most recent id. Confirm
			// by scanning the (small) tail; ids are monotonic so anything older
			// than the latest entry's id is by definition a dupe.
			for (let i = existing.length - 1; i >= 0 && existing[i].id >= entry.id; i--) {
				if (existing[i].id === entry.id) {
					return
				}
			}
		}
		const next = existing.concat(entry)
		// Bound memory: drop the oldest when we exceed the cap. ShallowRef means
		// Vue re-renders on assignment; in-place mutation wouldn't notify.
		events.value = next.length > maxEvents
			? next.slice(next.length - maxEvents)
			: next
	}

	/**
	 * Open the EventSource and wire up listeners. Idempotent so callers can
	 * safely call from a `watch(immediate: true)` and again on tab switches.
	 *
	 * Resets the in-memory buffer because a fresh connect (no `Last-Event-ID`
	 * yet) causes the daemon to backfill the whole ring — appending that to a
	 * leftover list from a previous session would surface as duplicate rows.
	 */
	function start(): void {
		if (source !== null) {
			return
		}
		events.value = []
		meta.value = null
		state.value = 'connecting'

		const es = new EventSource(urlFactory(), { withCredentials: true })
		source = es

		es.onopen = () => {
			state.value = 'open'
			degraded.value = false
		}

		es.addEventListener('meta', (event: MessageEvent) => {
			try {
				meta.value = JSON.parse(event.data) as EventStreamMeta
			} catch {
				// Drop a malformed meta — the stream stays open.
			}
		})

		es.addEventListener('event', (event: MessageEvent) => {
			try {
				appendEvent(JSON.parse(event.data) as EventLogEntry)
			} catch {
				// Drop a malformed entry rather than tearing down the stream.
			}
		})

		es.onerror = () => {
			// EventSource transitions to its own retry state; we surface it.
			degraded.value = true
			if (es.readyState === EventSource.CLOSED) {
				state.value = 'closed'
			} else {
				state.value = 'error'
			}
		}
	}

	/**
	 * Close the EventSource and clear the local reference. The reactive
	 * `events` array is preserved so the UI can keep showing the last batch
	 * after the stream is closed.
	 */
	function stop(): void {
		if (source !== null) {
			source.close()
			source = null
		}
		state.value = 'closed'
	}

	onScopeDispose(stop)

	return { state, events, meta, degraded, start, stop }
}
