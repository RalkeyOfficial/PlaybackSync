/**
 * Per-adapter pure URL→videoId matchers, keyed by adapter id. This mirrors
 * the factory registry in `runtime.ts`, but holds only the DOM-free URL
 * logic so the background service worker can answer "is this URL one of our
 * videos?" for the navigation guard without instantiating a (DOM-bound)
 * adapter. Each adapter owns its own URL semantics in its `url` module —
 * adding a site means adding its matcher here.
 */

import {
	navigableUrlForCursor as miruroNavigableUrlForCursor,
	videoIdForUrl as miruroVideoIdForUrl,
} from './miruro/url'

/** Adapter id → pure `(url) => canonical videoId | null`. */
const URL_MATCHERS: Record<string, (url: URL) => string | null> = {
	miruro: miruroVideoIdForUrl,
}

/**
 * Adapter id → pure `(cursor) => navigable URL | null`. Lets the background
 * build a pull-back target whose site-specific identity params (e.g.
 * miruro's `?ep=`) are reconstructed from the cursor's canonical `videoId`
 * rather than trusted from its `pageUrl`. Adapters whose sites need no such
 * reconstruction simply omit an entry (callers fall back to the raw
 * `pageUrl`).
 */
const NAVIGABLE_URL_BUILDERS: Record<string, (cursor: { videoId: string; pageUrl: string }) => string | null> = {
	miruro: miruroNavigableUrlForCursor,
}

/**
 * Resolve the canonical video id for `url` under the named adapter, or
 * `null` when the adapter doesn't recognise it (wrong site, non-content
 * page) or no matcher is registered for the id.
 *
 * @param adapterId The active adapter on the tab (from the `identity` message).
 * @param url The URL to classify.
 * @returns The canonical video id, or `null`.
 */
export function videoIdForUrl(adapterId: string, url: URL): string | null {
	return URL_MATCHERS[adapterId]?.(url) ?? null
}

/**
 * Build a canonical navigable URL for a room cursor under the named adapter,
 * with site-specific identity params reconstructed from the cursor's
 * `videoId`. Returns `null` when no builder is registered for the adapter or
 * the cursor can't be resolved — callers should fall back to the cursor's
 * raw `pageUrl`.
 *
 * @param adapterId The active adapter on the tab.
 * @param cursor The room cursor's canonical id + last-known page URL.
 * @returns A navigable URL, or `null` to signal "use the raw pageUrl".
 */
export function navigableUrlForCursor(adapterId: string, cursor: { videoId: string; pageUrl: string }): string | null {
	return NAVIGABLE_URL_BUILDERS[adapterId]?.(cursor) ?? null
}
