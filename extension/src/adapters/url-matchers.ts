/**
 * Per-adapter pure URL→videoId matchers, keyed by adapter id. This mirrors
 * the factory registry in `runtime.ts`, but holds only the DOM-free URL
 * logic so the background service worker can answer "is this URL one of our
 * videos?" for the navigation guard without instantiating a (DOM-bound)
 * adapter. Each adapter owns its own URL semantics in its `url` module —
 * adding a site means adding its matcher here.
 */

import { videoIdForUrl as miruro } from './miruro/url'

/** Adapter id → pure `(url) => canonical videoId | null`. */
const URL_MATCHERS: Record<string, (url: URL) => string | null> = {
	miruro,
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
