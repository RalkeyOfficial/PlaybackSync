# miruro adapter

`miruro` is the first real-site adapter — see [adapter-contract.md](adapter-contract.md) for the contract it implements. The source is [`src/adapters/miruro/index.ts`](../src/adapters/miruro/index.ts); the spec that introduced it lives at [`agent-os/specs/2026-05-24-1700-extension-miruro-adapter/`](../../agent-os/specs/2026-05-24-1700-extension-miruro-adapter/).

> **Page/media split (2026-07).** miruro moved its player into a **cross-origin `strm.cx` iframe**, so the `<video>` is no longer in the miruro document. The adapter is now a **page-role** adapter (`PageBaseAdapter`) that owns identity, catalog, and cursor navigation only; the `<video>` is owned by the generic **`strmcx` media adapter** ([`src/adapters/strmcx/index.ts`](../src/adapters/strmcx/index.ts)) running in the embed frame. The two halves are bridged by the background per tab. See [adapter-contract.md §Two roles](adapter-contract.md#two-roles-page-and-media) and the spec at [`agent-os/specs/2026-07-25-1200-extension-cross-frame-media-adapter/`](../../agent-os/specs/2026-07-25-1200-extension-cross-frame-media-adapter/).

## Supported hosts

Enumerated, no wildcard: `miruro.tv`, `miruro.to`, `miruro.bz`, `miruro.ru` (with or without the `www.` prefix). miruro is known to rotate TLDs; the list is hard-coded rather than wildcarded so a hostile actor registering `miruro.<anything>` can't trigger the adapter. Adding a new TLD is a code change + release. A future slice may move the list to app config.

## Supported URL shape

```
https://<host>/watch/<showId>(/<slug>)?ep=<ep>
```

Both `showId` (the path segment after `/watch/`) and `ep` (the query parameter) are required for identity. The optional `<slug>` is human-readable text (e.g. `fatestrange-fake`); it's dropped in identity derivation because it may differ per host / locale while `showId` is stable.

**`canHandlePage` matches without `?ep=`.** miruro sometimes loads the watch page without the query param and appends it via `history.replaceState` once the player initialises. The adapter activates on host + path alone; `init` re-reads `ep` *after* the video element is found, by which time the param has arrived. If `ep` is still missing at that point, `init` `ctx.fail`s and the runtime's URL-change listener will re-evaluate the registry when the param finally appears.

## Content identity

| Field | Value | Example |
|-------|-------|---------|
| `providerId` | `'miruro'` | `'miruro'` |
| `videoId` | `<showId>-ep<ep>` | `'166617-ep4'` |
| `normalizedUrl` | `/watch/<showId>?ep=<ep>` | `'/watch/166617?ep=4'` |

The same `showId` + `ep` on `.tv` and on `.to` must produce the same identity (workshop §7 — no hostname in `normalizedUrl`). The dropped slug is what makes that hold across locales.

## URL matcher & the navigation-guard

The adapter is split across two files:

- [`src/adapters/miruro/index.ts`](../src/adapters/miruro/index.ts) — the DOM-bound `MiruroAdapter` class.
- [`src/adapters/miruro/url.ts`](../src/adapters/miruro/url.ts) — pure, **DOM-free** URL helpers: `HOST_RE`, `PATH_RE`, `makeVideoId(showId, ep)`, and `videoIdForUrl(url): string | null`.

The split exists so the background service worker can answer "is this URL one of the room's videos?" for the navigation-guard without importing the DOM-bound class. `url.ts` is registered by adapter id in [`src/adapters/url-matchers.ts`](../src/adapters/url-matchers.ts), and the class **shares** `HOST_RE` / `PATH_RE` / `makeVideoId` by importing them from `url.ts` — so the adapter's identity derivation and the guard's URL matching can't drift. `videoIdForUrl` reads only the identity-bearing parts: it ignores the optional slug and any extra query params, as well as the `#sync_url=&sync_password=` fragment the credential-handoff leaves in the address bar after a join.

miruro sets **`guardNavigation = true`**: its `/watch/<show>?ep=<n>` URLs are canonical, navigable, and resolve cleanly to identity, so the background's navigation-guard pulls the tab back when it lands on a URL outside the room's playlist by any means the in-page click listener can't observe (home link, related-video thumbnails, address bar, back/forward, cross-site). See [`protocol-client.md` §The navigation-guard](protocol-client.md#the-navigation-guard-non-click-departures) and [`adapter-contract.md` §Navigation-guard & the URL matcher](adapter-contract.md#navigation-guard--the-url-matcher).

## The player lives in a cross-origin iframe

As of 2026-07 the watch page renders `#app … strmcx-embed` (an **open** shadow root) containing an `<iframe src="https://strm.cx/?embed=1">`. The Vidstack `media-player → media-provider → <video>` (blob source) lives inside that **cross-origin** `strm.cx` document. Same-Origin Policy walls it off from the miruro top frame, so the miruro page adapter neither resolves nor drives the `<video>` — that is the **`strmcx` media adapter**'s job, running in the embed frame via `entrypoints/media.content.ts` (`all_frames`).

What the page adapter still does in the top frame:

### Waiting for `?ep=` (late hydration)

miruro appends `?ep=` via `history.replaceState` once the player mounts. The page adapter's `resolveReady()` waits for the `strmcx-embed` host element (`MutationObserver` on `document.body`, 10 s timeout) before reading identity, so `resolveIdentity()` sees the settled `?ep=`. If it's still missing, the adapter `ctx.fail`s and the runtime re-evaluates when `replaceState` finally fires.

### What moved to the `strmcx` media adapter

- **Resolving the `<video>`** — inside the `strm.cx` document the embed is a dedicated player frame with a single `<video>`, so a plain `video` selector is safe (no hero/trailer to disambiguate; the old `#player-container .player video` scoping was a top-frame concern).
- **Cold-start load** — most providers self-load their blob source (`readyState 4` within ~1 s), in which case the base's default `canPlay` (source present) short-circuits `ensurePlayable`. Some providers render the player with a **sourceless `<video>`** that only loads once Vidstack's `<media-play-button>` is activated. The `strmcx` adapter's `ensurePlayable` override drives it — running in the embed frame where that DOM lives: it waits for `media-play-button` (aborting early on the video's `loadstart` so self-loaders don't wait), then dispatches a synthesized `Space` keydown/keyup on it (a plain `.click()` is ignored by this control — only keyboard activation loads the source), then pauses so the room's first command wins. The keyup is delayed ~30 ms: a synchronous release isn't registered, so the player treats Space as *held* and ramps playback to 2× (its hold-to-speed gesture).
- **Autoplay hold** — the generic hold (`holdsAutoplay = true`, re-pause the player's unsolicited auto-play — but not a viewer's own play — until the room's first `play`, 10 s safety release) is inherited from `MediaBaseAdapter`. See [`adapter-contract.md` §Holding autoplay](adapter-contract.md#holding-autoplay-until-the-rooms-first-command).

## Catalog scraping

The adapter implements the optional `scrapeCatalog()` method (see [`adapter-contract.md` §Catalog reporting](adapter-contract.md#catalog-reporting-scrapecatalog)). On the first JOIN, the runtime invokes it after `init` resolves, and the result populates the wire-format `JOIN.catalogFragment` field — every other client in the room then sees the scraped episode list as `scraped` playlist entries via `PlaylistService::merge`.

### Selectors

The container + entry selectors live as constants at the top of [`src/adapters/miruro/index.ts`](../src/adapters/miruro/index.ts):

```ts
const EPISODE_LIST_CONTAINER_SELECTOR = '#episodes-list-container'
const EPISODE_LIST_ENTRY_SELECTOR = 'button[data-episode-id]'
const EPISODE_TITLE_RE = /^EP\s+(\d+)\b/i
```

miruro renames CSS classes per build hash (e.g. `_seasonTitle_1vb3r_84`), so the adapter avoids them entirely. The stable signals are:

- `#episodes-list-container` — a real DOM `id`, unlikely to flip silently.
- `data-episode-id` on each entry button — a `data-*` attribute used as an opaque app-internal handle; safer than any class.
- The button's `title` attribute, consistently formatted as `EP <number>: <title>` (e.g. `EP 1: Kanan's Easy`) — durable, user-visible copy. The rendered `EP <n>` `<span>` shows the same text but sits behind hashed-class wrappers, so the regex against `title` is preferred.

If any of these flip, the adapter returns `null` cleanly — a polluted catalog would fan out to every other client in the room via `PlaylistService::merge`, so silent failure is the safer mode.

### Behavior

1. `scrapeCatalog` waits up to `EPISODE_LIST_WAIT_TIMEOUT_MS` (1.5 s) for `#episodes-list-container` to mount via `waitForElement` (a single memoised `episodeListPromise`, so one observer/timer pair serves both the scrape and `applyCursorChange`).
2. Once the container appears, the adapter walks every `button[data-episode-id]` inside it. For each button, the episode number is parsed from the `title` attribute via `EPISODE_TITLE_RE`; entries whose title doesn't match the `EP <n>` prefix are dropped.
3. Each surviving button becomes a `VideoRefWithMeta`:
   - `videoId: \`${showId}-ep${ep}\`` (same shape as the adapter's own `ContentIdentity.videoId`).
   - `pageUrl: \`${location.origin}/watch/${showId}?ep=${ep}\`` (full URL — required by the wire format; `ContentIdentity.normalizedUrl` is hostname-stripped and not interchangeable).
   - `episodeNumber: parseInt(matched, 10)`.
   - `label`: the trimmed `title` attribute, or `null` if empty. Keeping the full `EP N: <name>` form gives the room dashboard something human-readable without an extra lookup.
4. Returns `null` if the container never mounts or yields zero parseable entries.

Multi-season shows render a separate season picker (`#root > … > ._seasonCardGrid_*`) where each season is its own `/watch/<seasonShowId>` page. Cross-season cataloging would require switching `showId` per entry and isn't in scope for this slice — the current adapter scrapes the *current* season only, and the room reconciles across seasons via cursor changes that change `showId`.

The memoised wait rides the adapter's lifetime `signal`, so an SPA navigation mid-scrape (which aborts the signal via `destroy()`) tears down the observer/timer without leaking handlers.

## Episode switching

The miruro UI navigates between episodes via `history.pushState` (URL changes from `?ep=4` to `?ep=5` with no full reload). The page runtime's `installNavigationListeners` ([`runtime.ts`](../src/adapters/runtime.ts)) catches this and calls `destroy()` + re-evaluates the registry. The page adapter therefore re-binds to the new episode automatically; no in-adapter SPA handling is needed. The embed frame reloads with the new source and re-runs its own media adapter (which re-announces `media_hello`); the two halves re-converge per tab in the background.

## Viewer-driven cursor changes

The adapter **applies** authoritative `cursor_change` commands by replaying a click on the matching episode button. It does **not** implement a DOM click listener to *announce* moves — see below. See [`protocol-client.md` §Viewer-driven cursor changes](protocol-client.md#viewer-driven-cursor-changes) for the cross-cutting flow.

### Sender path (announce) — via the navigation-guard, not a click listener

Every episode change also changes `?ep=`, and miruro's `/watch/<show>?ep=<n>` URLs encode identity, so the adapter sets `guardNavigation = true` and lets the **background navigation-guard** be the single detector for cursor moves. The guard (a `browser.tabs.onUpdated` listener that resolves the live URL through `videoIdForUrl`) catches the episode list, the player's "Next episode" button, keyboard shortcuts, and autoplay-advance alike. A DOM click listener would only cover the episode-list case *and* would double-fire alongside the guard, so miruro deliberately **omits** `watchCursorTriggers` (the base's no-op stays in force). See [`adapter-contract.md` §Navigation-guard & the URL matcher](adapter-contract.md#navigation-guard--the-url-matcher).

### Receiver path (apply)

The `cursor_change` arm of `onCommand` calls `applyCursorChange(pageUrl)`:

1. Parse the target URL. Extract `?ep=`.
2. Find the in-page `button[data-episode-id]` whose parsed `EP <n>` matches. **Match is by parsed ep number, not by playlist order** — owners can reorder the room's playlist freely without affecting which DOM element gets clicked.
3. Synthetically `.click()` the button — miruro's SPA routing fires exactly as for a real click. The `Event.isTrusted === false` filter on the sender path keeps the replay from being announced back to the server.

Fall back to a full `location.href` navigation when:

- we're already at the target URL (typical for the original sender, whose SPA route updated before the broadcast came back),
- the target URL parses to a different show (miruro's SPA only handles in-show ep changes),
- the episode list isn't in the DOM yet (cold page mid-hydration),
- no button matches the target ep (paginated lists, season filters).

The runtime re-arms the join settle window on every `CURSOR_CHANGE` so miruro's auto-resume seek on the new ep is dropped, mirroring the JOIN-time auto-resume handling already in place.

## Out of scope

- Cross-season cataloging — `scrapeCatalog` scrapes the current season only (see above).
- Provider-specific `nudge_rate` handling — the runtime-driven `setPlaybackRate` clamp is identical across adapters today, and the Vidstack `<video>` element responds to `playbackRate` natively. If Vidstack's own UI ever fights the assignment, miruro can override `setPlaybackRate` to route through the player API instead.
