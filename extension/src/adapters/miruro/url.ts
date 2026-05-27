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
 * an optional trailing slash. Group 1 is the showId (the identity-bearing
 * part); group 2 is the optional human-readable slug. The slug is ignored
 * for *identity* (see {@link videoIdForUrl}), but it must be **preserved
 * for navigation**: a slug-less watch URL triggers a miruro server-side
 * redirect that canonicalises the path *and drops unknown query params*
 * (including the `sync_url` / `sync_password` credential handoff), whereas
 * an already-slugged URL is served as-is. So navigation targets we build
 * keep the slug to avoid that redirect.
 */
export const PATH_RE = /^\/watch\/([^/]+)(?:\/([^/]+))?\/?$/;

/**
 * Build a canonical miruro watch URL. Includes the slug segment when known
 * so the URL is the already-canonical form miruro won't redirect (and thus
 * won't strip query params from). Single source of the watch-URL shape,
 * shared by the adapter's catalog/cursor-trigger emitters and the
 * navigation guard's pull-back target builder.
 *
 * @param origin The page origin (e.g. `https://www.miruro.to`).
 * @param showId Numeric show id from `/watch/<showId>`.
 * @param ep Episode number for the `?ep=` query param.
 * @param slug Optional human-readable show slug; omitted/`null` falls back
 *   to the slug-less path.
 * @returns The watch URL string.
 */
export function makeWatchUrl(origin: string, showId: string, ep: string | number, slug?: string | null): string {
  const path = slug ? `/watch/${showId}/${slug}` : `/watch/${showId}`;
  return `${origin}${path}?ep=${ep}`;
}

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

/**
 * Build a canonical, navigable miruro watch URL for a room cursor — the
 * already-slugged form with `?ep=` present, which miruro serves as-is
 * instead of issuing its canonicalising server redirect. That redirect (on a
 * slug-less or `ep`-less URL) drops unknown query params, including the
 * `sync_url` / `sync_password` handoff a pull-back re-attaches; landing on
 * the canonical URL avoids it.
 *
 * Origin, `showId`, and the show slug come from `cursor.pageUrl`'s path; the
 * `?ep=` is reconstructed from the canonical `videoId` (`<showId>-ep<ep>`,
 * the key {@link makeVideoId} produces) rather than trusted from the
 * `pageUrl`, so it's present even if the stored `pageUrl` ever lost it.
 * Returns `null` — caller should fall back to the raw `pageUrl` — when the
 * cursor isn't a miruro watch target (wrong host, no `showId`, or a `videoId`
 * that doesn't match the `<showId>-ep…` shape).
 *
 * @param cursor The room cursor's canonical id + last-known page URL.
 * @returns A `<origin>/watch/<showId>[/<slug>]?ep=<ep>` URL, or `null` if it
 *   can't be derived for miruro.
 */
export function navigableUrlForCursor(cursor: { videoId: string; pageUrl: string }): string | null {
  let url: URL;
  try {
    url = new URL(cursor.pageUrl);
  } catch {
    return null;
  }
  if (!HOST_RE.test(url.hostname)) return null;
  const match = PATH_RE.exec(url.pathname);
  const showId = match?.[1];
  if (!showId) return null;
  // Preserve the slug from the cursor's pageUrl so the pull-back target is the
  // already-canonical form miruro won't redirect (and thus won't strip the
  // credential params from). See {@link PATH_RE} / {@link makeWatchUrl}.
  const slug = match?.[2] ?? null;
  // `videoId` is `makeVideoId(showId, ep)` === `${showId}-ep${ep}`; strip the
  // `${showId}-ep` prefix to recover the episode exactly, without parsing a
  // `-ep` that could also appear inside a non-numeric showId.
  const prefix = makeVideoId(showId, '');
  if (!cursor.videoId.startsWith(prefix)) return null;
  const ep = cursor.videoId.slice(prefix.length);
  if (!ep) return null;
  return makeWatchUrl(url.origin, showId, ep, slug);
}
