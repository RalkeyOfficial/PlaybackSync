import type { MediaAdapterFactory } from '../types'
import { MediaBaseAdapter } from '../media/base'
import { waitForElement } from '../video-driver'

/**
 * Host pattern for the strm.cx embed player (`strm.cx` + any subdomain). Kept
 * in sync with `EMBED_MATCHES` in `src/adapters/embed-matches.ts`, which scopes
 * where the media content script is injected — this predicate is the in-frame
 * confirmation that the injected frame really is a strm.cx player.
 */
const HOST_RE = /^(?:.*\.)?strm\.cx$/

/**
 * The embed frame is a dedicated player document — unlike a page site it has
 * no hero/trailer `<video>` to disambiguate — so a plain `video` selector is
 * safe here. Confirmed live (via the `debug-ext/` probe): inside
 * `https://strm.cx/?embed=1` the Vidstack `<video>` resolves this way and
 * carries a blob source at `readyState 4` within ~1 s, with no interaction.
 */
const VIDEO_SELECTOR = 'video'

/**
 * How long to wait for the embed's `<video>` to hydrate before giving up. A
 * soft failure here (see {@link MediaBaseAdapter}) leaves the page frame's room
 * untouched — the frame simply isn't hosting a controllable player yet.
 */
const VIDEO_WAIT_TIMEOUT_MS = 10_000

/**
 * Generic media adapter for the **strm.cx** embed player, used by any page site
 * that loads `strm.cx` in an iframe (currently miruro). It owns only the
 * `<video>` in its own frame and carries no site-identity knowledge — content
 * identity, catalog, and navigation are the page frame's job (see
 * `src/adapters/miruro/index.ts`).
 *
 * The embed loads its own source (a blob) without a manual-load control, so no
 * `ensurePlayable` override is needed — the base's `canPlay` (source present)
 * short-circuits it. `holdsAutoplay` is kept `true` so any one-shot auto-play
 * as the source settles is held until the room's first authoritative command,
 * matching the pre-embed miruro behaviour.
 */
class StrmcxAdapter extends MediaBaseAdapter {
	readonly id = 'strmcx'

	protected readonly holdsAutoplay = true

	canHandleFrame(url: URL): boolean {
		return HOST_RE.test(url.hostname)
	}

	protected resolveVideo(): Promise<HTMLVideoElement | null> {
		return waitForElement<HTMLVideoElement>(VIDEO_SELECTOR, {
			timeoutMs: VIDEO_WAIT_TIMEOUT_MS,
			signal: this.signal,
		})
	}
}

export const strmcxAdapterFactory: MediaAdapterFactory = () => new StrmcxAdapter()
