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

## Episode switching

The miruro UI navigates between episodes via `history.pushState` (URL changes from `?ep=4` to `?ep=5` with no full reload). The runtime's `installNavigationListeners` ([`runtime.ts:184-207`](../src/adapters/runtime.ts#L184-L207)) catches this and calls `destroy()` + re-evaluates the registry. The adapter therefore re-binds to the new episode automatically; no in-adapter SPA handling is needed.

## Out of scope

- `scrapeCatalog()` — miruro's episode list will be readable, but the contract method doesn't exist yet. Tracked in [`EXTENSION_TODO.md`](../../EXTENSION_TODO.md) §"Deferred".
- Cross-origin iframe support — miruro's player is top-level, so this isn't needed.
- Provider-specific `sync_adjust` — currently the same hard-seek fallback as `_template`. A real `nudge-rate` via `playbackRate` clamping is a follow-up.
