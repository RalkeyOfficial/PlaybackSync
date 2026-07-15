# miruro adapter

`miruro` is the first real-site adapter — see [adapter-contract.md](adapter-contract.md) for the contract it implements. The source is [`src/adapters/miruro/index.ts`](../src/adapters/miruro/index.ts); the spec that introduced it lives at [`agent-os/specs/2026-05-24-1700-extension-miruro-adapter/`](../../agent-os/specs/2026-05-24-1700-extension-miruro-adapter/).

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

## DOM quirks

### Two `<video>` elements

Watch pages can render more than one `<video>` (e.g. a hero / trailer in addition to the player). The adapter binds to the player's element via the scoped selector `#player-container .player video` — never `document.querySelector('video')`.

### Late hydration

The player uses [Vidstack](https://www.vidstack.io/) (`.vds-video-layout.dark` in the DOM). It mounts after `document_idle`, so a synchronous `querySelector` at adapter `init` time may return `null`. The adapter waits via `MutationObserver` on `document.body`, with a 10 s timeout — if Vidstack hasn't hydrated by then the adapter `ctx.fail`s.

### Cold-page manual-load button

On a freshly-loaded watch page the `<video>` exists but has no source. A "click to load" button sits at `#player-container .vds-video-layout button`. A regular `.click()` is **not** sufficient — verified live, the player only responds to a keyboard `Space` activation. The adapter dispatches the synthesized pair:

```ts
const eventInit: KeyboardEventInit = {
  key: ' ',
  code: 'Space',
  keyCode: 32,
  which: 32,
  bubbles: true,
  cancelable: true,
}
button.dispatchEvent(new KeyboardEvent('keydown', eventInit))
button.dispatchEvent(new KeyboardEvent('keyup', eventInit))
```

Two timing quirks sit around the dispatch:

1. **Button appears after the `<video>`.** Vidstack's layout overlay lands a few frames after the `<video>` itself, so a synchronous lookup right after `waitForVideo` resolves is racy. `waitForLoadButton` re-observes `document.body` for up to `LOAD_BUTTON_WAIT_TIMEOUT_MS` (5 s), and short-circuits via the video's `loadstart` event so a page that loads its source on its own (refresh, second activation, server-side hydration) doesn't wait the full timeout. Returns `null` on timeout, in which case the adapter logs and lets the user start playback manually.
2. **Click handler wires up after the button mounts.** Vidstack inserts the button into the DOM *before* its click handler is fully attached — the responsive-layout pass + capability detection settle a few hundred ms later. Dispatching immediately reaches a no-op handler, so the adapter waits `LOAD_BUTTON_SETTLE_MS` (300 ms, verified empirically) after the button appears before firing the synthesized keys.

### Holding the one-shot autoplay

Vidstack auto-plays exactly once when the source loads, and rides a delayed resume-position seek with it. Both would leak to the room as phantom intents — at first join, and again after a navigation-guard reload. The adapter holds the autoplay rather than letting it fire and relying solely on the background's suppression (see [`adapter-contract.md` §Holding autoplay](adapter-contract.md#holding-autoplay-until-the-rooms-first-command) for the general pattern):

1. A `play` listener (`holdAutoplay`) is attached **before** `ensureLoaded`, so it catches the auto-play whichever path the load takes (warm revisit with a source already present, or cold manual-load). While `autoplayHeld` is set it re-`pause()`s the video on every `play`.
2. The hold is released on the **first** `onCommand` invocation, *before* the command is applied — so a room `play` command isn't immediately re-paused by the guard. `releaseAutoplayHold` is idempotent and also runs from `destroy`.
3. `AUTOPLAY_HOLD_TIMEOUT_MS` (10 s) lifts the hold even if no command ever arrives (e.g. a brand-new room with no state), so the viewer is never stuck unable to start playback. The happy path lifts it far sooner.

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

1. `scrapeCatalog` waits up to `EPISODE_LIST_WAIT_TIMEOUT_MS` (1.5 s) for `#episodes-list-container` to mount via `MutationObserver`. The wait uses a separate observer pair (`catalogObserver` / `catalogTimer`) from the `<video>` / manual-load flow so they can coexist on cold pages.
2. Once the container appears, the adapter walks every `button[data-episode-id]` inside it. For each button, the episode number is parsed from the `title` attribute via `EPISODE_TITLE_RE`; entries whose title doesn't match the `EP <n>` prefix are dropped.
3. Each surviving button becomes a `VideoRefWithMeta`:
   - `videoId: \`${showId}-ep${ep}\`` (same shape as the adapter's own `ContentIdentity.videoId`).
   - `pageUrl: \`${location.origin}/watch/${showId}?ep=${ep}\`` (full URL — required by the wire format; `ContentIdentity.normalizedUrl` is hostname-stripped and not interchangeable).
   - `episodeNumber: parseInt(matched, 10)`.
   - `label`: the trimmed `title` attribute, or `null` if empty. Keeping the full `EP N: <name>` form gives the room dashboard something human-readable without an extra lookup.
4. Returns `null` if the container never mounts or yields zero parseable entries.

Multi-season shows render a separate season picker (`#root > … > ._seasonCardGrid_*`) where each season is its own `/watch/<seasonShowId>` page. Cross-season cataloging would require switching `showId` per entry and isn't in scope for this slice — the current adapter scrapes the *current* season only, and the room reconciles across seasons via cursor changes that change `showId`.

`destroy()` disconnects `catalogObserver` and clears `catalogTimer` so an SPA navigation mid-scrape doesn't leak handlers.

## Episode switching

The miruro UI navigates between episodes via `history.pushState` (URL changes from `?ep=4` to `?ep=5` with no full reload). The runtime's `installNavigationListeners` ([`runtime.ts:184-207`](../src/adapters/runtime.ts#L184-L207)) catches this and calls `destroy()` + re-evaluates the registry. The adapter therefore re-binds to the new episode automatically; no in-adapter SPA handling is needed.

## Viewer-driven cursor changes

The adapter both **announces** the user's episode-list clicks toward the room and **applies** authoritative `cursor_change` commands by replaying a click on the matching button. See [`adapter-contract.md` §The `AdapterContext` bridge](adapter-contract.md#the-adaptercontext-bridge) and [`protocol-client.md` §Viewer-driven cursor changes](protocol-client.md#viewer-driven-cursor-changes) for the cross-cutting flow.

### Sender path (announce)

The adapter attaches one **delegated, passive** `click` listener on `#episodes-list-container` rather than per-button listeners — robust against miruro re-rendering the inner buttons, no per-button bookkeeping. The handler:

1. Filters on `Event.isTrusted` so synthetic clicks dispatched by the receiver path (below) don't loop back to the server.
2. Resolves the clicked `button[data-episode-id]` via `closest()`.
3. Parses the ep number from the button's `title` attribute via `EPISODE_TITLE_RE`.
4. Builds a `VideoRefWithMeta` in the same shape `scrapeCatalog` produces (full `pageUrl`, `videoId = ${showId}-ep${ep}`, `episodeNumber`, `label`).
5. Calls `ctx.emitCursorTrigger(target)`.

The listener never calls `preventDefault` — miruro's own SPA routing handles the local nav; we just piggyback the announcement. `destroy()` removes the delegated listener.

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

- Cross-origin iframe support — miruro's player is top-level, so this isn't needed.
- Provider-specific `nudge_rate` handling — the runtime-driven `setPlaybackRate` clamp is identical across adapters today, and the Vidstack `<video>` element responds to `playbackRate` natively. If Vidstack's own UI ever fights the assignment, miruro can override `setPlaybackRate` to route through the player API instead.
