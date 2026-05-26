# Adapter Contract

Adapters are the **only** code that knows how a particular streaming site lays out its DOM. They find the `<video>`, observe what the user does to it, apply commands from the room, and derive an identity that uniquely names the content. They never see the WebSocket, never decide whether an action is suppressed, never know what other tabs are doing.

This page is a working tutorial for writing one. The reference implementation is [`src/adapters/_template/`](../src/adapters/_template/index.ts).

## The contract, in one screen

```ts
interface Adapter {
  id: string
  guardNavigation?: boolean
  canHandlePage(url: URL): boolean
  init(ctx: AdapterContext): Promise<void>
  getState(): VideoState | null
  setPlaybackRate(rate: number): void
  scrapeCatalog?(): Promise<VideoRefWithMeta[] | null>
  destroy(): void
}
```

That's it. Every other type in [`src/adapters/types.ts`](../src/adapters/types.ts) is either a payload shape or the bridge object (`AdapterContext`) the runtime hands you in `init`.

There is also one **separate, DOM-free module** an adapter that opts into the navigation-guard must ship alongside its class — a pure `videoIdForUrl(url)` matcher. It can't live on the class because the background service worker imports it without ever loading the DOM-bound adapter. See [Navigation-guard & the URL matcher](#navigation-guard--the-url-matcher) below.

| Method | Lifetime | What it must do | What it must **not** do |
|--------|----------|-----------------|--------------------------|
| `id` | static | A stable string. Used in logs and command routing. | Match another adapter's id. |
| `guardNavigation` (optional) | static | Opt into the background navigation-guard. Set `true` only when your site has a registered `videoIdForUrl` matcher and canonical, navigable `pageUrl`s. Defaults to `false` / absent. | Set `true` without registering the matcher (see below). |
| `canHandlePage(url)` | called on every page load + SPA navigation | Pure URL predicate — return true if the adapter owns this page. | Touch the DOM. Reach for `chrome.*`. Have side effects. |
| `init(ctx)` | once, after `canHandlePage` returns true | Find the video, attach listeners, register the command handler, call `ctx.setIdentity` once. | Throw silently. Fall back to a degraded mode. Open a WebSocket. |
| `getState()` | every ~1 s while active | Read the current `currentPos` + `playerState` from the video. | Block. Cache aggressively (the runtime polls fresh). |
| `setPlaybackRate(rate)` | whenever the runtime applies a `nudge_rate` command, and again to restore | Write the value through to the underlying player (`<video>.playbackRate = rate` for most adapters). | Schedule a timer. Decide the magnitude. Throw — `rate === 1` is the restore call and must always succeed. |
| `scrapeCatalog()` (optional) | once per adapter lifetime, after `init` resolves | Return the visible episode list as `VideoRefWithMeta[]`, with full origin-qualified `pageUrl`. Return `null` when no catalog is available. | Bound your own latency — the runtime applies its own timeout. Use `normalizedUrl` form for `pageUrl`; the wire format needs the full URL. |
| `destroy()` | on SPA navigation or fatal error | Detach every listener, clear refs. | Throw — if you do, the runtime logs and moves on, but the next adapter activation may inherit a partial state. |

## The `AdapterContext` bridge

The runtime hands you a context in `init`. It's the only way to communicate outward:

```ts
interface AdapterContext {
  emitIntent(intent: LocalIntent): void
  emitCursorTrigger(target: VideoRefWithMeta): void
  onCommand(handler: (cmd: AuthoritativeCommand) => void): void
  setIdentity(identity: ContentIdentity): void
  fail(reason: string): void
  log(level: 'info' | 'warn' | 'error', msg: string, data?): void
}
```

- **`emitIntent(...)`** — call when the user does something to the video. The runtime forwards it to the background, which (after suppression filtering) sends a wire `EVENT`. Don't call this when *you* changed the playhead in response to a `command` — that would be a feedback loop.
- **`emitCursorTrigger(target)`** — call when the user clicks an in-page navigation control (e.g. an episode button) and the page is about to move to a different `VideoRef`. Call passively — **do not `preventDefault`**; the host page's own routing handles the local nav, we just piggyback the announcement. The background decides per the current room's mode + playlist what to do with it: send `CURSOR_CHANGE_REQUEST` (default-in-playlist, or freeform — freeform forwards unconditionally and the server auto-appends not-in-playlist targets), or **pull the tab back** to the room's cursor (single-any, or default-out-of-playlist). A pull-back keeps the WS connected — it dispatches a synthetic `cursor_change` command back to your `onCommand` handler, which your receiver path replays as a navigation. Off-target clicks are corrected, never a leave; the only user-driven leave is the popup's Leave Room button. See [`protocol-client.md`](protocol-client.md#viewer-driven-cursor-changes). The adapter stays mode-unaware. Filter on `Event.isTrusted` so synthetic clicks dispatched by your own `cursor_change` command handler don't loop back.
- **`onCommand(handler)`** — register exactly one handler. Calling it again replaces the previous handler. The handler must apply commands **verbatim** — no interpretation, no transformation. `play` means `video.play()`, full stop.
- **`setIdentity(identity)`** — call once, after you've found the video and parsed the URL. See "Strict content identity" below.
- **`fail(reason)`** — non-fatal-to-the-extension, but fatal-to-the-adapter. The runtime stops the activation, the page becomes silent, and the user sees nothing. Use this when the page looks supportable but actually isn't (video element missing, identity unparseable). Don't use it for "this URL isn't ours" — that's what `canHandlePage` is for.
- **`log(...)`** — structured logs. The runtime prefixes them with your adapter id.

## Local intents vs authoritative commands

The two flows are deliberately not symmetric.

**You emit** `LocalIntent` — *what the user did locally*:

```ts
type LocalIntent =
  | { type: 'play'; time: number }
  | { type: 'pause'; time: number }
  | { type: 'seek'; time: number }
```

**You receive** `AuthoritativeCommand` — *what the room decided*:

```ts
type AuthoritativeCommand =
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'seek'; time: number }
  | { type: 'nudge_rate'; targetPos: number }
  | { type: 'cursor_change'; pageUrl: string }
```

Intents are observations; commands are imperatives. The asymmetry is real — `nudge_rate` and `cursor_change` have no intent counterpart because the user can't perform them locally.

`nudge_rate` is special: the runtime intercepts it before it reaches your `onCommand` handler, reads `getState().currentPos`, derives the rate clamp, and calls `setPlaybackRate(rate)`. Your switch still needs a `nudge_rate` arm for exhaustiveness, but the arm is a no-op.

## Strict content identity

Once, after `init` succeeds, you must call `ctx.setIdentity` with a triple:

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

The runtime calls `getState()` every 1 s while you're active. The background uses the result for two things:

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

1. **Copy `src/adapters/_template/index.ts`** to `src/adapters/<site>/index.ts`. The template has the right shape; you'll mostly replace logic, not structure.
2. **Pick an `id`.** Lowercase, dashes or underscores fine, must be unique.
3. **Write `canHandlePage`.** Just URL inspection. Return true on the URLs you fully support; everything else returns false.
4. **In `init`**: find the video element. If it's absent on the URLs `canHandlePage` matched, call `ctx.fail(...)` rather than waiting for it — the page is shaped differently than you expected.
5. **Attach listeners.** `play`, `pause`, `seeking` on the video element. Each handler builds a `LocalIntent` with the current `video.currentTime` and calls `ctx.emitIntent`.
6. **Register the command handler.** Inside `ctx.onCommand`, switch on `cmd.type` and apply verbatim. `nudge_rate` is a no-op (the runtime handled it before it got here). For `cursor_change` you need to drive the page to `cmd.pageUrl` however the site does it — synthetically clicking the matching DOM control where the site's own routing handles the rest (see the miruro adapter for a working example), with a fallback to `location.href` when an in-page click can't be matched. If your site has no usable in-page nav control, a `location.href` assignment is a perfectly fine default.
7. **Implement `setPlaybackRate`.** One line: `if (this.video) this.video.playbackRate = rate`. The runtime calls it with the nudge clamp and again with `1` to restore.
8. **Set identity.** Parse `location.pathname` (and maybe query params) into `{ providerId, videoId, normalizedUrl }`. Be strict — if you can't, `ctx.fail`.
9. **Implement `getState`.** Mirror the template's shape: `paused → 'paused'`, `!paused && readyState < 3 → 'buffering'`, otherwise `'playing'`.
10. **In `destroy`**: remove the listeners you added, null out the refs.
11. **Add the factory to the registry** in `src/adapters/runtime.ts` — append it to `ADAPTERS`. Order matters; first match wins. Real-site adapters before `_template` (which only activates on the dev query param anyway).
12. **(Optional) Opt into the navigation-guard.** If your site's `pageUrl`s are canonical and identity-bearing, ship a pure `videoIdForUrl` matcher, register it in `url-matchers.ts`, and set `guardNavigation = true`. See [Navigation-guard & the URL matcher](#navigation-guard--the-url-matcher).
13. **(If your player autoplays) hold autoplay** until the room's first command. See [Holding autoplay](#holding-autoplay-until-the-rooms-first-command).
14. **Document it.** Add a short note under `extension/docs/adapter-<site>.md` (or a section on this page) describing how the site behaves, what URLs are supported, anything surprising about the DOM. Per the [documentation policy](README.md#documentation-policy), this is non-optional.

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

If your player **autoplays** when the source loads, hold that autoplay until the room's first authoritative command arrives. Otherwise the auto-play (and any resume-position seek that rides with it) fires as a local intent and races the room's state — both at first join and after a guard reload.

The pattern (see miruro for a working version):

1. Early in `init`, before triggering the load, attach a `play` listener that **re-pauses** the video while a `held` flag is set.
2. Release the hold — clear the flag, drop the listener — on the **first** `onCommand` invocation, *before* applying the command (so the room's own `play` isn't immediately re-paused).
3. Arm a safety timeout (miruro uses `AUTOPLAY_HOLD_TIMEOUT_MS = 10 s`) that lifts the hold even if no command ever arrives — e.g. a brand-new room with no state yet — so the viewer is never stuck unable to start playback.

This is adapter-side guidance, not a contract method: the background's pre-convergence + settle-window suppression already drops these phantom intents on the wire, but holding autoplay in the adapter keeps the *local* player from flashing play→pause and is the cleaner experience.

## Catalog reporting (`scrapeCatalog`)

Adapters that can enumerate a visible episode list opt in to the optional `scrapeCatalog()` method. The runtime invokes it once per adapter lifetime — right after `init` resolves — and forwards the result to the background, which populates the JOIN frame's `catalogFragment` field. The room's `JoinHandler` then merges the entries into the playlist via `PlaylistService::merge`, and seeds an empty room's cursor from the joiner's `currentlyShowing` (derived from the adapter's identity + `location.href`). See [`protocol-client.md`](protocol-client.md) for the wire-side framing.

```ts
async scrapeCatalog(): Promise<VideoRefWithMeta[] | null>
```

Rules:

- **Optional.** Omit the method entirely if your site has no usable catalog (single-video pages, embeds, etc.). The runtime treats absence the same as a `null` result.
- **Runtime owns the timeout.** `SCRAPE_CATALOG_TIMEOUT_MS` (2 s) caps total latency. Take the time you need within reason — you don't need a per-adapter timer.
- **Throwing is fine.** The runtime catches and treats as `null`. Don't add defensive try/catches just to be polite.
- **Return `null` for "not available right now."** Cold pages where the list hasn't hydrated, layouts without one, parse failures — all `null`. Empty arrays are coerced to `null` too; the JOIN frame omits the field entirely either way.
- **`pageUrl` is the full URL.** Origin included. `ContentIdentity.normalizedUrl` is hostname-stripped for identity comparison and is **not** interchangeable here — the server stores `pageUrl` so a later cursor change can navigate clients back to it.
- **Reconnects skip it.** The runtime calls `scrapeCatalog` exactly once per adapter activation. The first JOIN carries the result; reconnect JOINs go out bare. Tying scrape behavior to "always on JOIN" would scrape repeatedly on flaky networks for no extra benefit (`PlaylistService::merge` is idempotent).

See [`miruro/index.ts`](../src/adapters/miruro/index.ts) `scrapeCatalog` for a working `MutationObserver`-based implementation against a live site, and [`_template/index.ts`](../src/adapters/_template/index.ts) for the minimal stub.

## Things that look like they should be in the contract but aren't

- **`currentlyShowing()`** — derivable from identity already; if the protocol's `currentlyShowing` ends up needing more fields, we'll add it.
- **`onError(callback)`** — adapters that need to surface non-fatal issues can just call `ctx.log('warn', ...)`. There's no rich error channel.
- **Page-context (MAIN-world) hooks** — workshop §3.D allows them but no current adapter needs them. When a site does need them (e.g. to reach into a JS player object that the isolated world can't see), an `injected/` script paired with `postMessage` is the right shape. Out of scope for the contract itself.
