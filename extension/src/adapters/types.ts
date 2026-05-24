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
 * What the background sends to drive the page. Adapters apply these
 * verbatim — no interpretation, no transformation. `cursor_change` is the
 * v2 protocol addition (replaces the legacy `EPISODE_CHANGE`); adapters
 * may treat it as a no-op until the navigation-on-cursor-change spec
 * lands.
 *
 * Fields:
 * - `time` (seconds, float): absolute video position for `seek`.
 * - `delta` (seconds, float): drift correction for `sync_adjust`.
 * - `pageUrl`: target page for `cursor_change`.
 */
export type AuthoritativeCommand =
	| { type: 'play' }
	| { type: 'pause' }
	| { type: 'seek'; time: number }
	| { type: 'sync_adjust'; delta: number }
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
