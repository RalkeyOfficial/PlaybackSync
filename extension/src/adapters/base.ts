import type { AuthoritativeCommand, ContentIdentity, PageContext, PageRole } from './types'
import type { VideoRefWithMeta } from '../background/protocol'

/**
 * Base class every **page-role** site adapter extends — the top-frame half of a
 * site. It owns the parts that are identical across sites' page frames (content
 * identity, cursor-change application, cursor-trigger detection, and all
 * teardown) and drives them through a **sealed** `init` lifecycle that calls a
 * small set of overridable hooks. Subclasses implement the site-specific hooks
 * ({@link resolveIdentity}, and optionally {@link resolveReady} /
 * {@link applyCursorChange} / {@link watchCursorTriggers} / `scrapeCatalog`)
 * and never re-implement the boilerplate.
 *
 * The `<video>` is deliberately **not** here: it lives in the media frame and
 * is owned by a `MediaRole` adapter (see `src/adapters/media/base.ts`). A page
 * adapter never resolves, reads, or drives a video element.
 *
 * Do **not** override {@link init} or {@link destroy} — they are the sealed
 * skeleton.
 *
 * Teardown is centralised on a single {@link AbortController}: every listener
 * is bound with `{ signal }` and every `waitForElement` takes the signal, so
 * {@link destroy} (and any `init` failure) removes them all at once.
 */
export abstract class PageBaseAdapter implements PageRole {
	/** Stable identifier; also the log prefix and command-routing key. */
	abstract readonly id: string

	/**
	 * Opt into the background navigation-guard. Overridden to `true` only by
	 * adapters that ship a `videoIdForUrl` matcher with canonical, navigable
	 * `pageUrl`s. Read by the runtime **before** `init`, so it must stay a
	 * field initializer, never assigned inside `init`.
	 */
	readonly guardNavigation: boolean = false

	private ctx: PageContext | null = null
	private readonly abort = new AbortController()
	private readonly cleanups: Array<() => void> = []

	/**
	 * Abort signal for this adapter's lifetime. Pass it to every
	 * `addEventListener` and every `waitForElement` in a hook, and the base's
	 * {@link destroy} (or an `init` failure) tears them down for free.
	 */
	protected get signal(): AbortSignal {
		return this.abort.signal
	}

	abstract canHandlePage(url: URL): boolean

	/**
	 * Sealed lifecycle. Runs the hooks in a fixed order (wait for the page to
	 * settle → resolve identity → wire the cursor-change handler → watch cursor
	 * triggers → announce identity) with abort checks at the seams between
	 * awaits. Do not override.
	 */
	async init(ctx: PageContext): Promise<void> {
		this.ctx = ctx

		// Let the page settle before reading identity. On the old single-frame
		// model the `<video>` wait implicitly gated this (miruro appends `?ep=`
		// on player init); with the video gone from this frame, the page adapter
		// needs its own explicit readiness wait or it would read identity before
		// `?ep=` exists and spuriously fail.
		await this.resolveReady()
		if (this.signal.aborted) return

		const identity = this.resolveIdentity()
		if (!identity) {
			this.failInit(`${this.id}: could not resolve content identity`)
			return
		}

		ctx.onCommand((cmd) => this.handlePageCommand(cmd))

		// Fire-and-forget: the hook must not block activation (its own
		// DOM-wait, if any, would delay setIdentity and the catalog scrape).
		this.watchCursorTriggers()

		ctx.setIdentity(identity)
	}

	/**
	 * Detach everything and clear refs. Aborts the lifetime signal (removing
	 * every `{ signal }` listener and stopping every `waitForElement`
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
		this.ctx = null
	}

	// --- Hooks a subclass implements or overrides ---------------------------

	/**
	 * Wait until the page has settled enough to derive a stable identity —
	 * chiefly for SPA sites that mutate the URL (e.g. append a `?ep=` query
	 * param) shortly after load. Use `waitForElement` with {@link signal}, or
	 * poll the URL. Default: resolve immediately (identity is readable at load).
	 *
	 * @returns A promise that resolves once identity can be read.
	 */
	protected resolveReady(): Promise<void> {
		return Promise.resolve()
	}

	/**
	 * Derive this page's strict content identity from the URL (and any
	 * DOM/query state that's settled by the time {@link resolveReady}
	 * resolved). Return `null` to fail the adapter when identity can't be
	 * determined.
	 *
	 * @returns The identity triple, or `null` if it can't be derived.
	 */
	protected abstract resolveIdentity(): ContentIdentity | null

	/**
	 * Optional catalog scrape (see {@link PageRole.scrapeCatalog}). Left
	 * unimplemented by the base — override on the subclass when the site
	 * exposes an episode list, omit it otherwise.
	 */
	scrapeCatalog?(): Promise<VideoRefWithMeta[] | null>

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
	 * Apply an authoritative command in the page frame. Only `cursor_change` is
	 * actionable here (delegated to {@link applyCursorChange}); `play`/`pause`/
	 * `seek`/`nudge_rate` are the media frame's job and are ignored — the
	 * background targets them at the media frame, but a broadcast fallback can
	 * still land one here, so the no-op arms keep that harmless.
	 */
	private handlePageCommand(cmd: AuthoritativeCommand): void {
		switch (cmd.type) {
			case 'cursor_change':
				this.applyCursorChange(cmd.pageUrl)
				return
			case 'play':
			case 'pause':
			case 'seek':
			case 'nudge_rate':
				return
		}
	}
}
