import type { AdapterFactory, ContentIdentity } from '../types';
import type { VideoRefWithMeta } from '../../background/protocol';
import { BaseAdapter } from '../base';
import { waitForElement } from '../video-driver';
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
 * Adapter for the miruro family of streaming sites (`miruro.tv` / `.to` /
 * `.bz` / `.ru`). Handles four quirks of the live site, each mapped onto a
 * {@link BaseAdapter} hook:
 *
 * 1. **Multi-video pages** — {@link resolveVideo} uses a container-scoped
 *    selector, not `document.querySelector('video')`.
 * 2. **Late hydration** — the Vidstack player mounts after `document_idle`,
 *    so {@link resolveVideo} waits via {@link waitForElement} rather than
 *    failing immediately.
 * 3. **Manual-load cold start** — on a freshly-loaded page the `<video>` has
 *    no source until a "click to load" button is activated (only via a
 *    synthesized `Space` keydown/keyup pair, not `click()`).
 *    {@link ensurePlayable} drives it.
 * 4. **One-shot auto-play** — miruro auto-plays once when the source loads;
 *    `holdsAutoplay = true` lets the base hold the video paused until the
 *    room's first `play`/`pause` command arrives.
 */
class MiruroAdapter extends BaseAdapter {
  readonly id = 'miruro';

  // miruro's watch URLs are canonical `/watch/<show>?ep=<n>` and resolve
  // cleanly to a videoId via `videoIdForUrl` (see ./url), so the background's
  // identity-based navigation-guard is safe to enable here.
  readonly guardNavigation = true;

  // miruro auto-plays exactly once when the source loads; the base holds it
  // paused until the room's first authoritative command takes over.
  protected readonly holdsAutoplay = true;

  /**
   * Memoised wait for the episode-list container. Shared by
   * {@link watchCursorTriggers} and {@link scrapeCatalog} so a single
   * `MutationObserver` serves both — the container is the stable mount point,
   * the inner buttons churn.
   */
  private episodeListPromise: Promise<Element | null> | null = null;

  /** Guards against attaching the delegated cursor-trigger listener twice. */
  private cursorTriggerAttached = false;

  canHandlePage(url: URL): boolean {
    if (!HOST_RE.test(url.hostname)) return false;
    if (!PATH_RE.test(url.pathname)) return false;
    // `?ep=` is intentionally NOT required here: miruro sometimes loads the
    // watch page without the query param and adds it via `replaceState` once
    // the player initialises. The ep is re-read in `resolveIdentity` after the
    // video element is found, by which time the param has arrived. If it still
    // hasn't, the base calls `ctx.fail` and the runtime's URL-change listener
    // re-evaluates when the param finally appears.
    return true;
  }

  protected resolveVideo(): Promise<HTMLVideoElement | null> {
    return waitForElement<HTMLVideoElement>(VIDEO_SELECTOR, {
      timeoutMs: VIDEO_WAIT_TIMEOUT_MS,
      signal: this.signal,
    });
  }

  protected resolveIdentity(): ContentIdentity | null {
    const showId = PATH_RE.exec(location.pathname)?.[1];
    if (!showId) return null;
    // Re-read ep *after* the video wait (which resolveVideo guarantees before
    // this runs): miruro often appends `?ep=` only after the player
    // initialises, so reading at adapter entry is racy.
    const ep = new URL(location.href).searchParams.get('ep');
    if (!ep) return null;
    return {
      providerId: 'miruro',
      videoId: makeVideoId(showId, ep),
      normalizedUrl: `/watch/${showId}?ep=${ep}`,
    };
  }

  /**
   * Ensure the `<video>` has a source. The base only calls this when
   * {@link BaseAdapter.canPlay} is false (no `currentSrc`). On cold loads
   * miruro renders the player with an empty `<video>` and a manual-load button
   * that only responds to a `Space` keydown/keyup pair (a regular `click()` is
   * ignored — verified live). After the source arrives the video is paused
   * immediately so the room's authoritative state can take over without a
   * flash of auto-play.
   */
  protected async ensurePlayable(): Promise<void> {
    const video = this.video;
    if (!video) return;

    const button = await this.waitForLoadButton(video);
    if (this.signal.aborted) return;
    if (video.currentSrc) {
      this.log('info', 'video gained a source while waiting for manual-load button');
      return;
    }
    if (!button) {
      this.log(
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
    await new Promise((r) => setTimeout(r, LOAD_BUTTON_SETTLE_MS));
    if (this.signal.aborted) return;

    this.log('info', 'dispatching synthesized Space keydown/keyup on manual-load button');
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

    await new Promise<void>((resolve) => {
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

    if (this.signal.aborted) return;
    // Vidstack auto-plays after the load; pause immediately so the room's
    // first authoritative command (default: paused) wins without a race. The
    // base's autoplay hold also re-pauses, but pausing here avoids the flash.
    video.pause();
  }

  /**
   * Apply an authoritative `cursor_change` command by replaying the user's
   * own click path: find the episode button whose extracted `EP <n>` matches
   * the target's `?ep=` parameter, then `.click()` it so miruro's SPA routing
   * performs the navigation exactly as it does for a real user. The episode is
   * matched on the parsed ep number, not on playlist order — owners can
   * reorder the room's playlist freely, and the cursor still resolves to the
   * right DOM element.
   *
   * Falls back to a full `location.href` navigation when:
   * - we're already at the target URL (typical for the original sender,
   *   whose SPA route updated before the broadcast came back);
   * - the target URL parses to a different show (miruro's SPA only handles
   *   in-show ep changes);
   * - the episode list isn't in the DOM yet (cold page mid-hydration);
   * - no button matches the target ep (paginated lists, season filters).
   *
   * The synthetic `.click()` is filtered out of the cursor-trigger listener
   * via `Event.isTrusted` (see {@link watchCursorTriggers}) so we don't loop
   * the broadcast back to the server as a fresh `CURSOR_CHANGE_REQUEST`.
   *
   * @param pageUrl The target page URL from the broadcast.
   */
  protected applyCursorChange(pageUrl: string): void {
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

    // Fresh live query (not the memoised promise): the list can re-render, and
    // an authoritative cursor change may arrive long after init.
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
   * Attach a single delegated `click` listener to the episode-list container
   * so any episode button click — current or future — emits a cursor trigger.
   * Fire-and-forget: it waits for the container off the critical path so it
   * never delays activation. The listener is passive (no `preventDefault`), so
   * miruro's own SPA routing handles the local nav; the background decides per
   * room mode whether to forward the trigger or pull the tab back.
   */
  protected watchCursorTriggers(): void {
    const match = PATH_RE.exec(location.pathname);
    const showId = match?.[1];
    if (!showId) return;
    const slug = match?.[2] ?? null;
    void this.episodeList().then((container) => {
      if (!container || this.signal.aborted) return;
      this.attachEpisodeListClickHandler(container, showId, slug);
    });
  }

  async scrapeCatalog(): Promise<VideoRefWithMeta[] | null> {
    if (this.signal.aborted) return null;

    const pathMatch = PATH_RE.exec(location.pathname);
    const showId = pathMatch?.[1];
    if (!showId) return null;
    // The slug is the same for every episode of this show; capture it once
    // here and thread it into the emitted pageUrls so navigation targets are
    // the canonical, redirect-free (and thus credential-param-preserving) form.
    const slug = pathMatch?.[2] ?? null;

    const container = await this.episodeList();
    if (this.signal.aborted || !container) return null;

    const entries = this.collectEpisodeEntries(container, showId, slug);
    return entries.length > 0 ? entries : null;
  }

  /**
   * Memoised wait for `#episodes-list-container`. Both {@link scrapeCatalog}
   * and {@link watchCursorTriggers} need it; sharing one promise means one
   * observer/timer pair, torn down on destroy via {@link BaseAdapter.signal}.
   */
  private episodeList(): Promise<Element | null> {
    if (!this.episodeListPromise) {
      this.episodeListPromise = waitForElement(EPISODE_LIST_CONTAINER_SELECTOR, {
        timeoutMs: EPISODE_LIST_WAIT_TIMEOUT_MS,
        signal: this.signal,
      });
    }
    return this.episodeListPromise;
  }

  /**
   * Resolve to the manual-load button, or `null` on timeout, on adapter
   * teardown, or as soon as the video begins loading a source on its own
   * (the `loadstart` short-circuit — so a page that self-loads doesn't waste
   * the full timeout). The `loadstart` listener rides the adapter's lifetime
   * signal, so it's cleaned up with everything else on destroy.
   *
   * @param video Player element, watched for `loadstart`.
   */
  private waitForLoadButton(video: HTMLVideoElement): Promise<HTMLButtonElement | null> {
    const loadStarted = new AbortController();
    video.addEventListener('loadstart', () => loadStarted.abort(), {
      once: true,
      signal: this.signal,
    });
    return waitForElement<HTMLButtonElement>(LOAD_BUTTON_SELECTOR, {
      timeoutMs: LOAD_BUTTON_WAIT_TIMEOUT_MS,
      signal: AbortSignal.any([this.signal, loadStarted.signal]),
    });
  }

  private attachEpisodeListClickHandler(container: Element, showId: string, slug: string | null): void {
    if (this.cursorTriggerAttached) return;
    this.cursorTriggerAttached = true;
    container.addEventListener(
      'click',
      (ev: Event) => {
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
        this.emitCursorTrigger({
          providerId: 'miruro',
          videoId: makeVideoId(showId, ep),
          pageUrl: makeWatchUrl(location.origin, showId, ep, slug),
          episodeNumber: ep,
          label: button.title.trim() || null,
        });
      },
      { signal: this.signal }
    );
  }

  /**
   * Walk the episode-list container and turn each button into a
   * `VideoRefWithMeta`. The episode number comes from the button's `title`
   * attribute (`EP 1: Kanan's Easy` → `1`); the rendered `EP <n>` span is in
   * the DOM too but lives behind hashed-class wrappers that flip on every
   * build, so the title is the durable signal. Drops buttons whose title
   * doesn't match — better a short catalog than a fabricated entry that fans
   * out to the rest of the room via `PlaylistService::merge`.
   *
   * @param container The `#episodes-list-container` element.
   * @param showId The show id extracted from `/watch/<showId>`.
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
   * `EP 1: Kanan's Easy` → `1`). Returns `null` when the title doesn't match
   * the consistent `EP <number>` prefix miruro renders.
   */
  private extractEpisodeNumber(node: HTMLButtonElement): number | null {
    const match = EPISODE_TITLE_RE.exec(node.title);
    if (!match) return null;
    const n = parseInt(match[1], 10);
    return Number.isFinite(n) ? n : null;
  }
}

export const miruroAdapterFactory: AdapterFactory = () => new MiruroAdapter();
