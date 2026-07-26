import type { AuthoritativeCommand, LocalIntent, MediaContext, MediaRole, VideoState } from '../types'
import { readVideoState, wireIntentListeners } from '../video-driver'

/**
 * Safety release for the autoplay hold (see {@link MediaBaseAdapter.holdsAutoplay}).
 * A player that auto-plays once on load is held paused until the room's first
 * authoritative `play` command arrives; if none ever does (e.g. a brand-new
 * room with no state yet, or a room that stays paused) the hold lifts after
 * this window so the viewer is never left unable to start playback. The happy
 * path lifts it far sooner, on the first `play`.
 */
const AUTOPLAY_HOLD_TIMEOUT_MS = 10_000

/**
 * Fallback window for {@link MediaBaseAdapter.userInitiatedPlay} on browsers
 * without the User Activation API (Firefox below our floor). A following
 * `play` counts as viewer-initiated if a **trusted** pointer/key gesture fired
 * within this window — long enough to cover gesture→play latency, short enough
 * to stay below the gap to any unrelated auto-play. Unused where
 * `navigator.userActivation` exists (Chrome, modern Firefox).
 */
const USER_GESTURE_WINDOW_MS = 1_000

/**
 * Base class every **media-role** adapter extends — the embed-frame half of a
 * site. It owns the parts that are identical across players (the `<video>`
 * state read, the intent-listener wiring, the authoritative-command switch, the
 * autoplay hold, and all teardown) and drives them through a **sealed** `init`
 * lifecycle. Subclasses implement the player-specific hooks
 * ({@link resolveVideo}, and optionally {@link canPlay} / {@link ensurePlayable})
 * and never re-implement the boilerplate.
 *
 * A media adapter carries **no** site-identity, catalog, or navigation
 * knowledge — those belong to the {@link ../types.PageRole} in the top frame.
 * That is what lets one media adapter serve every page site embedding the same
 * player.
 *
 * Do **not** override {@link init}, {@link destroy}, or {@link handleCommand}
 * — they are the sealed skeleton. {@link getState} and {@link setPlaybackRate}
 * are overridable escape hatches for a future player that isn't a plain
 * `<video>`.
 *
 * Teardown is centralised on a single {@link AbortController}: every listener
 * is bound with `{ signal }` and every `waitForElement` takes the signal, so
 * {@link destroy} (and any `init` failure) removes them all at once.
 */
export abstract class MediaBaseAdapter implements MediaRole {
	/** Stable identifier; also the log prefix and command-routing key. */
	abstract readonly id: string

	/**
	 * Set `true` when the underlying player auto-plays once as the source
	 * loads. The base then holds the video paused — re-pausing the player's own
	 * auto-play while letting a viewer-initiated `play` through — until the
	 * room's first `play` command (or a viewer play) takes over, so playback
	 * starts under room control without a flash of auto-play. See
	 * {@link installAutoplayHold} and {@link AUTOPLAY_HOLD_TIMEOUT_MS}.
	 */
	protected readonly holdsAutoplay: boolean = false

	/** The resolved player element, or `null` before `init`/after `destroy`. */
	protected video: HTMLVideoElement | null = null

	private ctx: MediaContext | null = null
	private readonly abort = new AbortController()
	private readonly cleanups: Array<() => void> = []

	/**
	 * While held, the player's **unsolicited** auto-play (load-time or late
	 * buffered) is immediately re-paused; a viewer-initiated `play` is let
	 * through and lifts the hold. Released (idempotently) on the first room
	 * `play` command, a viewer play, or the safety timer — not on a room
	 * `pause`/`seek`, so a late buffered auto-play stays caught against a paused
	 * room. See {@link installAutoplayHold}.
	 */
	private autoplayHeld = false

	/**
	 * Timestamp (`Date.now()`) of the last **trusted** user gesture on the
	 * player. Fallback signal for {@link userInitiatedPlay} where the User
	 * Activation API is unavailable. `0` until the first real gesture. See
	 * {@link USER_GESTURE_WINDOW_MS}.
	 */
	private lastUserGestureAt = 0

	/**
	 * Abort signal for this adapter's lifetime. Pass it to every
	 * `addEventListener` and every `waitForElement` in a hook, and the base's
	 * {@link destroy} (or an `init` failure) tears them down for free.
	 */
	protected get signal(): AbortSignal {
		return this.abort.signal
	}

	abstract canHandleFrame(url: URL): boolean

	/**
	 * Sealed lifecycle. Runs the hooks in a fixed order (resolve video → hold →
	 * ensure playable → wire intents → wire commands) with abort checks at the
	 * seams between awaits. Do not override.
	 */
	async init(ctx: MediaContext): Promise<void> {
		this.ctx = ctx

		const video = await this.resolveVideo()
		if (this.signal.aborted) return
		if (!video) {
			// No controllable video in this frame. Control over the `<video>` is
			// non-negotiable for sync, so this fails the activation loudly; the
			// background tears the room down unless another frame owns the video
			// (a phantom sibling frame). See {@link failInit}.
			this.failInit(`${this.id}: no <video> element resolved`)
			return
		}
		this.video = video
		// Announce ownership the instant the <video> is resolved — before the slow
		// cold-start prep below — so the background registers this frame as the
		// video owner well before any phantom sibling's videoless fail can arrive.
		ctx.claimVideo()

		if (this.holdsAutoplay) this.installAutoplayHold(video)

		if (!this.canPlay()) {
			await this.ensurePlayable()
			if (this.signal.aborted) return
		}

		// Intents are wired after the hold listener so, on any stray auto-play,
		// the hold's re-pause runs before the intent listener samples state.
		// While the hold is active, the player's own auto-play (and the guard's
		// compensating re-pause) are not viewer actions: dropping their intents
		// here stops a stray `play` from round-tripping through the room and
		// forcing every client to play. A viewer action carries user activation
		// and passes through. Re-pausing the local `<video>` alone is not enough
		// — the leaked intent would come straight back as a room `play` command.
		wireIntentListeners(
			video,
			(intent) => {
				if (this.autoplayHeld && !this.isViewerDriven()) return
				this.emitIntent(intent)
			},
			this.signal,
		)

		ctx.onCommand((cmd) => this.handleCommand(cmd))
	}

	getState(): VideoState | null {
		return this.video ? readVideoState(this.video) : null
	}

	setPlaybackRate(rate: number): void {
		if (this.video) this.video.playbackRate = rate
	}

	/**
	 * Detach everything and clear refs. Aborts the lifetime signal (removing
	 * every `{ signal }` listener and stopping every `waitForElement`
	 * observer) and runs the timer-cleanup registry. Runtime calls this on
	 * teardown; safe to call more than once.
	 */
	destroy(): void {
		this.abort.abort()
		for (const fn of this.cleanups) {
			try {
				fn()
			} catch {
				// Teardown must never throw.
			}
		}
		this.cleanups.length = 0
		this.video = null
		this.ctx = null
	}

	// --- Hooks a subclass implements or overrides ---------------------------

	/**
	 * Find the player's `<video>` element in **this frame's** document, waiting
	 * for late hydration if needed (use `waitForElement` with {@link signal}).
	 * Return `null` only when this frame genuinely has no controllable player:
	 * the base then fails the activation, and the background treats a videoless
	 * owning frame as a fatal, room-tearing-down error (control over the
	 * `<video>` is a hard requirement for sync).
	 *
	 * @returns The player element, or `null` if it never appears.
	 */
	protected abstract resolveVideo(): Promise<HTMLVideoElement | null>

	/**
	 * Is the player ready to start playback? The base skips
	 * {@link ensurePlayable} when this is already true. Default: the video has
	 * a source. Override for players with a different readiness signal.
	 *
	 * @returns `true` when playback can begin without further preparation.
	 */
	protected canPlay(): boolean {
		return !!this.video?.currentSrc
	}

	/**
	 * Do whatever the player needs so {@link canPlay} becomes true — e.g. drive
	 * a cold-start "click to load" control and wait for the source. Only
	 * called when `canPlay()` is false at init. Guard your own post-await
	 * steps with {@link signal}`.aborted`. Default: no-op.
	 */
	protected ensurePlayable(): Promise<void> {
		return Promise.resolve()
	}

	// --- Protected helpers for hooks ---------------------------------------

	/** Forward an observed user action toward the background WS client. */
	protected emitIntent(intent: LocalIntent): void {
		this.ctx?.emitIntent(intent)
	}

	/** Structured log line; the runtime prefixes it with this adapter's id. */
	protected log(level: 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>): void {
		this.ctx?.log(level, msg, data)
	}

	/**
	 * Register a teardown callback for resources the abort signal can't cover
	 * on its own — chiefly raw `setTimeout` handles. Listeners and
	 * `waitForElement` observers should use {@link signal} instead.
	 *
	 * @param fn Cleanup callback run once on {@link destroy}.
	 */
	protected onCleanup(fn: () => void): void {
		this.cleanups.push(fn)
	}

	// --- Sealed internals ---------------------------------------------------

	/**
	 * Fail the activation and abort the lifetime signal so nothing leaks. The
	 * background escalates this to a full room teardown unless another frame
	 * already owns the video (see the `fail` handler in `background.ts`).
	 */
	private failInit(reason: string): void {
		this.ctx?.fail(reason)
		this.abort.abort()
	}

	/**
	 * Install the autoplay hold. On every `play` while held either lets it
	 * through (a viewer-initiated play, which also lifts the hold) or re-pauses
	 * it (the player's unsolicited auto-play). Plus a safety timer that lifts
	 * the hold unconditionally. Attached before the intent listeners so the
	 * re-pause runs first.
	 */
	private installAutoplayHold(video: HTMLVideoElement): void {
		this.autoplayHeld = true

		// Fallback-only gesture tracking for browsers without the User
		// Activation API (see {@link userInitiatedPlay}). Only *trusted* gestures
		// count — the synthesized keys a cold-start `ensurePlayable` dispatches
		// are `isTrusted: false`, so the activation's own auto-play stays
		// suppressed.
		const markGesture = (e: Event) => {
			if (e.isTrusted) this.lastUserGestureAt = Date.now()
		}
		document.addEventListener('pointerdown', markGesture, { signal: this.signal, capture: true })
		document.addEventListener('keydown', markGesture, { signal: this.signal, capture: true })

		video.addEventListener(
			'play',
			() => {
				if (!this.autoplayHeld) return
				// A viewer-driven play is the viewer taking control: honour it and
				// lift the hold (their intent flows to the room). The player's own
				// auto-play carries no user activation, so it's re-paused.
				if (this.isViewerDriven()) {
					this.releaseAutoplayHold()
					return
				}
				if (!video.paused) video.pause()
			},
			{ signal: this.signal },
		)
		const timer = setTimeout(() => {
			this.autoplayHeld = false
		}, AUTOPLAY_HOLD_TIMEOUT_MS)
		this.onCleanup(() => clearTimeout(timer))
	}

	/** Lift the autoplay hold. Idempotent. */
	private releaseAutoplayHold(): void {
		this.autoplayHeld = false
	}

	/**
	 * Whether the action currently being handled (a `play`, or an intent about
	 * to be emitted) is driven by the viewer rather than by the player itself
	 * (its load/buffer auto-play, or the hold's own compensating re-pause).
	 *
	 * Primary signal is the User Activation API (`navigator.userActivation`,
	 * Chrome 72+ / Firefox 120+): `isActive` reflects **transient activation** —
	 * `true` for a few seconds (~5 s in Chromium) after any real user gesture,
	 * not only while a handler runs. Crucially it does **not** survive a
	 * navigation, so a page freshly (re)loaded starts inactive and the site's
	 * load/buffer auto-play reads as unsolicited. The window is deliberately
	 * loose: a stray gesture within it can misread a late buffered auto-play as
	 * viewer-driven (leaking a `play`), but erring the other way — re-pausing a
	 * genuine viewer play — is the worse, more visible failure, and the 10 s hold
	 * timer bounds the leak. Falls back, on browsers without the API (below our
	 * Firefox floor), to "a trusted pointer/key gesture within
	 * {@link USER_GESTURE_WINDOW_MS}" — best-effort only.
	 *
	 * @returns `true` if the action appears viewer-driven.
	 */
	private isViewerDriven(): boolean {
		const ua = (navigator as { userActivation?: { isActive: boolean } }).userActivation
		if (ua) return ua.isActive
		return Date.now() - this.lastUserGestureAt < USER_GESTURE_WINDOW_MS
	}

	/**
	 * Apply an authoritative command verbatim. `play`/`pause`/`seek` drive the
	 * `<video>` directly; `nudge_rate` is a no-op (the runtime intercepts it
	 * before it reaches the adapter); `cursor_change` is the page frame's job
	 * and is ignored here.
	 *
	 * Only a room `play` lifts the autoplay hold (before applying, so it isn't
	 * re-paused by the guard). `pause`/`seek` keep the hold engaged: some
	 * players auto-play asynchronously once buffering settles, landing *after*
	 * the room's resync `pause`, and the hold must still be there to catch it.
	 * A viewer's own play lifts the hold separately (see
	 * {@link installAutoplayHold}).
	 */
	private handleCommand(cmd: AuthoritativeCommand): void {
		const video = this.video
		if (!video) return
		switch (cmd.type) {
			case 'play':
				this.releaseAutoplayHold()
				void video.play()
				return
			case 'pause':
				video.pause()
				return
			case 'seek':
				video.currentTime = cmd.time
				return
			case 'nudge_rate':
			case 'cursor_change':
				return
		}
	}
}
