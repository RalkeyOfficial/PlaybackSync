import type {
	Adapter,
	AdapterContext,
	AuthoritativeCommand,
	ContentIdentity,
	LocalIntent,
	VideoState,
} from './types'
import type { VideoRefWithMeta } from '../background/protocol'
import { readVideoState, wireIntentListeners } from './video-driver'

/**
 * Safety release for the autoplay hold (see {@link BaseAdapter.holdsAutoplay}).
 * A player that auto-plays once on load is held paused until the room's first
 * authoritative `play`/`pause` command arrives; if none ever does (e.g. a
 * brand-new room with no state yet) the hold lifts after this window so the
 * viewer is never left unable to start playback. The happy path lifts it far
 * sooner, on the first command.
 */
const AUTOPLAY_HOLD_TIMEOUT_MS = 10_000

/**
 * Base class every site adapter extends. It owns the parts that were
 * identical across adapters — the `<video>` state read, the intent-listener
 * wiring, the authoritative-command switch, the autoplay hold, and all
 * teardown — and drives them through a **sealed** `init` lifecycle that calls
 * a small set of overridable hooks. Subclasses implement the site-specific
 * hooks ({@link resolveVideo}, {@link resolveIdentity}, and optionally
 * {@link canPlay} / {@link ensurePlayable} / {@link applyCursorChange} /
 * {@link watchCursorTriggers} / `scrapeCatalog`) and never re-implement the
 * boilerplate.
 *
 * Do **not** override {@link init}, {@link destroy}, or {@link handleCommand}
 * — they are the sealed skeleton. {@link getState} and {@link setPlaybackRate}
 * are overridable escape hatches for a future player that isn't a plain
 * `<video>`.
 *
 * Teardown is centralised on a single {@link AbortController}: every listener
 * is bound with `{ signal }` and every {@link waitForElement} takes the
 * signal, so {@link destroy} (and any `init` failure) removes them all at once.
 */
export abstract class BaseAdapter implements Adapter {
	/** Stable identifier; also the log prefix and command-routing key. */
	abstract readonly id: string

	/**
	 * Opt into the background navigation-guard. Overridden to `true` only by
	 * adapters that ship a `videoIdForUrl` matcher with canonical, navigable
	 * `pageUrl`s. Read by the runtime **before** `init`, so it must stay a
	 * field initializer, never assigned inside `init`.
	 */
	readonly guardNavigation: boolean = false

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

	private ctx: AdapterContext | null = null
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
	 * `addEventListener` and every {@link waitForElement} in a hook, and the
	 * base's {@link destroy} (or an `init` failure) tears them down for free.
	 */
	protected get signal(): AbortSignal {
		return this.abort.signal
	}

	abstract canHandlePage(url: URL): boolean

	/**
	 * Sealed lifecycle. Runs the hooks in a fixed order (resolve video →
	 * resolve identity → hold → ensure playable → wire intents → wire commands
	 * → watch cursor triggers → announce identity) with abort checks at the
	 * seams between awaits. Do not override.
	 */
	async init(ctx: AdapterContext): Promise<void> {
		this.ctx = ctx

		const video = await this.resolveVideo()
		if (this.signal.aborted) return
		if (!video) {
			this.failInit(`${this.id}: no <video> element resolved`)
			return
		}
		this.video = video

		// Identity before ensurePlayable: it needs only page hydration (which
		// resolveVideo guarantees), not a loaded source, so an unidentifiable
		// page fails immediately rather than after a full cold-start. This is
		// synchronous, so no auto-play can fire before the hold installs below.
		const identity = this.resolveIdentity()
		if (!identity) {
			this.failInit(`${this.id}: could not resolve content identity`)
			return
		}

		if (this.holdsAutoplay) this.installAutoplayHold(video)

		if (!this.canPlay()) {
			await this.ensurePlayable()
			if (this.signal.aborted) return
		}

		// Intents are wired after the hold listener so, on any stray auto-play,
		// the hold's re-pause runs before the intent listener samples state.
		wireIntentListeners(video, (intent) => this.emitIntent(intent), this.signal)

		ctx.onCommand((cmd) => this.handleCommand(cmd))

		// Fire-and-forget: the hook must not block activation (its own
		// DOM-wait, if any, would delay setIdentity and the catalog scrape).
		this.watchCursorTriggers()

		ctx.setIdentity(identity)
	}

	getState(): VideoState | null {
		return this.video ? readVideoState(this.video) : null
	}

	setPlaybackRate(rate: number): void {
		if (this.video) this.video.playbackRate = rate
	}

	/**
	 * Detach everything and clear refs. Aborts the lifetime signal (removing
	 * every `{ signal }` listener and stopping every {@link waitForElement}
	 * observer) and runs the timer-cleanup registry. Runtime calls this on
	 * URL change; safe to call more than once.
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
	 * Find the player's `<video>` element, waiting for late hydration if
	 * needed (use {@link waitForElement} with {@link signal}). Return `null`
	 * to fail the adapter cleanly on a page that looked supportable but isn't.
	 *
	 * @returns The player element, or `null` if it never appears.
	 */
	protected abstract resolveVideo(): Promise<HTMLVideoElement | null>

	/**
	 * Derive this page's strict content identity from the URL (and any
	 * DOM/query state that's settled by the time {@link resolveVideo}
	 * resolved). Return `null` to fail the adapter when identity can't be
	 * determined.
	 *
	 * @returns The identity triple, or `null` if it can't be derived.
	 */
	protected abstract resolveIdentity(): ContentIdentity | null

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
	 * Do whatever the site needs so {@link canPlay} becomes true — e.g. drive
	 * a cold-start "click to load" control and wait for the source. Only
	 * called when `canPlay()` is false at init. Guard your own post-await
	 * steps with {@link signal}`.aborted`. Default: no-op.
	 */
	protected ensurePlayable(): Promise<void> {
		return Promise.resolve()
	}

	/**
	 * Apply an authoritative `cursor_change` command by driving the page to
	 * `pageUrl`. Default: a full `location.href` navigation. Override to
	 * replay the site's own in-page routing (e.g. click the matching episode
	 * button) with a `location.href` fallback.
	 *
	 * @param pageUrl The target page URL from the room.
	 */
	protected applyCursorChange(pageUrl: string): void {
		location.href = pageUrl
	}

	/**
	 * Wire detection of in-page navigation clicks (e.g. episode buttons) that
	 * should announce a cursor change via {@link emitCursorTrigger}. Called
	 * fire-and-forget during `init`, so a hook that must wait for the control
	 * to hydrate should do so off the critical path (kick off the wait, attach
	 * in its `.then`, return synchronously). Filter on `Event.isTrusted` so
	 * synthetic clicks from {@link applyCursorChange} don't loop back. Default:
	 * no-op.
	 */
	protected watchCursorTriggers(): void {
		// No in-page navigation to watch by default.
	}

	// --- Protected helpers for hooks ---------------------------------------

	/** Forward an observed user action toward the background WS client. */
	protected emitIntent(intent: LocalIntent): void {
		this.ctx?.emitIntent(intent)
	}

	/** Announce that the user clicked toward a different `VideoRef`. */
	protected emitCursorTrigger(target: VideoRefWithMeta): void {
		this.ctx?.emitCursorTrigger(target)
	}

	/** Structured log line; the runtime prefixes it with this adapter's id. */
	protected log(level: 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>): void {
		this.ctx?.log(level, msg, data)
	}

	/**
	 * Register a teardown callback for resources the abort signal can't cover
	 * on its own — chiefly raw `setTimeout` handles. Listeners and
	 * {@link waitForElement} observers should use {@link signal} instead.
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
	 * `<video>` directly; `cursor_change` delegates to {@link applyCursorChange};
	 * `nudge_rate` is a no-op (the runtime intercepts it before it reaches the
	 * adapter). The first `play`/`pause` lifts the autoplay hold before applying,
	 * so a room `play` isn't re-paused by the hold guard.
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
				return
			case 'cursor_change':
				this.applyCursorChange(cmd.pageUrl)
				return
		}
	}
}
