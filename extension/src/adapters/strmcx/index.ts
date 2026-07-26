import type { MediaAdapterFactory } from '../types'
import { MediaBaseAdapter } from '../media/base'
import { waitForElement } from '../video-driver'

/**
 * Host pattern for the strm.cx embed player (`strm.cx` + any subdomain). Kept
 * in sync with `EMBED_MATCHES` in `src/adapters/embed-matches.ts`, which scopes
 * where the media content script is injected — this predicate is the in-frame
 * confirmation that the injected frame really is a strm.cx player.
 */
const HOST_RE = /^(?:.*\.)?strm\.cx$/

/**
 * The embed frame is a dedicated player document — unlike a page site it has
 * no hero/trailer `<video>` to disambiguate — so a plain `video` selector is
 * safe here. Confirmed live (via the `debug-ext/` probe): inside
 * `https://strm.cx/?embed=1` the Vidstack `<video>` resolves this way and
 * carries a blob source at `readyState 4` within ~1 s, with no interaction.
 */
const VIDEO_SELECTOR = 'video'

/**
 * How long to wait for the embed's `<video>` to hydrate before giving up.
 * Timing out means this frame never produced a controllable player, which the
 * base treats as a hard failure (see {@link MediaBaseAdapter}) — the background
 * tears the room down unless another frame already owns the video.
 */
const VIDEO_WAIT_TIMEOUT_MS = 10_000

/**
 * Vidstack's play-button custom element inside the strm.cx embed. It is an
 * **overlay**: it sits on top of the `<video>` with higher precedence and hides
 * it until pressed. It is independent of the video's source — the `<video>`
 * self-loads its blob source on its own regardless of this button, and pressing
 * the button neither loads nor otherwise influences that source. Its sole effect
 * when pressed is to dismiss the overlay so the (already loaded) video becomes
 * visible and playable. The press only *functions* once a source is present,
 * though: pressed while the `<video>` is still sourceless it does nothing — so
 * a source is a precondition for a working press, not a reason to skip it (see
 * {@link StrmcxAdapter.ensurePlayable}). The full DOM path is
 * `#app > strmcx-player > media-player > media-play-button`; the bare tag is
 * used because it's the same element and survives the layout nesting churning
 * between player builds.
 */
const PLAY_BUTTON_SELECTOR = 'media-play-button'

/**
 * How long {@link StrmcxAdapter.ensurePlayable} waits for the play-button
 * overlay to mount before giving up. If it never appears there is no overlay to
 * dismiss, so activation is left to the user / room.
 */
const PLAY_BUTTON_WAIT_TIMEOUT_MS = 5_000

/**
 * Settle delay between the play button appearing and driving it. Vidstack
 * inserts the element into the DOM a few frames before its toggle handler is
 * fully wired (the responsive-layout pass + capability detection land a couple
 * hundred ms later); activating immediately reaches a no-op handler.
 */
const PLAY_BUTTON_SETTLE_MS = 300

/**
 * How long to wait for the `<video>` to self-load a source (so the overlay
 * press will actually function) before giving up. Bounds the worst case so a
 * player that never loads a source on its own can't hang activation.
 */
const LOAD_METADATA_TIMEOUT_MS = 5_000

/**
 * Gap between the synthesized `Space` keydown and keyup on the play button. A
 * synchronous keyup isn't registered as a release — the player then treats
 * Space as *held* and ramps playback to 2× (its hold-to-speed gesture). A short
 * delay lets the keyup land as a distinct release. ~10 ms was verified live to
 * clear the 2×; 30 ms adds event-loop-jitter margin while staying an order of
 * magnitude under any press-and-hold threshold.
 */
const KEY_RELEASE_DELAY_MS = 30

/**
 * Generic media adapter for the **strm.cx** embed player, used by any page site
 * that loads `strm.cx` in an iframe (currently miruro). It owns only the
 * `<video>` in its own frame and carries no site-identity knowledge — content
 * identity, catalog, and navigation are the page frame's job (see
 * `src/adapters/miruro/index.ts`).
 *
 * The `<video>` self-loads its blob source on its own, but the player also
 * shows a Vidstack `<media-play-button>` **overlay** that hides the video until
 * it is pressed. {@link ensurePlayable} dismisses that overlay (a synthesized
 * `Space`) so playback can begin under room control; pressing does not load the
 * source, it only clears the overlay, and only functions once a source is
 * present. `holdsAutoplay` is kept `true` so any one-shot auto-play as the
 * source settles is held until the room's first authoritative command, matching
 * the pre-embed miruro behaviour.
 */
class StrmcxAdapter extends MediaBaseAdapter {
	readonly id = 'strmcx'

	protected readonly holdsAutoplay = true

	canHandleFrame(url: URL): boolean {
		return HOST_RE.test(url.hostname)
	}

	protected resolveVideo(): Promise<HTMLVideoElement | null> {
		return waitForElement<HTMLVideoElement>(VIDEO_SELECTOR, {
			timeoutMs: VIDEO_WAIT_TIMEOUT_MS,
			signal: this.signal,
		})
	}

	/**
	 * Cold-start activation. The base only calls this when {@link canPlay} is
	 * false (the `<video>` has no `currentSrc` yet). Dismisses the Vidstack
	 * play-button **overlay** — which hides the video until pressed — so the
	 * self-loaded video becomes playable, then pauses so the room's first
	 * authoritative command wins without an auto-play flash. Pressing the button
	 * does not load the source (the `<video>` self-loads on its own); it only
	 * clears the overlay, and only functions once a source is present.
	 *
	 * Waits for the overlay button and then for the `<video>` to self-load a
	 * source (the press is a no-op while sourceless) before driving it.
	 * Activation is a synthesized `Space` keydown/keyup on the button — a plain
	 * `.click()` is ignored by this control (verified live), only keyboard
	 * activation dismisses the overlay. The keyup is delayed by
	 * {@link KEY_RELEASE_DELAY_MS}: a synchronous release isn't registered, and
	 * the player then treats Space as held and ramps to 2×.
	 *
	 * No-ops cleanly when no button ever appears (nothing to dismiss) or when the
	 * `<video>` never self-loads a source (pressing would do nothing).
	 */
	protected async ensurePlayable(): Promise<void> {
		const video = this.video
		if (!video) return

		const button = await waitForElement<HTMLElement>(PLAY_BUTTON_SELECTOR, {
			timeoutMs: PLAY_BUTTON_WAIT_TIMEOUT_MS,
			signal: this.signal,
		})
		if (this.signal.aborted) return
		if (!button) {
			this.log(
				'warn',
				`no <media-play-button> after ${PLAY_BUTTON_WAIT_TIMEOUT_MS}ms — leaving playback for the user / room to start`,
			)
			return
		}

		// The press only dismisses the overlay once the <video> has a source —
		// pressing a still-sourceless player is a no-op, and the press never loads
		// the source itself. The <video> self-loads on its own, so wait for that
		// source to arrive before driving the button.
		const loaded = await this.waitForLoad(video)
		if (this.signal.aborted) return
		if (!loaded) {
			this.log(
				'warn',
				`<media-play-button> present but no source after ${LOAD_METADATA_TIMEOUT_MS}ms — pressing would be a no-op; leaving playback for the user / room to start`,
			)
			return
		}

		// Vidstack wires the toggle handler a few hundred ms after mount.
		await this.delay(PLAY_BUTTON_SETTLE_MS)
		if (this.signal.aborted) return

		this.log('info', 'dismissing <media-play-button> overlay via synthesized Space')
		const init: KeyboardEventInit = {
			key: ' ',
			code: 'Space',
			keyCode: 32,
			which: 32,
			bubbles: true,
			cancelable: true,
		}
		button.focus()
		button.dispatchEvent(new KeyboardEvent('keydown', init))
		// Delay the release so it registers as a distinct keyup — a synchronous
		// one is dropped and the player ramps to 2× (see KEY_RELEASE_DELAY_MS).
		await this.delay(KEY_RELEASE_DELAY_MS)
		if (this.signal.aborted) return
		button.dispatchEvent(new KeyboardEvent('keyup', init))

		// Pause so the room's first authoritative command wins cleanly. The
		// base's autoplay hold also re-pauses; this avoids the flash.
		video.pause()
	}

	/**
	 * Resolve once the `<video>` has begun loading — immediately if it already
	 * has a `currentSrc`, otherwise on the next `loadedmetadata`, capped at
	 * {@link LOAD_METADATA_TIMEOUT_MS}.
	 *
	 * @param video The player element.
	 * @returns `true` if a source loaded within the window, `false` on timeout.
	 */
	private waitForLoad(video: HTMLVideoElement): Promise<boolean> {
		if (video.currentSrc) return Promise.resolve(true)
		if (this.signal.aborted) return Promise.resolve(false)
		return new Promise<boolean>((resolve) => {
			const settle = (loaded: boolean) => {
				video.removeEventListener('loadedmetadata', onLoaded)
				this.signal.removeEventListener('abort', onAbort)
				clearTimeout(timer)
				resolve(loaded)
			}
			const onLoaded = () => settle(true)
			const onAbort = () => settle(false)
			video.addEventListener('loadedmetadata', onLoaded, { once: true })
			this.signal.addEventListener('abort', onAbort, { once: true })
			const timer = setTimeout(() => settle(false), LOAD_METADATA_TIMEOUT_MS)
		})
	}

	/**
	 * `setTimeout` as a promise. Deliberately not cleared on teardown — the
	 * short timer resolves harmlessly and the caller re-checks
	 * {@link MediaBaseAdapter.signal}`.aborted` after awaiting, so a dangling
	 * handle can't outlive anything meaningful.
	 *
	 * @param ms Delay in milliseconds.
	 * @returns A promise that resolves after `ms`.
	 */
	private delay(ms: number): Promise<void> {
		return new Promise<void>((resolve) => {
			setTimeout(resolve, ms)
		})
	}
}

export const strmcxAdapterFactory: MediaAdapterFactory = () => new StrmcxAdapter()
