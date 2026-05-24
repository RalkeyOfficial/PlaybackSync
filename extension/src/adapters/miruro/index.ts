import type { Adapter, AdapterContext, AdapterFactory, LocalIntent, VideoState } from '../types';

/**
 * Hosts the adapter recognises. miruro rotates TLDs; the enumerated list is
 * preferred over a `miruro\.[a-z]+` wildcard so a hostile actor registering
 * `miruro.<somewhere>` can't trigger the adapter. Adding a new TLD is a code
 * change + release.
 */
const HOST_RE = /^(www\.)?miruro\.(tv|to|bz|ru)$/;

/**
 * Watch-page path shape: `/watch/<showId>` or `/watch/<showId>/<slug>` with
 * an optional trailing slash. The slug is discarded in identity derivation
 * because it's locale-dependent.
 */
const PATH_RE = /^\/watch\/([^/]+)(?:\/[^/]+)?\/?$/;

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
 * How long to wait for `loadedmetadata` after dispatching the synthesized
 * space-press. If the source never arrives the adapter still proceeds with
 * listener wiring — the user can press play themselves, and the room's
 * authoritative state will reconcile.
 */
const LOAD_TIMEOUT_MS = 5_000;

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
 *    not a `click()`. The adapter dispatches that sequence at init and
 *    pauses immediately after the source loads, so the room's
 *    authoritative state takes over without a flash of auto-play.
 */
class MiruroAdapter implements Adapter {
  readonly id = 'miruro';

  private video: HTMLVideoElement | null = null;
  private listeners: Array<[keyof HTMLMediaElementEventMap, () => void]> = [];
  private pendingObserver: MutationObserver | null = null;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;

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
      switch (cmd.type) {
        case 'play':
          void video.play();
          return;
        case 'pause':
          video.pause();
          return;
        case 'seek':
          video.currentTime = cmd.time;
          return;
        case 'sync_adjust':
          video.currentTime += cmd.delta;
          return;
        case 'cursor_change':
          // In-page navigation on cursor change lands in a later spec.
          return;
      }
    });

    ctx.setIdentity({
      providerId: 'miruro',
      videoId: `${showId}-ep${ep}`,
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

  destroy(): void {
    this.destroyed = true;
    this.cancelPendingObserver();
    if (this.video) {
      for (const [evt, fn] of this.listeners) {
        this.video.removeEventListener(evt, fn);
      }
    }
    this.listeners = [];
    this.video = null;
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

    const button = document.querySelector<HTMLButtonElement>(LOAD_BUTTON_SELECTOR);
    if (!button) {
      ctx.log(
        'warn',
        'no source and no manual-load button — letting the user start playback manually'
      );
      return;
    }

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
