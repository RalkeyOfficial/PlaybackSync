# Adapter Contract

Adapters are the **only** code that knows how a particular streaming site lays out its DOM. They find the `<video>`, observe what the user does to it, apply commands from the room, and derive an identity that uniquely names the content. They never see the WebSocket, never decide whether an action is suppressed, never know what other tabs are doing.

This page is a working tutorial for writing one. The reference implementation is [`src/adapters/_template/`](../src/adapters/_template/index.ts).

## The contract, in one screen

```ts
interface Adapter {
  id: string
  canHandlePage(url: URL): boolean
  init(ctx: AdapterContext): Promise<void>
  getState(): VideoState | null
  setPlaybackRate(rate: number): void
  scrapeCatalog?(): Promise<VideoRefWithMeta[] | null>
  destroy(): void
}
```

That's it. Every other type in [`src/adapters/types.ts`](../src/adapters/types.ts) is either a payload shape or the bridge object (`AdapterContext`) the runtime hands you in `init`.

| Method | Lifetime | What it must do | What it must **not** do |
|--------|----------|-----------------|--------------------------|
| `id` | static | A stable string. Used in logs and command routing. | Match another adapter's id. |
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
- **`emitCursorTrigger(target)`** — call when the user clicks an in-page navigation control (e.g. an episode button) and the page is about to move to a different `VideoRef`. Call passively — **do not `preventDefault`**; the host page's own routing handles the local nav, we just piggyback the announcement. The background decides per the current room's mode + playlist whether to send `CURSOR_CHANGE_REQUEST`, drop the trigger, or soft-leave the room (see [`protocol-client.md`](protocol-client.md#viewer-driven-cursor-changes)). The adapter stays mode-unaware. Filter on `Event.isTrusted` so synthetic clicks dispatched by your own `cursor_change` command handler don't loop back.
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
12. **Document it.** Add a short note under `extension/docs/adapter-<site>.md` (or a section on this page) describing how the site behaves, what URLs are supported, anything surprising about the DOM. Per the [documentation policy](README.md#documentation-policy), this is non-optional.

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
