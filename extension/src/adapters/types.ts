import type { VideoRefWithMeta } from '../background/protocol'

/**
 * Adapter contract: every supported streaming site is one adapter.
 *
 * Adapters are statically bundled (see {@link ADAPTERS} in `runtime.ts`) and
 * evaluated in registry order on every page load and SPA navigation. Exactly
 * one adapter activates per tab, or none. Workshop §2–§4 in
 * `OLD_CODE/extension/docs/playback_sync_extension_architecture_adapter_based_design_workshop_v_1.md`.
 */
export interface Adapter {
	/** Stable identifier, also used in log lines. Matches the registry key. */
	id: string

	/**
	 * Pure predicate: does this adapter own the given page? The runtime calls
	 * this on every page load and SPA navigation. No side effects, no DOM
	 * reads — just URL inspection.
	 */
	canHandlePage(url: URL): boolean

	/**
	 * Bind to the page: find the video element, attach listeners, register
	 * the command handler, set content identity. Reject the page (call
	 * {@link AdapterContext.fail}) if anything required is missing — silent
	 * fallback is forbidden.
	 */
	init(ctx: AdapterContext): Promise<void>

	/**
	 * Read the current video state on demand. The runtime polls this on a
	 * ~1 s tick and forwards the result to the background, which uses it to
	 * build `HEARTBEAT` frames and detect `BUFFER_START`/`BUFFER_END`
	 * transitions. Returning `null` means "not ready yet" (e.g. video
	 * element gone mid-tick) — the runtime skips that tick.
	 *
	 * @returns The current player state, or `null` if it can't be read.
	 */
	getState(): VideoState | null

	/**
	 * Declarative write-through to the underlying player's playback speed.
	 * The runtime calls this when applying a `nudge_rate` command and again
	 * with `1` to restore baseline once the nudge window elapses; the
	 * adapter never schedules its own timer or decides the magnitude. A
	 * call with `rate === 1` is the restore call and must always succeed
	 * even if the player is in a transient state. No-op if the underlying
	 * player isn't bound yet — the runtime tolerates that.
	 *
	 * @param rate Target playback rate. `1` restores baseline; values near
	 *   `1` (e.g. `0.95` / `1.05`) are the nudge clamps.
	 */
	setPlaybackRate(rate: number): void

	/**
	 * Best-effort scrape of the page's episode list, for the JOIN frame's
	 * `catalogFragment` field. The runtime invokes this once per adapter
	 * lifetime, right after {@link Adapter.init} resolves, and forwards the
	 * result to the background; the background merges it into the room's
	 * playlist via the JOIN handler.
	 *
	 * Optional — adapters that can't (or don't want to) enumerate a catalog
	 * simply omit this method. The runtime applies its own timeout
	 * (`SCRAPE_CATALOG_TIMEOUT_MS` in `runtime.ts`) and catches any thrown
	 * exception, treating both as `null`, so the adapter does not need to
	 * bound its own latency. That said, well-written implementations should
	 * still resolve in well under a second on the common path.
	 *
	 * Returning `null` (or `[]`, or throwing) means "no catalog available
	 * right now" — the JOIN frame omits `catalogFragment` entirely. Use this
	 * for cold pages where the episode list hasn't hydrated, or for layouts
	 * that don't expose one.
	 *
	 * Each returned entry must carry a **full** `pageUrl` (origin included).
	 * The wire-format `VideoRef.pageUrl` is what the server stores so a
	 * later cursor change can navigate back to it — the hostname-stripped
	 * `ContentIdentity.normalizedUrl` form is for identity comparison only
	 * and is not interchangeable here.
	 *
	 * @returns The scraped entries, or `null` if no catalog is available.
	 */
	scrapeCatalog?(): Promise<VideoRefWithMeta[] | null>

	/** Detach every listener and clear refs. Runtime calls this on URL change. */
	destroy(): void
}

/** Factory shape the registry stores — keeps state per-page-load isolated. */
export type AdapterFactory = () => Adapter

/**
 * Bridge between an adapter and the rest of the extension. Adapters get this
 * via {@link Adapter.init} and never reach for `chrome.runtime` directly.
 */
export interface AdapterContext {
	/** Forward an observed user action toward the background WS client. */
	emitIntent(intent: LocalIntent): void

	/**
	 * Announce that the user clicked an in-page navigation control (e.g. an
	 * episode button) and is moving to a different `VideoRef`. The runtime
	 * forwards the trigger to the background, which decides — based on the
	 * room's current mode and playlist — whether to send a
	 * `CURSOR_CHANGE_REQUEST`, drop it silently, or soft-leave the room.
	 *
	 * Adapters should call this passively (no `preventDefault`): the host
	 * page's own routing handles the local navigation; we just piggyback
	 * the announcement so the rest of the room can follow.
	 *
	 * @param target Full identity of the video the user is navigating to,
	 *   in the same shape used for `JOIN.catalogFragment` entries.
	 */
	emitCursorTrigger(target: VideoRefWithMeta): void

	/**
	 * Register the one handler that applies authoritative commands from the
	 * server. Calling this twice replaces the previous handler.
	 */
	onCommand(handler: (cmd: AuthoritativeCommand) => void): void

	/** Report the current page's content identity. Called once after `init`. */
	setIdentity(identity: ContentIdentity): void

	/**
	 * Hard fail: this adapter cannot run on this page. The runtime stays
	 * inactive for the tab until the next navigation. Use sparingly — most
	 * `init` problems are bugs, not legitimate "skip this page" signals.
	 */
	fail(reason: string): void

	/** Structured log line prefixed with the adapter id by the runtime. */
	log(level: 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>): void
}

/**
 * What an adapter sends when it observes the user playing, pausing, or
 * scrubbing. The background decides whether to forward this as a wire
 * `EVENT` or to suppress it (e.g. during the post-command cooldown).
 */
export type LocalIntent =
	| { type: 'play'; time: number }
	| { type: 'pause'; time: number }
	| { type: 'seek'; time: number }

/**
 * What the background sends to drive the page. Adapters apply `play` /
 * `pause` / `seek` / `cursor_change` verbatim — no interpretation, no
 * transformation. `nudge_rate` is intercepted by the runtime before it
 * reaches the adapter: the runtime reads the adapter's current position,
 * computes the rate clamp, calls {@link Adapter.setPlaybackRate}, and
 * schedules the restore. Adapters still exhaustively handle it in their
 * `onCommand` switch (no-op arm) so type-checking stays honest.
 *
 * Fields:
 * - `time` (seconds, float): absolute video position for `seek`.
 * - `targetPos` (seconds, float): authoritative target position the
 *   runtime should nudge `<video>.currentTime` toward via
 *   `setPlaybackRate`.
 * - `pageUrl`: target page for `cursor_change`.
 */
export type AuthoritativeCommand =
	| { type: 'play' }
	| { type: 'pause' }
	| { type: 'seek'; time: number }
	| { type: 'nudge_rate'; targetPos: number }
	| { type: 'cursor_change'; pageUrl: string }

/**
 * Strict content identity, set once per adapter lifetime. `normalizedUrl`
 * MUST NOT contain a hostname — `miruro.tv` and `miruro.to` are the same
 * logical content (workshop §7).
 *
 * Field naming follows the v2 wire format at `docs/ws-protocol.md`
 * (JOIN.currentlyShowing): `videoId`, not `episodeId`.
 */
export interface ContentIdentity {
	providerId: string
	videoId: string
	normalizedUrl: string
}

/**
 * Snapshot of the page's video state, as the adapter sees it. Sampled
 * once per ~1 s tick. `currentPos` is the playhead in seconds; the three
 * `playerState` values map directly to the wire-format `playerState`
 * field on `HEARTBEAT` frames (`docs/ws-protocol.md` §HEARTBEAT).
 *
 * `'buffering'` is reserved for "actively waiting on data" (e.g.
 * `readyState < 3`). A paused video that's fully loaded is `'paused'`,
 * not `'buffering'`.
 */
export interface VideoState {
	currentPos: number
	playerState: 'playing' | 'paused' | 'buffering'
}
