import type { AuthoritativeCommand, LocalIntent, MediaContext, MediaRole, VideoState } from '../types'
import { readVideoState, wireIntentListeners } from '../video-driver'

/**
 * Safety release for the autoplay hold (see {@link MediaBaseAdapter.holdsAutoplay}).
 * A player that auto-plays once on load is held paused until the room's first
 * authoritative `play`/`pause` command arrives; if none ever does (e.g. a
 * brand-new room with no state yet) the hold lifts after this window so the
 * viewer is never left unable to start playback. The happy path lifts it far
 * sooner, on the first command.
 */
const AUTOPLAY_HOLD_TIMEOUT_MS = 10_000

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
	 * loads. The base then holds the video paused (re-pausing on any `play`)
	 * until the room's first `play`/`pause` command takes over, so playback
	 * starts under room control without a flash of auto-play. See
	 * {@link AUTOPLAY_HOLD_TIMEOUT_MS}.
	 */
	protected readonly holdsAutoplay: boolean = false

	/** The resolved player element, or `null` before `init`/after `destroy`. */
	protected video: HTMLVideoElement | null = null

	private ctx: MediaContext | null = null
	private readonly abort = new AbortController()
	private readonly cleanups: Array<() => void> = []

	/**
	 * While held, the player's one-shot load auto-play is immediately
	 * re-paused. Released (idempotently) on the first `play`/`pause` command,
	 * or by the safety timer.
	 */
	private autoplayHeld = false

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
			// Soft fail: no video in this frame. The runtime goes inactive but
			// the background leaves the tab's room session intact.
			this.failInit(`${this.id}: no <video> element resolved`)
			return
		}
		this.video = video

		if (this.holdsAutoplay) this.installAutoplayHold(video)

		if (!this.canPlay()) {
			await this.ensurePlayable()
			if (this.signal.aborted) return
		}

		// Intents are wired after the hold listener so, on any stray auto-play,
		// the hold's re-pause runs before the intent listener samples state.
		wireIntentListeners(video, (intent) => this.emitIntent(intent), this.signal)

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
	 * Return `null` to soft-fail the adapter on a frame that isn't actually
	 * hosting a controllable player.
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

	/** Fail the activation and abort the lifetime signal so nothing leaks. */
	private failInit(reason: string): void {
		this.ctx?.fail(reason)
		this.abort.abort()
	}

	/**
	 * Install the autoplay hold: re-pause on every `play` while held, plus a
	 * safety timer that lifts the hold. Attached before the intent listeners
	 * so the re-pause runs first.
	 */
	private installAutoplayHold(video: HTMLVideoElement): void {
		this.autoplayHeld = true
		video.addEventListener(
			'play',
			() => {
				if (this.autoplayHeld && !video.paused) video.pause()
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
	 * Apply an authoritative command verbatim. `play`/`pause`/`seek` drive the
	 * `<video>` directly; `nudge_rate` is a no-op (the runtime intercepts it
	 * before it reaches the adapter); `cursor_change` is the page frame's job
	 * and is ignored here. The first `play`/`pause` lifts the autoplay hold
	 * before applying, so a room `play` isn't re-paused by the hold guard.
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
				this.releaseAutoplayHold()
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
