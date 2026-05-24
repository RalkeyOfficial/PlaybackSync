# PlaybackSync Extension — Plugin Architecture Foundation

## Context

The PlaybackSync browser extension under `extension/` is currently a WXT scaffold: `entrypoints/background.ts`, `entrypoints/content.ts`, and `entrypoints/popup/main.ts` all just log on boot. None of the actual sync behaviour (talking to the WebSocket sync daemon, observing/controlling the page `<video>`) exists yet.

The intended architecture is **plugin-based**: each streaming site (miruro, crunchyroll, youtube, …) is its own *adapter* that knows how to find that site's video element, observe user actions, and execute playback commands. A central runtime selects the right adapter for the current page; the background service worker owns the WebSocket protocol (see [../../../docs/ws-protocol.md](../../../docs/ws-protocol.md)). Adapters never touch the WebSocket; the background never touches the DOM. Adding support for a new site then becomes a self-contained PR that drops in one new adapter file.

The legacy prototype under `OLD_CODE/extension/` reached a locked design in [../../../OLD_CODE/extension/docs/playback_sync_extension_architecture_adapter_based_design_workshop_v_1.md](../../../OLD_CODE/extension/docs/playback_sync_extension_architecture_adapter_based_design_workshop_v_1.md). The chosen stance is **"adopt the bones, revise during build"**: workshop layering and contract are the starting reference, but specifics (notably "fatal on identity change") may flex once the v2 protocol's `CURSOR_CHANGE` navigation lands. The WS protocol has since moved to v2 — `CURSOR_CHANGE`/`PLAYLIST_UPDATE` replace `EPISODE_CHANGE`, and adapters can contribute scraped `catalogFragment` / `currentlyShowing` data — but the layer split is unchanged.

This spec covers the **first slice** of Phase 2 from [../../product/roadmap.md](../../product/roadmap.md): define the adapter interface, build the content-side runtime, and ship a `_template` adapter that demonstrates the contract. The WS client, real site adapters (miruro etc.), credential pickup from `?sync_url=&sync_password=` (already emitted by `ShareController::buildRedirectUrl`), and popup UI are deferred to follow-up specs.

## Task 1 — Save spec documentation

This folder. See `shape.md`, `standards.md`, `references.md`.

## Task 2 — Define the adapter contract

Create `extension/src/adapters/types.ts`:

- `interface Adapter { id: string; canHandlePage(url: URL): boolean; init(ctx: AdapterContext): Promise<void>; destroy(): void }` — workshop §4 shape
- `interface AdapterContext { emitIntent(intent: LocalIntent): void; onCommand(handler: (cmd: AuthoritativeCommand) => void): void; setIdentity(identity: ContentIdentity): void; fail(reason: string): void; log(level: 'info'|'warn'|'error', msg: string, data?: Record<string, unknown>): void }`
- `type LocalIntent = { type: 'play' | 'pause' | 'seek'; time?: number }`
- `type AuthoritativeCommand = { type: 'play' | 'pause' | 'seek' | 'sync_adjust' | 'cursor_change'; time?: number; delta?: number; pageUrl?: string }`
- `interface ContentIdentity { providerId: string; videoId: string; normalizedUrl: string }` — `videoId` (not `episodeId`) matches v2 wire format; `normalizedUrl` must not include hostname (workshop §7).

## Task 3 — Build the adapter runtime

Create `extension/src/adapters/runtime.ts` (content-world only):

- Static registry: `const ADAPTERS: AdapterFactory[] = [templateAdapterFactory]` — `_template` is the only entry today; new sites are appended here.
- `start(ctx)`: iterate `ADAPTERS` in array order, pick the first whose `canHandlePage(new URL(location.href))` returns true; instantiate; `await adapter.init(ctx)`. If `init` throws or `ctx.fail` is called, log a structured error and stay inactive. If none match: silent no-op.
- SPA navigation: subscribe to `popstate` plus a `history.pushState`/`replaceState` shim; on URL change call `adapter.destroy()` and re-evaluate.

## Task 4 — Wire the `_template` adapter

Create `extension/src/adapters/_template/index.ts`:

- `id: 'template'`
- `canHandlePage(url)`: matches only when `url.searchParams.has('pbsync-template')`.
- `init(ctx)`: find `<video>`, attach `play`/`pause`/`seeking` listeners → `ctx.emitIntent(...)`; register `ctx.onCommand` to drive the video; `ctx.setIdentity({ providerId: 'template', videoId: location.pathname, normalizedUrl: location.pathname })`.
- `destroy()`: removes listeners.

## Task 5 — Wire the content entrypoint

Replace `extension/entrypoints/content.ts`: import the runtime, build an `AdapterContext` that bridges to `chrome.runtime.sendMessage` / `chrome.runtime.onMessage`, call `runtime.start(ctx)`.

Update `extension/wxt.config.ts`: widen content-script `matches` to `<all_urls>` with `runAt: 'document_idle'`. Flagged in `shape.md` as a deliberate trade-off for the plugin model (revisit pre-store-submission).

## Task 6 — Background message envelope

Create `extension/src/messages.ts` with `ContentToBackground` / `BackgroundToContent` types.

Update `extension/entrypoints/background.ts`: listen on `chrome.runtime.onMessage` and `console.log` each `ContentToBackground` for now. No outbound commands yet.

## Task 7 — Smoke-test page

Create `extension/public/template-test.html` — `<video>` + brief usage note (append `?pbsync-template`).

## Verification

From `extension/`:

1. `npm run compile` — passes.
2. `npm run lint` — passes.
3. `npm run dev` — WXT launches dev browser with HMR.
4. Open `chrome-extension://<id>/template-test.html?pbsync-template`. Content-script console logs "adapter activated: template"; play/pause/seek emit intent lines in the background service-worker console.
5. Open `example.com` — content script logs "no adapter matched" once and stays silent.
6. `history.pushState({}, '', '/other')` in the dev page — runtime logs tear-down + re-evaluation.

## Critical files

**Created:** `extension/src/adapters/types.ts`, `extension/src/adapters/runtime.ts`, `extension/src/adapters/_template/index.ts`, `extension/src/messages.ts`, `extension/public/template-test.html`.

**Modified:** `extension/entrypoints/content.ts`, `extension/entrypoints/background.ts`, `extension/wxt.config.ts`.

## Out of scope — follow-up specs

- Background WebSocket client (v2 protocol end-to-end).
- Credential pickup from `?sync_url=&sync_password=` on bootstrap landing.
- Real site adapters (miruro first).
- Popup UI (connection status, leave-room).
- Per-tab session state & cross-tab coordination.
- `currentlyShowing` + `catalogFragment` reporting.
