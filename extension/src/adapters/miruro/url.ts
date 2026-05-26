/**
 * Pure, DOM-free URL helpers for the miruro family of sites
 * (`miruro.tv` / `.to` / `.bz` / `.ru`). Kept in a separate module from the
 * adapter so the background service worker can import them for
 * navigation-guard URL matching (see `src/adapters/url-matchers.ts`)
 * without pulling in the DOM-bound adapter class. Both this module and the
 * adapter share the host/path patterns and the video-id format so the two
 * never drift.
 */

export const HOST_RE = /^(www\.)?miruro\.(tv|to|bz|ru)$/;

/**
 * Watch-page path shape: `/watch/<showId>` or `/watch/<showId>/<slug>` with
 * an optional trailing slash. The slug is human-readable and
 * locale-dependent, so it's ignored for identity — miruro re-adds it to the
 * live URL even when the page is navigated to without it.
 */
export const PATH_RE = /^\/watch\/([^/]+)(?:\/[^/]+)?\/?$/;

/**
 * Canonical room video id for a show + episode on miruro. Single source of
 * the id format shared by the adapter's identity/catalog reporting and the
 * navigation guard's URL matching.
 *
 * @param showId Numeric show id from `/watch/<showId>`.
 * @param ep Episode number from the `?ep=` query param.
 * @returns The `<showId>-ep<ep>` identity key.
 */
export function makeVideoId(showId: string, ep: string | number): string {
  return `${showId}-ep${ep}`;
}

/**
 * Derive the canonical video id for a miruro watch URL, or `null` when the
 * URL isn't a miruro watch page (wrong host, non-watch path, or missing
 * `?ep=`). Pure: depends only on the URL, ignoring the optional slug and
 * any extra query params (miruro's own, or the credential-handoff
 * `sync_url` / `sync_password`). This is the adapter's URL→identity logic,
 * exposed for the background's navigation guard.
 *
 * @param url The URL to classify.
 * @returns The canonical video id, or `null` if `url` isn't a watch page.
 */
export function videoIdForUrl(url: URL): string | null {
  if (!HOST_RE.test(url.hostname)) return null;
  const showId = PATH_RE.exec(url.pathname)?.[1];
  if (!showId) return null;
  const ep = url.searchParams.get('ep');
  if (!ep) return null;
  return makeVideoId(showId, ep);
}
