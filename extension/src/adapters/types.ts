import type { VideoRefWithMeta } from '../background/protocol'

/**
 * Which half of a site a content script is playing. A site's DOM can span two
 * frames — the top page frame that owns identity/navigation, and a (possibly
 * cross-origin) embed frame that owns the `<video>`. Each frame runs exactly
 * one role. The background stamps inbound messages with the sender's role so it
 * can route commands to the right frame (see `messages.ts`, `background.ts`).
 */
export type FrameRole = 'page' | 'media'

/**
 * Page-role adapter contract: the top-frame half of a site. Owns everything
 * that is derived from the page URL/DOM and does **not** touch the `<video>` —
 * content identity, the episode catalog, in-page cursor navigation, and the
 * navigation-guard opt-in.
 *
 * On sites where the player is same-frame, one page frame and one media frame
 * still both apply (the media script simply finds the top-frame video); on
 * embed sites like miruro the media half lives in a different, cross-origin
 * frame. Either way the `<video>` is the {@link MediaRole}'s job, never this.
 *
 * Page adapters are statically bundled (see the page runtime's `ADAPTERS`) and
 * evaluated in registry order on every load + SPA navigation; exactly one
 * activates per tab, or none.
 */
export interface PageRole {
	/** Stable identifier, also used in log lines. Matches the registry key. */
	id: string

	/**
	 * Opt into the background navigation-guard: when the tab navigates to a
	 * URL that isn't in the room's playlist (home link, address bar,
	 * back/forward, cross-site), the background pulls it back to the room's
	 * cursor. The guard matches by **video identity, not URL string** — it
	 * resolves the live tab URL to a canonical `videoId` through this
	 * adapter's pure `videoIdForUrl` matcher (registered in
	 * `src/adapters/url-matchers.ts`) and compares against the cursor +
	 * playlist. Set this `true` **only** when this adapter ships that matcher
	 * and its `pageUrl`s are canonical and navigable (miruro's `?ep=` URLs
	 * qualify). Adapters on sites where the URL doesn't encode the video
	 * identity must omit it — their DOM click listener (`emitCursorTrigger`)
	 * remains the pull-back signal, which the guard does not replace.
	 * Defaults to `false`.
	 */
	readonly guardNavigation?: boolean

	/**
	 * Pure predicate: does this adapter own the given page? The runtime calls
	 * this on every page load and SPA navigation. No side effects, no DOM
	 * reads — just URL inspection.
	 */
	canHandlePage(url: URL): boolean

	/**
	 * Bind to the top frame: wait for the page to settle, derive content
	 * identity, register the cursor-change handler, wire cursor-trigger
	 * detection, announce identity. Reject the page (call
	 * {@link PageContext.fail}) if identity can't be derived — silent fallback
	 * is forbidden.
	 */
	init(ctx: PageContext): Promise<void>

	/**
	 * Best-effort scrape of the page's episode list, for the JOIN frame's
	 * `catalogFragment` field. The runtime invokes this once per adapter
	 * lifetime, right after {@link PageRole.init} resolves, and forwards the
	 * result to the background; the background merges it into the room's
	 * playlist via the JOIN handler.
	 *
	 * Optional — adapters that can't (or don't want to) enumerate a catalog
	 * simply omit this method. The runtime applies its own timeout
	 * (`SCRAPE_CATALOG_TIMEOUT_MS` in the page runtime) and catches any thrown
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

/**
 * Media-role adapter contract: the embed-frame half of a site. Owns the
 * `<video>` and everything derived from it — resolving the element, observing
 * the user's play/pause/seek, reporting state, and applying playback commands.
 * It knows nothing about content identity, the catalog, or navigation; the
 * {@link PageRole} in the top frame owns those.
 *
 * Because a media adapter carries no site-identity knowledge, one generic media
 * adapter (e.g. `strmcx`) can serve every page site that embeds the same
 * player. Media adapters are bundled in their own registry (see the media
 * runtime's `MEDIA_ADAPTERS`) and selected by {@link MediaRole.canHandleFrame}
 * against the frame's own URL.
 */
export interface MediaRole {
	/** Stable identifier for the player/embed, also used in log lines. */
	id: string

	/**
	 * Pure predicate: does this media adapter own the given frame? Called for
	 * every frame the media content script is injected into (the top frame and
	 * every sub-frame), so it must reject frames that aren't this player's
	 * embed. No side effects, no DOM reads — just URL inspection.
	 */
	canHandleFrame(url: URL): boolean

	/**
	 * Bind to the frame's `<video>`: resolve the element, install the autoplay
	 * hold, drive cold-start if needed, wire intent listeners, register the
	 * command handler. Reject the frame (call {@link MediaContext.fail}) when
	 * no video resolves — a **soft** failure that leaves the room the page
	 * frame established untouched.
	 */
	init(ctx: MediaContext): Promise<void>

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

	/** Detach every listener and clear refs. Runtime calls this on teardown. */
	destroy(): void
}

/** Factory shape the page registry stores — keeps per-load state isolated. */
export type PageAdapterFactory = () => PageRole

/** Factory shape the media registry stores — keeps per-frame state isolated. */
export type MediaAdapterFactory = () => MediaRole

/**
 * Bridge between a page-role adapter and the rest of the extension. Adapters
 * get this via {@link PageRole.init} and never reach for `chrome.runtime`
 * directly. There is no `emitIntent` here — intents come from the `<video>`,
 * which lives in the media frame ({@link MediaContext}).
 */
export interface PageContext {
	/**
	 * Announce that the user clicked an in-page navigation control (e.g. an
	 * episode button) and is moving to a different `VideoRef`. The runtime
	 * forwards the trigger to the background, which decides — based on the
	 * room's current mode and playlist — whether to send a
	 * `CURSOR_CHANGE_REQUEST` (default-in-playlist, freeform-any) or pull
	 * the tab back to the room's cursor (default-not-in-playlist,
	 * single-any).
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
	 * server. The page frame only acts on `cursor_change`; other command
	 * types are routed to the media frame. Calling this twice replaces the
	 * previous handler.
	 */
	onCommand(handler: (cmd: AuthoritativeCommand) => void): void

	/** Report the current page's content identity. Called once after `init`. */
	setIdentity(identity: ContentIdentity): void

	/**
	 * Hard fail: this page adapter cannot run on this page. The runtime stays
	 * inactive for the tab until the next navigation. Use sparingly — most
	 * `init` problems are bugs, not legitimate "skip this page" signals.
	 */
	fail(reason: string): void

	/** Structured log line prefixed with the adapter id by the runtime. */
	log(level: 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>): void
}

/**
 * Bridge between a media-role adapter and the rest of the extension. Adapters
 * get this via {@link MediaRole.init}. There is no `setIdentity` /
 * `emitCursorTrigger` here — identity and navigation belong to the
 * {@link PageContext}.
 */
export interface MediaContext {
	/** Forward an observed user action (play/pause/seek) toward the WS client. */
	emitIntent(intent: LocalIntent): void

	/**
	 * Announce this frame owns a controllable `<video>`, called the moment it's
	 * resolved — before cold-start prep — so the background registers the owning
	 * frame id early and won't treat a phantom sibling's later videoless fail as
	 * fatal. Distinct from the post-init `media_hello`, which also drives resync.
	 */
	claimVideo(): void

	/**
	 * Register the one handler that applies authoritative commands from the
	 * server. The media frame acts on `play`/`pause`/`seek` (and exhaustively
	 * no-ops `nudge_rate`, which the runtime intercepts first). Calling this
	 * twice replaces the previous handler.
	 */
	onCommand(handler: (cmd: AuthoritativeCommand) => void): void

	/**
	 * Soft fail: no controllable `<video>` in this frame. The runtime goes
	 * inactive for the frame but the background leaves the tab's room session
	 * intact — the page frame's room must survive a videoless embed.
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
 * What the background sends to drive the page. The media frame applies `play` /
 * `pause` / `seek` verbatim; the page frame applies `cursor_change`. No
 * interpretation, no transformation. `nudge_rate` is intercepted by the media
 * runtime before it reaches the adapter: the runtime reads the adapter's
 * current position, computes the rate clamp, calls
 * {@link MediaRole.setPlaybackRate}, and schedules the restore. Media adapters
 * still exhaustively handle it in their `onCommand` switch (no-op arm) so
 * type-checking stays honest.
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
