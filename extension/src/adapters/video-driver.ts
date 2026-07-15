import type { LocalIntent, VideoState } from './types'

/**
 * Pure, DOM-level mechanics shared by every adapter through {@link ../base.BaseAdapter}.
 *
 * These are the parts that were byte-for-byte identical across adapters (the
 * buffering read, the intent-listener wiring, the observe-and-wait pattern).
 * Keeping them here — free of adapter state — means there is exactly one
 * implementation of each, and each can be unit-tested without constructing an
 * adapter.
 */

/**
 * `HTMLMediaElement.readyState` threshold for "the next frame is available".
 * Below `HAVE_FUTURE_DATA` (3) a non-paused video is actually waiting on data,
 * i.e. buffering, rather than playing.
 */
const HAVE_FUTURE_DATA = 3

/**
 * Read a `<video>` element's current playback state in the wire-format shape.
 * A paused video is always `'paused'` (even mid-buffer); a playing video whose
 * `readyState` hasn't reached {@link HAVE_FUTURE_DATA} is `'buffering'`.
 *
 * @param video The player element to sample.
 * @returns The current position and coarse player state.
 */
export function readVideoState(video: HTMLVideoElement): VideoState {
	const buffering = !video.paused && video.readyState < HAVE_FUTURE_DATA
	return {
		currentPos: video.currentTime,
		playerState: buffering ? 'buffering' : video.paused ? 'paused' : 'playing',
	}
}

/**
 * Attach the standard `play` / `pause` / `seeking` listeners that translate a
 * user's action on the video into a {@link LocalIntent} carrying the current
 * playhead. Listeners are bound with `{ signal }`, so the base adapter's
 * `destroy()` (which aborts that signal) removes them automatically — no
 * manual bookkeeping.
 *
 * @param video The player element to observe.
 * @param emit Sink for the derived intent (the base forwards to
 *   `AdapterContext.emitIntent`).
 * @param signal Abort signal that detaches all three listeners when aborted.
 */
export function wireIntentListeners(
	video: HTMLVideoElement,
	emit: (intent: LocalIntent) => void,
	signal: AbortSignal,
): void {
	const bind = (type: LocalIntent['type'], event: keyof HTMLMediaElementEventMap) => {
		video.addEventListener(event, () => emit({ type, time: video.currentTime }), { signal })
	}
	bind('play', 'play')
	bind('pause', 'pause')
	bind('seek', 'seeking')
}

/**
 * Resolve to the first element matching `selector`, or `null` after
 * `timeoutMs`, or `null` when `signal` aborts. Checks synchronously first,
 * then watches with a `MutationObserver`; the observer and timer are torn
 * down on whichever of resolve / timeout / abort happens first.
 *
 * `signal` is load-bearing, not just for teardown: a caller can short-circuit
 * the wait on an unrelated event by wiring that event to `AbortController.abort`
 * and passing its signal here (miruro aborts its manual-load-button wait on the
 * video's `loadstart`). An already-aborted signal resolves to `null` immediately.
 *
 * @param selector CSS selector to resolve against `root`.
 * @param opts.timeoutMs How long to wait before giving up with `null`.
 * @param opts.root Subtree to query and observe. Defaults to `document.body`.
 * @param opts.signal Abort signal; resolves `null` and tears down when aborted.
 * @returns The first matching element, or `null` on timeout / abort.
 */
export function waitForElement<T extends Element>(
	selector: string,
	opts: { timeoutMs: number; root?: ParentNode; signal: AbortSignal },
): Promise<T | null> {
	const root = opts.root ?? document.body
	const immediate = root.querySelector<T>(selector)
	if (immediate) return Promise.resolve(immediate)
	if (opts.signal.aborted) return Promise.resolve(null)

	return new Promise<T | null>((resolve) => {
		const finish = (el: T | null) => {
			observer.disconnect()
			clearTimeout(timer)
			opts.signal.removeEventListener('abort', onAbort)
			resolve(el)
		}
		const onAbort = () => finish(null)

		const observer = new MutationObserver(() => {
			const el = root.querySelector<T>(selector)
			if (el) finish(el)
		})
		observer.observe(root, { childList: true, subtree: true })

		const timer = setTimeout(() => finish(null), opts.timeoutMs)
		opts.signal.addEventListener('abort', onAbort, { once: true })
	})
}
