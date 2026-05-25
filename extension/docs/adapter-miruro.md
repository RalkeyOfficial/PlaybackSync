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

After `loadedmetadata` arrives (5 s timeout), the adapter immediately `video.pause()`s. Vidstack auto-plays on load; pausing pre-empts that so the room's first authoritative command wins without a race. If the source is already populated (refresh, second activation), the trigger is a no-op.

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

## Out of scope

- Cross-origin iframe support — miruro's player is top-level, so this isn't needed.
- Provider-specific `nudge_rate` handling — the runtime-driven `setPlaybackRate` clamp is identical across adapters today, and the Vidstack `<video>` element responds to `playbackRate` natively. If Vidstack's own UI ever fights the assignment, miruro can override `setPlaybackRate` to route through the player API instead.
