import type { Adapter, AdapterContext, AdapterFactory, LocalIntent, VideoState } from '../types';
import type { VideoRefWithMeta } from '../../background/protocol';
// Host/path patterns and the video-id format live in the pure `url` module
// so the background's navigation guard can share them (see that file and
// `src/adapters/url-matchers.ts`).
import { HOST_RE, PATH_RE, makeVideoId, makeWatchUrl } from './url';

/**
 * Scoped selector for the *player's* video element. miruro can render a
 * second `<video>` elsewhere on the page (trailer / hero), so a
 * document-wide `querySelector('video')` is unsafe.
 */
const VIDEO_SELECTOR = '#player-container .player video';

/**
 * miruro's cold-page "click to load" button. Lives in the Vidstack layout
 * overlay. A regular `click()` does not trigger the load — the player only
 * responds to the keyboard `Space` activation, so the adapter dispatches the
 * full keydown + keyup pair when needed.
 */
const LOAD_BUTTON_SELECTOR = '#player-container .vds-video-layout button';

/**
 * How long the adapter waits for the Vidstack player to hydrate. Beyond
 * this the page is treated as unsupported and the adapter fails — better
 * to be silent than to attach to a partially-rendered player.
 */
const VIDEO_WAIT_TIMEOUT_MS = 10_000;

/**
 * How long to wait for the manual-load button after the `<video>` element
 * has appeared. The button is rendered by the Vidstack layout overlay and
 * lands a few frames after the `<video>` itself, so a synchronous lookup
 * right after {@link VIDEO_SELECTOR} resolves is racy.
 */
const LOAD_BUTTON_WAIT_TIMEOUT_MS = 5_000;

/**
 * Settle time between the button appearing in the DOM and dispatching the
 * synthesized Space activation. Vidstack inserts the button before its
 * click handler is fully wired; dispatching immediately reaches a no-op
 * handler. Verified empirically on miruro: 300ms covers the gap.
 */
const LOAD_BUTTON_SETTLE_MS = 300;

/**
 * How long to wait for `loadedmetadata` after dispatching the synthesized
 * space-press. If the source never arrives the adapter still proceeds with
 * listener wiring — the user can press play themselves, and the room's
 * authoritative state will reconcile.
 */
const LOAD_TIMEOUT_MS = 5_000;

/**
 * Selectors used by {@link MiruroAdapter.scrapeCatalog}. miruro's class
 * names rotate with build hashes (e.g. `_seasonTitle_1vb3r_84`); the
 * selectors below stick to stable IDs and `data-*` / `title` attributes
 * so a build flip can't silently mis-route entries into the room's
 * playlist. If miruro renames `#episodes-list-container` or drops
 * `data-episode-id`, `scrapeCatalog` returns `null` cleanly rather than
 * scraping garbage.
 */
const EPISODE_LIST_CONTAINER_SELECTOR = '#episodes-list-container';
const EPISODE_LIST_ENTRY_SELECTOR = 'button[data-episode-id]';

/**
 * Parser for the episode number on each entry's `title` attribute. The
 * format is consistently `EP <number>: <title>` (e.g.
 * `EP 1: Kanan's Easy`), so the regex pulls the leading number out of
 * the user-facing string. Stable signal — the rendered `<span>` shows
 * the same `EP <number>` text but lives behind hashed-class wrappers.
 */
const EPISODE_TITLE_RE = /^EP\s+(\d+)\b/i;

/**
 * How long {@link MiruroAdapter.scrapeCatalog} waits for the episode-list
 * container to appear in the DOM. Capped well under the runtime's overall
 * `SCRAPE_CATALOG_TIMEOUT_MS` (2 s) so the runtime never has to interrupt
 * a still-running scrape on the common path.
 */
const EPISODE_LIST_WAIT_TIMEOUT_MS = 1_500;

/**
 * Safety release for the autoplay hold. miruro auto-plays exactly once at
 * load; the hold pauses that and waits for the room's first authoritative
 * command to take over. If no command ever arrives (e.g. a brand-new room
 * with no state yet) the hold lifts after this window so the viewer is
 * never left unable to start playback. The happy path lifts it far sooner.
 */
const AUTOPLAY_HOLD_TIMEOUT_MS = 10_000;

/**
 * Adapter for the miruro family of streaming sites (`miruro.tv` / `.to` /
 * `.bz` / `.ru`). Handles three quirks of the live site:
 *
 * 1. **Multi-video pages** — the player's `<video>` is reached via a
 *    container-scoped selector, not `document.querySelector('video')`.
 * 2. **Late hydration** — the Vidstack player mounts after
 *    `document_idle`, so the adapter waits via `MutationObserver` rather
 *    than failing immediately.
 * 3. **Manual-load cold start** — on a freshly-loaded page the `<video>`
 *    has no source until a "click to load" button is activated. The
 *    button only responds to a synthesized `Space` keydown/keyup pair,
 *    not a `click()`. The adapter dispatches that sequence at init.
 * 4. **One-shot auto-play** — miruro auto-plays once when the source
 *    loads. The adapter holds the video paused (re-pausing on any `play`)
 *    until the room's first authoritative command arrives, so playback
 *    starts paused and the room state decides play/pause without a flash
 *    of auto-play. See {@link AUTOPLAY_HOLD_TIMEOUT_MS}.
 */
class MiruroAdapter implements Adapter {
  readonly id = 'miruro';

  // miruro's watch URLs are canonical `/watch/<show>?ep=<n>` and resolve
  // cleanly to a videoId via `videoIdForUrl` (see ./url), so the background's
  // identity-based navigation-guard is safe to enable here.
  readonly guardNavigation = true;

  private ctx: AdapterContext | null = null;
  private video: HTMLVideoElement | null = null;
  private listeners: Array<[keyof HTMLMediaElementEventMap, () => void]> = [];
  private pendingObserver: MutationObserver | null = null;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;
  private catalogObserver: MutationObserver | null = null;
  private catalogTimer: ReturnType<typeof setTimeout> | null = null;
  private cursorTriggerContainer: Element | null = null;
  private cursorTriggerHandler: ((ev: Event) => void) | null = null;
  private destroyed = false;

  // While held, miruro's one-shot load auto-play is immediately re-paused
  // so the video sits paused until the room's first authoritative command
  // takes over (see {@link AUTOPLAY_HOLD_TIMEOUT_MS}). Released in the
  // `onCommand` handler — the room is then in control of play/pause.
  private autoplayHeld = true;
  private autoplayHoldHandler: (() => void) | null = null;
  private autoplayHoldTimer: ReturnType<typeof setTimeout> | null = null;

  canHandlePage(url: URL): boolean {
    if (!HOST_RE.test(url.hostname)) return false;
    if (!PATH_RE.test(url.pathname)) return false;
    // `?ep=` is intentionally NOT required here: miruro sometimes loads the
    // watch page without the query param and adds it via `replaceState` once
    // the player initialises. The ep is re-read in `init` after the video
    // element is found, by which time the param has arrived. If it still
    // hasn't, `init` calls `ctx.fail` and the runtime's URL-change listener
    // re-evaluates when the param finally appears.
    return true;
  }

  async init(ctx: AdapterContext): Promise<void> {
    this.ctx = ctx;
    const pathMatch = PATH_RE.exec(location.pathname);
    const showId = pathMatch?.[1];
    if (!showId) {
      ctx.fail('miruro: missing showId in path');
      return;
    }

    const video = await this.waitForVideo();
    if (!video) {
      ctx.fail(`miruro: <video> not found within ${VIDEO_WAIT_TIMEOUT_MS}ms`);
      return;
    }
    if (this.destroyed) return;
    this.video = video;

    // Hold miruro's one-shot load auto-play: re-pause on any `play` until
    // the room's first authoritative command arrives. Attached *before*
    // `ensureLoaded` so it catches the auto-play whichever path the load
    // takes (warm revisit with a source already present, or cold manual-
    // load), and on whatever event it fires. Released in `onCommand`.
    const holdAutoplay = () => {
      if (this.autoplayHeld && this.video && !this.video.paused) {
        this.video.pause();
      }
    };
    this.autoplayHoldHandler = holdAutoplay;
    video.addEventListener('play', holdAutoplay);
    this.autoplayHoldTimer = setTimeout(() => {
      this.autoplayHeld = false;
    }, AUTOPLAY_HOLD_TIMEOUT_MS);

    // Re-read ep *after* the video wait: miruro often appends `?ep=` only
    // after the player initialises, so reading at adapter entry is racy.
    const ep = new URL(location.href).searchParams.get('ep');
    if (!ep) {
      ctx.fail('miruro: ep still missing after video hydration');
      return;
    }

    await this.ensureLoaded(video, ctx);
    if (this.destroyed) return;

    const emit = (type: LocalIntent['type']) => () => {
      ctx.emitIntent({ type, time: video.currentTime });
    };
    this.listeners = [
      ['play', emit('play')],
      ['pause', emit('pause')],
      ['seeking', emit('seek')],
    ];
    for (const [evt, fn] of this.listeners) {
      video.addEventListener(evt, fn);
    }

    ctx.onCommand(cmd => {
      // The room is now authoritative over playback: lift the auto-play
      // hold before applying, so a room `play` command isn't re-paused by
      // the hold guard by running `this.releaseAutoplayHold()`.
      switch (cmd.type) {
        case 'play':
          this.releaseAutoplayHold();
          void video.play();
          return;
        case 'pause':
          this.releaseAutoplayHold();
          video.pause();
          return;
        case 'seek':
          video.currentTime = cmd.time;
          return;
        case 'nudge_rate':
          // The runtime intercepts `nudge_rate` before it reaches the
          // adapter and drives `setPlaybackRate` itself; this arm exists
          // only for switch exhaustiveness.
          return;
        case 'cursor_change':
          this.applyCursorChange(cmd.pageUrl);
          return;
      }
    });

    ctx.setIdentity({
      providerId: 'miruro',
      videoId: makeVideoId(showId, ep),
      normalizedUrl: `/watch/${showId}?ep=${ep}`,
    });
  }

  getState(): VideoState | null {
    const video = this.video;
    if (!video) return null;
    // HAVE_FUTURE_DATA = 3 — anything below means the next frame isn't
    // available yet, which is "actually buffering" rather than paused.
    const buffering = !video.paused && video.readyState < 3;
    return {
      currentPos: video.currentTime,
      playerState: buffering ? 'buffering' : video.paused ? 'paused' : 'playing',
    };
  }

  setPlaybackRate(rate: number): void {
    if (this.video) this.video.playbackRate = rate;
  }

  async scrapeCatalog(): Promise<VideoRefWithMeta[] | null> {
    if (this.destroyed) return null;

    const pathMatch = PATH_RE.exec(location.pathname);
    const showId = pathMatch?.[1];
    if (!showId) return null;
    // The slug is the same for every episode of this show; capture it once
    // here and thread it into the emitted pageUrls so navigation targets are
    // the canonical, redirect-free (and thus credential-param-preserving) form.
    const slug = pathMatch?.[2] ?? null;

    const container = await this.waitForEpisodeList();
    if (this.destroyed || !container) return null;

    this.attachEpisodeListClickHandler(container, showId, slug);
    const entries = this.collectEpisodeEntries(container, showId, slug);
    return entries.length > 0 ? entries : null;
  }

  destroy(): void {
    this.destroyed = true;
    this.cancelPendingObserver();
    this.cancelCatalogObserver();
    if (this.cursorTriggerContainer && this.cursorTriggerHandler) {
      this.cursorTriggerContainer.removeEventListener('click', this.cursorTriggerHandler);
    }
    this.cursorTriggerContainer = null;
    this.cursorTriggerHandler = null;
    if (this.video) {
      for (const [evt, fn] of this.listeners) {
        this.video.removeEventListener(evt, fn);
      }
      if (this.autoplayHoldHandler) {
        this.video.removeEventListener('play', this.autoplayHoldHandler);
      }
    }
    if (this.autoplayHoldTimer !== null) {
      clearTimeout(this.autoplayHoldTimer);
      this.autoplayHoldTimer = null;
    }
    this.autoplayHoldHandler = null;
    this.listeners = [];
    this.video = null;
    this.ctx = null;
  }

  /**
   * Lift the auto-play hold installed in {@link init}: stop re-pausing on
   * `play`, drop the hold listener, and cancel the safety timer. Idempotent
   * — called on the room's first authoritative command and again on
   * {@link destroy} via the cleanup there.
   */
  private releaseAutoplayHold(): void {
    if (!this.autoplayHeld) return;
    this.autoplayHeld = false;
    if (this.autoplayHoldTimer !== null) {
      clearTimeout(this.autoplayHoldTimer);
      this.autoplayHoldTimer = null;
    }
    if (this.video && this.autoplayHoldHandler) {
      this.video.removeEventListener('play', this.autoplayHoldHandler);
      this.autoplayHoldHandler = null;
    }
  }

  /**
   * Resolve once `#player-container .player video` exists. Vidstack
   * hydrates after `document_idle`, so synchronous lookup is racy.
   * Resolves to `null` after {@link VIDEO_WAIT_TIMEOUT_MS} so the caller
   * can `ctx.fail` cleanly.
   */
  private waitForVideo(): Promise<HTMLVideoElement | null> {
    const immediate = document.querySelector<HTMLVideoElement>(VIDEO_SELECTOR);
    if (immediate) return Promise.resolve(immediate);

    return new Promise(resolve => {
      const finish = (el: HTMLVideoElement | null) => {
        this.cancelPendingObserver();
        resolve(el);
      };

      this.pendingObserver = new MutationObserver(() => {
        const el = document.querySelector<HTMLVideoElement>(VIDEO_SELECTOR);
        if (el) finish(el);
      });
      this.pendingObserver.observe(document.body, {
        childList: true,
        subtree: true,
      });

      this.pendingTimer = setTimeout(() => finish(null), VIDEO_WAIT_TIMEOUT_MS);
    });
  }

  /**
   * Resolve once the manual-load button exists. The button is rendered by
   * the Vidstack layout overlay a few frames after the `<video>` itself,
   * so a synchronous lookup right after {@link waitForVideo} resolves
   * misses it on cold loads. Short-circuits via the video's `loadstart`
   * event so a page that loads its source on its own doesn't waste the
   * full timeout. Resolves to `null` after
   * {@link LOAD_BUTTON_WAIT_TIMEOUT_MS} or if the video begins loading on
   * its own.
   *
   * @param video Player element returned by {@link waitForVideo}, watched
   *   for `loadstart` so we can give up on the manual-load path early
   *   when the source arrives without intervention.
   */
  private waitForLoadButton(video: HTMLVideoElement): Promise<HTMLButtonElement | null> {
    const immediate = document.querySelector<HTMLButtonElement>(LOAD_BUTTON_SELECTOR);
    if (immediate) return Promise.resolve(immediate);

    return new Promise(resolve => {
      const onLoadStart = () => finish(null);
      const finish = (el: HTMLButtonElement | null) => {
        this.cancelPendingObserver();
        video.removeEventListener('loadstart', onLoadStart);
        resolve(el);
      };

      video.addEventListener('loadstart', onLoadStart, { once: true });

      this.pendingObserver = new MutationObserver(() => {
        const el = document.querySelector<HTMLButtonElement>(LOAD_BUTTON_SELECTOR);
        if (el) finish(el);
      });
      this.pendingObserver.observe(document.body, {
        childList: true,
        subtree: true,
      });

      this.pendingTimer = setTimeout(() => finish(null), LOAD_BUTTON_WAIT_TIMEOUT_MS);
    });
  }

  private cancelPendingObserver(): void {
    if (this.pendingObserver) {
      this.pendingObserver.disconnect();
      this.pendingObserver = null;
    }
    if (this.pendingTimer !== null) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
  }

  /**
   * Resolve to the first matching episode-list container element, or
   * `null` after {@link EPISODE_LIST_WAIT_TIMEOUT_MS}. Uses its own
   * observer/timer pair so it can coexist with {@link waitForVideo} /
   * {@link waitForLoadButton} on cold pages (the manual-load flow may
   * still be in flight when the runtime fires scrapeCatalog).
   */
  private waitForEpisodeList(): Promise<Element | null> {
    const immediate = this.queryEpisodeList();
    if (immediate) return Promise.resolve(immediate);

    return new Promise(resolve => {
      const finish = (el: Element | null) => {
        this.cancelCatalogObserver();
        resolve(el);
      };

      this.catalogObserver = new MutationObserver(() => {
        const el = this.queryEpisodeList();
        if (el) finish(el);
      });
      this.catalogObserver.observe(document.body, {
        childList: true,
        subtree: true,
      });

      this.catalogTimer = setTimeout(() => finish(null), EPISODE_LIST_WAIT_TIMEOUT_MS);
    });
  }

  private queryEpisodeList(): Element | null {
    return document.querySelector(EPISODE_LIST_CONTAINER_SELECTOR);
  }

  private cancelCatalogObserver(): void {
    if (this.catalogObserver) {
      this.catalogObserver.disconnect();
      this.catalogObserver = null;
    }
    if (this.catalogTimer !== null) {
      clearTimeout(this.catalogTimer);
      this.catalogTimer = null;
    }
  }

  /**
   * Apply an authoritative `cursor_change` command by replaying the
   * user's own click path: find the episode button whose extracted
   * `EP <n>` matches the target's `?ep=` parameter, then `.click()` it
   * so miruro's SPA routing performs the navigation exactly as it does
   * for a real user. The episode is matched on the parsed ep number,
   * not on playlist order — owners can reorder the room's playlist
   * freely, and the cursor still resolves to the right DOM element.
   *
   * Falls back to a full `location.href` navigation when:
   * - we're already at the target URL (typical for the original sender,
   *   whose SPA route updated before the broadcast came back);
   * - the target URL parses to a different show (miruro's SPA only
   *   handles in-show ep changes);
   * - the episode list isn't in the DOM yet (cold page mid-hydration);
   * - no button matches the target ep (paginated lists, season filters).
   *
   * The synthetic `.click()` is filtered out of the cursor-trigger
   * listener via `Event.isTrusted` so we don't loop the broadcast back
   * to the server as a fresh `CURSOR_CHANGE_REQUEST`.
   *
   * @param pageUrl The target page URL from the broadcast.
   */
  private applyCursorChange(pageUrl: string): void {
    if (location.href === pageUrl) return;

    let target: URL;
    try {
      target = new URL(pageUrl);
    } catch {
      return;
    }

    const targetShowId = PATH_RE.exec(target.pathname)?.[1];
    const targetEpStr = target.searchParams.get('ep');
    const currentShowId = PATH_RE.exec(location.pathname)?.[1];
    if (!targetShowId || !targetEpStr || currentShowId !== targetShowId) {
      location.href = pageUrl;
      return;
    }

    const targetEp = parseInt(targetEpStr, 10);
    if (!Number.isFinite(targetEp)) {
      location.href = pageUrl;
      return;
    }

    const container = document.querySelector(EPISODE_LIST_CONTAINER_SELECTOR);
    if (!container) {
      location.href = pageUrl;
      return;
    }

    for (const btn of container.querySelectorAll<HTMLButtonElement>(EPISODE_LIST_ENTRY_SELECTOR)) {
      if (this.extractEpisodeNumber(btn) === targetEp) {
        btn.click();
        return;
      }
    }

    location.href = pageUrl;
  }

  /**
   * Attach a single delegated `click` listener to the episode-list
   * container so any episode button click — current or future — emits a
   * cursor trigger. Listener is passive: it does NOT call
   * `preventDefault`, so miruro's own SPA routing handles the local nav
   * exactly as it always does. The background decides per current room
   * mode whether to forward the trigger as a `CURSOR_CHANGE_REQUEST` or
   * pull the tab back to the room's cursor.
   *
   * Delegation on the container (rather than per-button listeners + a
   * `WeakSet`) is robust against miruro re-rendering the list when the
   * user changes seasons or scrolls — the container is the stable
   * mount point, the inner buttons churn.
   *
   * @param container The `#episodes-list-container` element returned by
   *   {@link waitForEpisodeList}.
   * @param showId The show id extracted from `/watch/<showId>` in
   *   {@link scrapeCatalog}.
   * @param slug The optional human-readable show slug from the path, kept in
   *   the emitted `pageUrl` so the navigation target is the canonical form.
   */
  private attachEpisodeListClickHandler(container: Element, showId: string, slug: string | null): void {
    if (this.cursorTriggerHandler) return;
    const handler = (ev: Event) => {
      // Skip the synthetic clicks {@link applyCursorChange} dispatches to
      // replay an authoritative cursor change in this tab — otherwise the
      // broadcast would loop back to the server as a fresh
      // `CURSOR_CHANGE_REQUEST`.
      if (!ev.isTrusted) return;
      const target = ev.target;
      if (!(target instanceof Element)) return;
      const button = target.closest<HTMLButtonElement>(EPISODE_LIST_ENTRY_SELECTOR);
      if (!button || !container.contains(button)) return;
      const ep = this.extractEpisodeNumber(button);
      if (ep === null) return;
      this.ctx?.emitCursorTrigger({
        providerId: 'miruro',
        videoId: makeVideoId(showId, ep),
        pageUrl: makeWatchUrl(location.origin, showId, ep, slug),
        episodeNumber: ep,
        label: button.title.trim() || null,
      });
    };
    container.addEventListener('click', handler);
    this.cursorTriggerContainer = container;
    this.cursorTriggerHandler = handler;
  }

  /**
   * Walk the episode-list container and turn each button into a
   * `VideoRefWithMeta`. The episode number comes from the button's
   * `title` attribute (`EP 1: Kanan's Easy` → `1`); the rendered
   * `EP <n>` span is in the DOM too but lives behind hashed-class
   * wrappers that flip on every build, so the title is the durable
   * signal. Drops buttons whose title doesn't match — better a short
   * catalog than a fabricated entry that fans out to the rest of the
   * room via `PlaylistService::merge`.
   *
   * @param container The `#episodes-list-container` element returned
   *   by {@link waitForEpisodeList}.
   * @param showId The show id extracted from `/watch/<showId>` in
   *   {@link scrapeCatalog}.
   * @param slug The optional human-readable show slug from the path, kept in
   *   each entry's `pageUrl` so the navigation target is the canonical form.
   */
  private collectEpisodeEntries(container: Element, showId: string, slug: string | null): VideoRefWithMeta[] {
    const seen = new Set<string>();
    const entries: VideoRefWithMeta[] = [];
    for (const node of container.querySelectorAll<HTMLButtonElement>(EPISODE_LIST_ENTRY_SELECTOR)) {
      const ep = this.extractEpisodeNumber(node);
      if (ep === null) continue;
      const key = makeVideoId(showId, ep);
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({
        providerId: 'miruro',
        videoId: key,
        pageUrl: makeWatchUrl(location.origin, showId, ep, slug),
        episodeNumber: ep,
        label: node.title.trim() || null,
      });
    }
    return entries;
  }

  /**
   * Parse the episode number from a button's `title` attribute (e.g.
   * `EP 1: Kanan's Easy` → `1`). Returns `null` when the title doesn't
   * match the consistent `EP <number>` prefix miruro renders.
   */
  private extractEpisodeNumber(node: HTMLButtonElement): number | null {
    const match = EPISODE_TITLE_RE.exec(node.title);
    if (!match) return null;
    const n = parseInt(match[1], 10);
    return Number.isFinite(n) ? n : null;
  }

  /**
   * Ensure the `<video>` has a source. On cold loads miruro renders the
   * player with an empty `<video>` and a manual-load button that only
   * responds to a `Space` keydown/keyup pair (a regular `click()` is
   * ignored — verified live). After the source arrives the video is
   * paused immediately so the room's authoritative state can take over
   * without a flash of auto-play.
   *
   * @param video Player element returned by {@link waitForVideo}.
   * @param ctx Adapter context, used for structured logging only.
   */
  private async ensureLoaded(video: HTMLVideoElement, ctx: AdapterContext): Promise<void> {
    if (video.currentSrc) {
      ctx.log('info', 'video already has a source; skipping manual-load trigger');
      return;
    }

    const button = await this.waitForLoadButton(video);
    if (this.destroyed) return;
    if (video.currentSrc) {
      ctx.log('info', 'video gained a source while waiting for manual-load button');
      return;
    }
    if (!button) {
      ctx.log(
        'warn',
        `no source and no manual-load button after ${LOAD_BUTTON_WAIT_TIMEOUT_MS}ms — letting the user start playback manually`
      );
      return;
    }

    // Vidstack inserts the button into the DOM before its click handler is
    // fully wired up. A synchronous dispatch reaches the button but the
    // handler is a no-op; the responsive-layout pass + capability detection
    // settle a few hundred ms later, and only then does the click actually
    // start playback. See {@link LOAD_BUTTON_SETTLE_MS}.
    await new Promise(r => setTimeout(r, LOAD_BUTTON_SETTLE_MS));
    if (this.destroyed) return;

    ctx.log('info', 'dispatching synthesized Space keydown/keyup on manual-load button');
    button.focus();
    const eventInit: KeyboardEventInit = {
      key: ' ',
      code: 'Space',
      keyCode: 32,
      which: 32,
      bubbles: true,
      cancelable: true,
    };
    button.dispatchEvent(new KeyboardEvent('keydown', eventInit));
    button.dispatchEvent(new KeyboardEvent('keyup', eventInit));

    await new Promise<void>(resolve => {
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        video.removeEventListener('loadedmetadata', settle);
        clearTimeout(timer);
        resolve();
      };
      video.addEventListener('loadedmetadata', settle, { once: true });
      const timer = setTimeout(settle, LOAD_TIMEOUT_MS);
    });

    if (this.destroyed) return;
    // Vidstack auto-plays after the load; pause immediately so the room's
    // first authoritative command (default: paused) wins without a race.
    video.pause();
  }
}

export const miruroAdapterFactory: AdapterFactory = () => new MiruroAdapter();
