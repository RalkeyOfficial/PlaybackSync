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
 * Vidstack's play-toggle custom element inside the strm.cx embed. On some
 * providers the `<video>` mounts without a source and only acquires one once
 * this control is activated (see {@link StrmcxAdapter.ensurePlayable}). The
 * full DOM path is `#app > strmcx-player > media-player > media-play-button`;
 * the bare tag is used because it's the same element and survives the layout
 * nesting churning between player builds.
 */
const PLAY_BUTTON_SELECTOR = 'media-play-button'

/**
 * How long {@link StrmcxAdapter.ensurePlayable} waits for the play button to
 * mount before giving up. Aborted early once the video begins loading a source
 * on its own (the `loadstart` short-circuit), so a self-loading provider never
 * waits the full window.
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
 * How long to wait for the `<video>` to actually start loading after the play
 * button is driven, before moving on. Bounds the worst case so a control that
 * silently does nothing can't hang activation.
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
 * Most providers self-load their blob source, in which case {@link canPlay}
 * (source present) short-circuits {@link ensurePlayable}. Some render the
 * player with a sourceless `<video>` and a Vidstack `<media-play-button>` that
 * must be activated first; {@link ensurePlayable} drives it. `holdsAutoplay` is
 * kept `true` so any one-shot auto-play as the source settles is held until the
 * room's first authoritative command, matching the pre-embed miruro behaviour.
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
	 * false (the `<video>` has no `currentSrc`). Drives the Vidstack play button
	 * so the embed loads its source, then pauses so the room's first
	 * authoritative command wins without an auto-play flash.
	 *
	 * Activation is a synthesized `Space` keydown/keyup on the button — a plain
	 * `.click()` is ignored by this control (verified live), only keyboard
	 * activation loads the source. The keyup is delayed by
	 * {@link KEY_RELEASE_DELAY_MS}: a synchronous release isn't registered, and
	 * the player then treats Space as held and ramps to 2×.
	 *
	 * No-ops cleanly when the video self-loads (the `loadstart` short-circuit in
	 * {@link waitForPlayButton} resolves the wait early and `currentSrc` is set)
	 * or when no button ever appears.
	 */
	protected async ensurePlayable(): Promise<void> {
		const video = this.video
		if (!video) return

		const button = await this.waitForPlayButton(video)
		if (this.signal.aborted) return
		if (video.currentSrc) return // gained a source on its own (self-load)
		if (!button) {
			this.log(
				'warn',
				`no source and no <media-play-button> after ${PLAY_BUTTON_WAIT_TIMEOUT_MS}ms — leaving playback for the user / room to start`,
			)
			return
		}

		// Vidstack wires the toggle handler a few hundred ms after mount.
		await this.delay(PLAY_BUTTON_SETTLE_MS)
		if (this.signal.aborted) return

		this.log('info', 'activating play via synthesized Space on <media-play-button>')
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
		await this.waitForLoad(video)
		if (this.signal.aborted) return

		// Pause so the room's first authoritative command wins cleanly. The
		// base's autoplay hold also re-pauses; this avoids the flash.
		video.pause()
	}

	/**
	 * Resolve to the Vidstack `<media-play-button>`, or `null` on timeout, on
	 * adapter teardown, or as soon as the video begins loading a source on its
	 * own (the `loadstart` short-circuit — so a self-loading provider doesn't
	 * waste the full window).
	 *
	 * Combines the adapter lifetime signal with the `loadstart` short-circuit
	 * manually rather than via `AbortSignal.any`, which isn't available on our
	 * Firefox floor (`strict_min_version` 109; `AbortSignal.any` is 124+).
	 *
	 * @param video Player element, watched for `loadstart`.
	 * @returns The play button element, or `null`.
	 */
	private waitForPlayButton(video: HTMLVideoElement): Promise<HTMLElement | null> {
		const ac = new AbortController()
		if (this.signal.aborted) {
			ac.abort()
		} else {
			this.signal.addEventListener('abort', () => ac.abort(), { once: true })
			video.addEventListener('loadstart', () => ac.abort(), { once: true, signal: this.signal })
		}
		return waitForElement<HTMLElement>(PLAY_BUTTON_SELECTOR, {
			timeoutMs: PLAY_BUTTON_WAIT_TIMEOUT_MS,
			signal: ac.signal,
		})
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
