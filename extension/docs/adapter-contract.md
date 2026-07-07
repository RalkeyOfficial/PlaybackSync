# Adapter Contract

Adapters are the **only** code that knows how a particular streaming site lays out its DOM. They find the `<video>`, observe what the user does to it, apply commands from the room, and derive an identity that uniquely names the content. They never see the WebSocket, never decide whether an action is suppressed, never know what other tabs are doing.

Every adapter **extends [`BaseAdapter`](../src/adapters/base.ts)**, which owns the parts that are identical across sites — reading `<video>` state, wiring the play/pause/seek intent listeners, applying `play`/`pause`/`seek` commands, the autoplay hold, and all teardown — and drives them through a **sealed `init` lifecycle**. You implement a handful of small, named hooks; you never re-implement (or override) the boilerplate. The generic mechanics themselves live in the pure, testable helper [`src/adapters/video-driver.ts`](../src/adapters/video-driver.ts) (`readVideoState`, `wireIntentListeners`, `waitForElement`).

This page is a working tutorial for writing one. The reference implementation is [`src/adapters/_template/`](../src/adapters/_template/index.ts).

## The hooks you implement

```ts
class MyAdapter extends BaseAdapter {
  readonly id = 'mysite'                                     // required
  readonly guardNavigation = true                            // optional, default false
  protected readonly holdsAutoplay = true                    // optional, default false

  canHandlePage(url: URL): boolean                           // required — pure URL predicate
  protected resolveVideo(): Promise<HTMLVideoElement | null> // required
  protected resolveIdentity(): ContentIdentity | null        // required

  protected canPlay(): boolean                               // optional override
  protected ensurePlayable(): Promise<void>                  // optional override
  protected applyCursorChange(pageUrl: string): void         // optional override
  protected watchCursorTriggers(): void                      // optional override
  async scrapeCatalog(): Promise<VideoRefWithMeta[] | null>  // optional
}
```

Everything else — `getState`, `setPlaybackRate`, `destroy`, the intent wiring, and the `play`/`pause`/`seek`/`nudge_rate` command arms — is inherited from `BaseAdapter`. The payload types (`ContentIdentity`, `VideoState`, `LocalIntent`, `AuthoritativeCommand`) live in [`src/adapters/types.ts`](../src/adapters/types.ts).

There is also one **separate, DOM-free module** an adapter that opts into the navigation-guard must ship alongside its class — a pure `videoIdForUrl(url)` matcher. It can't live on the class because the background service worker imports it without ever loading the DOM-bound adapter. See [Navigation-guard & the URL matcher](#navigation-guard--the-url-matcher) below.

| Hook | Kind | Lifetime | What it must do | What it must **not** do |
|------|------|----------|-----------------|--------------------------|
| `id` | required prop | static | A stable string. Used in logs and command routing. | Match another adapter's id. |
| `guardNavigation` | optional prop, default `false` | static | Opt into the background navigation-guard. Set `true` only when your site has a registered `videoIdForUrl` matcher and canonical, navigable `pageUrl`s. | Set `true` without registering the matcher (see below). Assign it inside a method — it's read *before* `init`, so it must be a field initializer. |
| `holdsAutoplay` | optional prop, default `false` | static | Set `true` if the player auto-plays once as the source loads; the base then holds it paused until the room's first `play`/`pause`. See [Holding autoplay](#holding-autoplay-until-the-rooms-first-command). | — |
| `canHandlePage(url)` | required | every page load + SPA navigation | Pure URL predicate — return true if the adapter owns this page. | Touch the DOM. Reach for `chrome.*`. Have side effects. |
| `resolveVideo()` | required | once, in `init` | Find and return the player `<video>`, waiting for late hydration via `waitForElement(…, { signal: this.signal })`. Return `null` to fail the adapter. | Wire listeners (the base does that). Swallow the not-found case — return `null`. |
| `resolveIdentity()` | required | once, in `init`, after `resolveVideo` | Return the strict `ContentIdentity` from the URL. Return `null` to fail. See "Strict content identity". | Read a not-yet-settled source; by now the video has resolved, so query params added on player init are present. |
| `canPlay()` | optional override, default `!!this.video?.currentSrc` | once, in `init` | Report whether playback can begin. When false the base calls `ensurePlayable()`. | Block. |
| `ensurePlayable()` | optional override, default no-op | once, in `init`, only when `canPlay()` is false | Drive whatever the site needs so `canPlay()` becomes true (e.g. a cold-start load). Guard your own post-`await` steps with `this.signal.aborted`. | Assume it always runs — a warm page skips it. |
| `applyCursorChange(pageUrl)` | optional override, default `location.href = pageUrl` | on each `cursor_change` command | Drive the page to `pageUrl`, ideally via the site's own in-page routing with a `location.href` fallback. | `preventDefault` the user's own clicks. |
| `watchCursorTriggers()` | optional override, default no-op | once, in `init` (fire-and-forget) | Wire detection of in-page nav clicks → `this.emitCursorTrigger(...)`. Return synchronously; do any DOM wait off the critical path. | Block `init` awaiting a control to hydrate. Forget the `Event.isTrusted` filter. |
| `scrapeCatalog()` | optional method (no base default) | once per lifetime, after `init` resolves | Return the visible episode list as `VideoRefWithMeta[]`, with full origin-qualified `pageUrl`. Return `null` when none. | Bound your own latency — the runtime times it out. Use `normalizedUrl` form for `pageUrl`. Add an empty stub — omit the method entirely instead (the runtime fast-paths absence). |

## Talking to the runtime

Hooks never touch `chrome.*` or the raw `AdapterContext` — `BaseAdapter` exposes a few `protected` members instead:

- **`this.emitIntent(intent)`** — normally you don't call this: the base wires `play`/`pause`/`seeking` → intent for you. Reach for it only if your player needs a bespoke intent source.
- **`this.emitCursorTrigger(target)`** — call from `watchCursorTriggers` when the user clicks an in-page navigation control and the page is about to move to a different `VideoRef`. Call passively — **do not `preventDefault`**; the host page's own routing handles the local nav, we just piggyback the announcement. The background decides per the current room's mode + playlist what to do with it: send `CURSOR_CHANGE_REQUEST` (default-in-playlist, or freeform — freeform forwards unconditionally and the server auto-appends not-in-playlist targets), or **pull the tab back** to the room's cursor (single-any, or default-out-of-playlist). A pull-back keeps the WS connected — it dispatches a synthetic `cursor_change` command that lands in your `applyCursorChange`, which replays it as a navigation. Off-target clicks are corrected, never a leave; the only user-driven leave is the popup's Leave Room button. See [`protocol-client.md`](protocol-client.md#viewer-driven-cursor-changes). The adapter stays mode-unaware. Filter on `Event.isTrusted` so the synthetic clicks your own `applyCursorChange` dispatches don't loop back.
- **`this.log(level, msg, data?)`** — structured logs, prefixed with your adapter id.
- **`this.signal`** — the adapter's lifetime `AbortSignal`. Pass it to **every** `addEventListener` and **every** `waitForElement`; the base's `destroy()` (and any `init` failure) aborts it, tearing them all down. Only raw `setTimeout` handles need explicit cleanup — register those with `this.onCleanup(() => clearTimeout(t))`.
- **`this.video`** — the resolved player element (available from `resolveIdentity` onward).

Applying commands is the base's job: it registers a single handler that runs `play`/`pause`/`seek` **verbatim** against `this.video`, delegates `cursor_change` to your `applyCursorChange`, and treats `nudge_rate` as a no-op (the runtime intercepts it first). To *fail* the adapter, return `null` from `resolveVideo` or `resolveIdentity` — the base calls the runtime's `fail` and aborts the signal so nothing leaks. Use failure only when the page looked supportable but isn't (video missing, identity unparseable), never for "this URL isn't ours" — that's what `canHandlePage` is for.

## Local intents vs authoritative commands

The two flows are deliberately not symmetric — and the base handles both directions for you, so this is background rather than something you wire up.

**The base emits** `LocalIntent` — *what the user did locally* (from the `play`/`pause`/`seeking` listeners it attaches to your video):

```ts
type LocalIntent =
  | { type: 'play'; time: number }
  | { type: 'pause'; time: number }
  | { type: 'seek'; time: number }
```

**The base applies** `AuthoritativeCommand` — *what the room decided* (`play`/`pause`/`seek` against your video; `cursor_change` via your `applyCursorChange`):

```ts
type AuthoritativeCommand =
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'seek'; time: number }
  | { type: 'nudge_rate'; targetPos: number }
  | { type: 'cursor_change'; pageUrl: string }
```

Intents are observations; commands are imperatives. The asymmetry is real — `nudge_rate` and `cursor_change` have no intent counterpart because the user can't perform them locally.

`nudge_rate` is special: the runtime intercepts it before the base's command handler ever sees it, reads `getState().currentPos`, derives the rate clamp, and calls `setPlaybackRate(rate)`. You never write a command switch at all — the base applies `play`/`pause`/`seek` verbatim and routes `cursor_change` to your `applyCursorChange`.

## Strict content identity

Return the identity triple from `resolveIdentity()` (the base announces it to the runtime once `init` succeeds):

```ts
interface ContentIdentity {
  providerId: string     // e.g. 'crunchyroll', 'miruro'
  videoId: string        // stable id for *this video*, scoped within providerId
  normalizedUrl: string  // pathname only, NO hostname
}
```

Three hard rules from the [workshop v1 design](../../OLD_CODE/extension/docs/playback_sync_extension_architecture_adapter_based_design_workshop_v_1.md) §7:

1. **No hostname in `normalizedUrl`.** `miruro.tv` and `miruro.to` are the same logical content; the normalized URL must not distinguish them.
2. **Identity must not change during the adapter lifetime.** If a SPA navigation would change `providerId` or `videoId`, return false from `canHandlePage` for the new URL and let the runtime tear you down + activate fresh. (The current runtime relaxes "fatal on identity change" to "tear-down + re-evaluate" — see [`architecture.md`](architecture.md). v1's strict rule may come back.)
3. **`videoId`, not `episodeId`.** Matches the v2 wire format at [`docs/ws-protocol.md`](../../docs/ws-protocol.md).

## `VideoState` and the heartbeat loop

`BaseAdapter.getState()` reads this off `this.video` for you (via `readVideoState`), so most adapters never touch it — override it only for a player that isn't a plain `<video>`. The runtime calls `getState()` every 1 s while you're active. The background uses the result for two things:

- **Heartbeat frames.** Every 5 s, the freshest `VideoState` becomes the body of a wire `HEARTBEAT`. If the playhead is jumping around faster than 5 s would suggest, the daemon notices and may send `SYNC_ADJUST`.
- **Buffer transitions.** When the `playerState` field flips into `'buffering'`, the background sends `BUFFER_START`; on the way out it sends `BUFFER_END`.

Return `null` if you can't read the state right now (video element gone, page in a weird transient). The runtime skips the tick.

The three `playerState` values map directly to the wire field:

| Value | Meaning |
|-------|---------|
| `playing` | `!video.paused` and the next frame is available |
| `paused` | `video.paused` (regardless of buffering) |
| `buffering` | `!video.paused` but `video.readyState < HAVE_FUTURE_DATA` |

## Writing a new adapter, step by step

1. **Copy `src/adapters/_template/index.ts`** to `src/adapters/<site>/index.ts`. It's a two-hook adapter — the right shape to grow from.
2. **Pick an `id`.** Lowercase, dashes or underscores fine, must be unique. `readonly id = '<site>'`.
3. **Write `canHandlePage(url)`.** Just URL inspection. Return true on the URLs you fully support; everything else returns false.
4. **Implement `resolveVideo()`.** Return the player `<video>`, waiting for late hydration with `waitForElement('<selector>', { timeoutMs, signal: this.signal })`. Return `null` if it never appears — the base fails the adapter for you.
5. **Implement `resolveIdentity()`.** Parse `location.pathname` (and maybe query params) into `{ providerId, videoId, normalizedUrl }`. Be strict — return `null` if you can't. By the time this runs the video has resolved, so query params the player adds on init are present.
6. **That's the minimum.** Intent listeners, the `play`/`pause`/`seek` command arms, `getState`, `setPlaybackRate`, and teardown are all inherited. The steps below are opt-in.
7. **(Cold-start players) override `canPlay()` + `ensurePlayable()`.** `canPlay()` reports readiness (default: `!!this.video?.currentSrc`); when it's false the base awaits `ensurePlayable()`, where you drive the site's load control. Re-check `this.signal.aborted` after each `await`.
8. **(In-page episode nav) override `applyCursorChange(pageUrl)` and `watchCursorTriggers()`.** `applyCursorChange` drives the page to a room cursor target — replay the site's own click routing with a `location.href` fallback (see miruro), or leave the default full-navigation. `watchCursorTriggers` wires clicks on in-page controls to `this.emitCursorTrigger(...)`; keep it non-blocking and filter on `Event.isTrusted`.
9. **(Episode lists) add `scrapeCatalog()`.** See [Catalog reporting](#catalog-reporting-scrapecatalog). Omit the method entirely if there's no catalog.
10. **Add the factory to the registry** in `src/adapters/runtime.ts` — append it to `ADAPTERS`. Order matters; first match wins. Real-site adapters before `_template` (which only activates on the dev query param anyway).
11. **(Optional) Opt into the navigation-guard.** If your site's `pageUrl`s are canonical and identity-bearing, ship a pure `videoIdForUrl` matcher, register it in `url-matchers.ts`, and set `readonly guardNavigation = true`. See [Navigation-guard & the URL matcher](#navigation-guard--the-url-matcher).
12. **(If your player autoplays) set `holdsAutoplay = true`.** See [Holding autoplay](#holding-autoplay-until-the-rooms-first-command).
13. **Document it.** Add a short note under `extension/docs/adapter-<site>.md` (or a section on this page) describing how the site behaves, what URLs are supported, anything surprising about the DOM. Per the [documentation policy](README.md#documentation-policy), this is non-optional.

## Navigation-guard & the URL matcher

The `emitCursorTrigger` path only fires on the in-page controls your DOM listener watches (episode buttons). Every *other* way a tab can leave the room's content — the site's home link, a related-video thumbnail, the address bar, browser back/forward, a JS redirect, a full cross-site navigation — bypasses it. The **navigation-guard** is an opt-in background feature that covers those: a `chrome.tabs.onUpdated` listener that pulls an anchored-room tab (default/single mode) back to the cursor when it lands on a URL outside the room.

The guard is **purely additive** — it never replaces your DOM click listener. On sites where the URL doesn't change between videos (or doesn't encode the video identity), the DOM listener is the *only* signal that the user switched off-playlist, so it stays the primary, all-sites-safe mechanism. Opt into the guard only when your URLs can carry the weight.

### Opting in

Two pieces, both required together:

1. **A pure, DOM-free matcher module.** Create `src/adapters/<site>/url.ts` exporting `videoIdForUrl(url: URL): string | null`. It must resolve a live URL to the **same canonical `videoId`** your adapter reports in `ContentIdentity` / `scrapeCatalog`, or return `null` when the URL isn't a content page for your site (wrong host, home page, search page). It is **pure**: no DOM, no `chrome.*`, no globals — it takes a `URL` and returns a string or `null`. Read only the identity-bearing parts of the URL; ignore decorative slugs and stray query params (the credential-handoff `?sync_url=&sync_password=` the share-link flow leaves in the address bar must not change the answer).

   Share whatever host/path patterns and id-format helper the adapter also uses by importing them from this same module — that's how the adapter and the guard are kept from drifting (miruro exports `HOST_RE` / `PATH_RE` / `makeVideoId` here and the class imports them).

2. **Registration + the flag.** Register the matcher by adapter id in [`src/adapters/url-matchers.ts`](../src/adapters/url-matchers.ts), and set `readonly guardNavigation = true` on the class. The flag rides the `identity` content→background message; the background stores armed tabs and selects the right matcher by adapter id.

```ts
// src/adapters/<site>/url.ts
export function videoIdForUrl(url: URL): string | null {
  if (!HOST_RE.test(url.hostname)) return null
  const id = PATH_RE.exec(url.pathname)?.[1]
  if (!id) return null
  // …read only identity-bearing parts; ignore slug + extra query params
  return makeVideoId(id, /* … */)
}

// src/adapters/url-matchers.ts
import { videoIdForUrl as mysite } from './mysite/url'
const URL_MATCHERS = { miruro, mysite }
```

### Why identity, not string equality

The background's `isRoomUrl` check resolves the live tab URL through *your* matcher and compares the resulting `videoId` against the cursor's and the playlist's `videoId`s — it never string-compares URLs. That's deliberate: every site has different URL→identity rules (optional human-readable slugs, query-based ids, hash routing), and a generic background guard must not hardcode any of them. Putting the rule in the adapter's `url` module is what absorbs those cases cleanly.

### What the guard does on a pull-back (no socket close)

When the guard decides a tab has wandered off, it `chrome.tabs.update`s the tab back to the cursor's `pageUrl` — a full page reload. It deliberately does **not** close the WebSocket: the socket lives in the background and survives the reload, and closing it would announce a spurious `client_left` / `client_joined` flap to the room. Instead the background re-runs the join grace period *in place* so the reloaded player's autoplay + resume-position seek don't leak to the room as wire events. Adapter authors don't need to do anything for this — but it's why holding autoplay (below) matters, and why the guard only acts after the join has converged and its settle window elapsed (it stays out of join-time steering, which is the server's job).

## Holding autoplay until the room's first command

If your player **autoplays** when the source loads, the auto-play (and any resume-position seek that rides with it) would fire as a local intent and race the room's state — both at first join and after a guard reload.

Just set `protected readonly holdsAutoplay = true`. The base then, for you:

1. Attaches a `play` listener (before the intent listeners) that **re-pauses** the video while the hold is active.
2. Releases the hold on the **first** `play`/`pause` command, *before* applying it (so the room's own `play` isn't immediately re-paused). It deliberately does **not** release on `seek`/`cursor_change`, so a seek-first command can't leave a later stray auto-play unheld.
3. Arms a safety timer (`AUTOPLAY_HOLD_TIMEOUT_MS = 10 s`) that lifts the hold even if no command ever arrives — e.g. a brand-new room with no state yet — so the viewer is never stuck unable to start playback.

The background's pre-convergence + settle-window suppression already drops these phantom intents on the wire, but holding autoplay keeps the *local* player from flashing play→pause and is the cleaner experience. (An adapter whose `ensurePlayable` triggers the load can also `video.pause()` right after the source arrives to avoid even that flash — see miruro.)

## Catalog reporting (`scrapeCatalog`)

Adapters that can enumerate a visible episode list opt in to the optional `scrapeCatalog()` method. The runtime invokes it once per adapter lifetime — right after `init` resolves — and forwards the result to the background, which populates the JOIN frame's `catalogFragment` field. The room's `JoinHandler` then merges the entries into the playlist via `PlaylistService::merge`, and seeds an empty room's cursor from the joiner's `currentlyShowing` (derived from the adapter's identity + `location.href`). See [`protocol-client.md`](protocol-client.md) for the wire-side framing.

```ts
async scrapeCatalog(): Promise<VideoRefWithMeta[] | null>
```

Rules:

- **Optional — omit the method, don't stub it.** If your site has no usable catalog (single-video pages, embeds, etc.), leave `scrapeCatalog` off the class entirely. `BaseAdapter` provides no default, and the runtime fast-paths a `null` report when the method is absent — an empty stub returning `null` would only add a needless promise round-trip.
- **Runtime owns the timeout.** `SCRAPE_CATALOG_TIMEOUT_MS` (2 s) caps total latency. Take the time you need within reason — you don't need a per-adapter timer.
- **Throwing is fine.** The runtime catches and treats as `null`. Don't add defensive try/catches just to be polite.
- **Return `null` for "not available right now."** Cold pages where the list hasn't hydrated, layouts without one, parse failures — all `null`. Empty arrays are coerced to `null` too; the JOIN frame omits the field entirely either way.
- **`pageUrl` is the full URL.** Origin included. `ContentIdentity.normalizedUrl` is hostname-stripped for identity comparison and is **not** interchangeable here — the server stores `pageUrl` so a later cursor change can navigate clients back to it.
- **Reconnects skip it.** The runtime calls `scrapeCatalog` exactly once per adapter activation. The first JOIN carries the result; reconnect JOINs go out bare. Tying scrape behavior to "always on JOIN" would scrape repeatedly on flaky networks for no extra benefit (`PlaylistService::merge` is idempotent).

See [`miruro/index.ts`](../src/adapters/miruro/index.ts) `scrapeCatalog` for a working implementation against a live site — it waits for the episode-list container with `waitForElement` (a single memoised wait it shares with `watchCursorTriggers`) and drops entries whose title doesn't parse.

## Things that look like they should be in the contract but aren't

- **`currentlyShowing()`** — derivable from identity already; if the protocol's `currentlyShowing` ends up needing more fields, we'll add it.
- **`onError(callback)`** — adapters that need to surface non-fatal issues can just call `this.log('warn', ...)`. There's no rich error channel.
- **Page-context (MAIN-world) hooks** — workshop §3.D allows them but no current adapter needs them. When a site does need them (e.g. to reach into a JS player object that the isolated world can't see), an `injected/` script paired with `postMessage` is the right shape. Out of scope for the contract itself.
