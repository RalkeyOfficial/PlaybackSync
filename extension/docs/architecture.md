# Architecture

The PlaybackSync extension is a two-process WXT application: a **background service worker** (Chromium MV3) / **long-lived background page** (Firefox MV2), and **content scripts** that run in every page's isolated world. They communicate only through `chrome.runtime` message passing — the background never touches the DOM, the content side never opens a WebSocket. That separation is what makes new-site support a single-file change rather than a refactor.

## Entrypoints

| File | Role | `runAt` |
|------|------|---------|
| `entrypoints/background.ts` | Service worker / background page. WS lifecycle, message routing, command dispatch. | n/a |
| `entrypoints/content.ts` | Adapter runtime bootstrap — picks an adapter for the page, runs status polling, delivers inbound commands. | `document_idle` |
| `entrypoints/credentials.content.ts` | One-shot share-URL credential sniffer. Sends a `credentials` message when the URL carries `?sync_url=&sync_password=` and exits. See [`storage.md`](storage.md). | `document_start` |
| `entrypoints/popup/` | Toolbar popup — status pill, current cursor, Leave Room. See [`popup.md`](popup.md). | n/a |

## The three layers

```
┌──────────────────────────┐         ┌────────────────────────────────────────────────────────────────────┐
│  Toolbar popup           │         │  Background service worker            (entrypoints/background.ts)  │
│  (entrypoints/popup/)    │  Port   │  ──────────────────────────────────────────────────────────────    │
│  ────────────────────    │ ◀────▶  │  · WebSocket lifecycle, JOIN handshake, reconnect with replay      │
│  · Status pill           │ snapshot│  · Heartbeat & clock-ping timers                                   │
│  · Current cursor        │ /       │  · Server-frame dispatch → AuthoritativeCommand → tab              │
│  · Leave Room button     │ leave_  │  · Feedback-loop suppression (per-tab)                             │
│  See popup.md            │ room    │  · chrome.storage.local for creds                                  │
└──────────────────────────┘         └────────────────────────────────────────────────────────────────────┘
                                                              ▲   │
                                              ContentToBackground │ BackgroundToContent
                                                              │   ▼
                                     ┌────────────────────────────────────────────────────────────────────┐
                                     │  Content script runtime               (entrypoints/content.ts +    │
                                     │                                        src/adapters/runtime.ts)    │
                                     │  ──────────────────────────────────────────────────────────────    │
                                     │  · Pick first adapter whose canHandlePage() returns true           │
                                     │  · Wire bridge that forwards intent/status/identity/fail           │
                                     │  · Poll adapter.getState() every 1 s, push status                  │
                                     │  · Deliver inbound commands to the active adapter                  │
                                     │  · Tear down + re-evaluate on SPA navigation                       │
                                     └────────────────────────────────────────────────────────────────────┘
                                                              ▲   │
                                                emitIntent /  │   │  onCommand handler
                                                getState /    │   │
                                                setIdentity   │   ▼
                                     ┌────────────────────────────────────────────────────────────────────┐
                                     │  Site adapter                        (src/adapters/<site>/)        │
                                     │  ──────────────────────────────────────────────────────────────    │
                                     │  · Find the <video> element                                        │
                                     │  · Observe user play/pause/seek → emit local intents               │
                                     │  · Apply authoritative commands verbatim                           │
                                     │  · Derive strict content identity                                  │
                                     │  · Expose current state on demand for heartbeats                   │
                                     └────────────────────────────────────────────────────────────────────┘
```

### Why this split

The legacy prototype's [workshop v1 design](../../OLD_CODE/extension/docs/playback_sync_extension_architecture_adapter_based_design_workshop_v_1.md) made the case explicitly: **adapters MUST NOT touch the WebSocket, MUST NOT decide suppression, MUST NOT communicate across tabs**. That keeps every site adapter small, statically auditable, and safe to write without understanding the protocol. The price is the dance of message passing, which is worth paying.

The background is the *protocol client*; the content runtime is the *adapter manager*; site adapters are the *execution layer*. Adding a new site means writing one file that implements the `Adapter` contract and adding it to the registry in `src/adapters/runtime.ts`.

### Popup snapshot channel

The popup talks to the background over a `chrome.runtime.Port` named `'pbsync-popup'`. On connect, the popup posts a `subscribe` envelope naming the tab it cares about (the active tab when the popup opened); the background binds the port to that tab and broadcasts a typed `PopupSnapshot` on every popup-visible state change *for that tab* (lifecycle transitions, `ROOM_STATE`, `CURSOR_CHANGE`, creds change) — never on per-tick `STATE` frames. The popup never reads raw socket / `clientId` / creds fields; it sees only the derived `status` tag (`no_credentials` / `connecting` / `joined` / `disconnected`) plus the cursor and mode for the bound tab. Details in [`popup.md`](popup.md).

## The message envelope

`src/messages.ts` defines two discriminated unions:

**Content → Background** (`ContentToBackground`):

| kind | payload | when |
|------|---------|------|
| `intent` | `adapterId`, `intent: LocalIntent` (`play`/`pause`/`seek` + time) | User did something to the video |
| `status` | `adapterId`, `state: VideoState` (`currentPos`, `playerState`) | Every 1 s while an adapter is active |
| `identity` | `adapterId`, `identity: ContentIdentity` (`providerId`, `videoId`, `normalizedUrl`), `pageUrl` (full `location.href`), `guardNavigation` (the active adapter's opt-in) | Once per adapter init |
| `catalog` | `adapterId`, `catalog: VideoRefWithMeta[] \| null` | Once per adapter init, after `scrapeCatalog()` resolves |
| `cursor_trigger` | `adapterId`, `target: VideoRefWithMeta` | User clicked an in-page nav control (e.g. an episode button) |
| `fail` | `adapterId`, `reason: string` | Adapter can't run on this page |
| `credentials` | `syncUrl`, `syncPassword` | Share-URL pickup fires once at `document_start`; binds to the capturing tab's `pbsync.tab.<tabId>` slot |

**Background → Content** (`BackgroundToContent`):

| kind | payload | when |
|------|---------|------|
| `command` | `command: AuthoritativeCommand` | Server told us to play / pause / seek / nudge_rate / cursor_change |

`tabId` is read from `sender.tab?.id` on the background side; the content side never sets it.

## Where state lives

| State | Where | Why |
|-------|-------|-----|
| WebSocket connections, timers, reconnect bookkeeping | `pool: Map<tabId, WsRuntime>` in `src/background/ws.ts` | One connection per syncing tab; each tab is its own server-side client |
| Room-shared state (clientId, lastEventId, cursor, playlist, mode, clock offset) | One `SessionState` per pooled runtime; entrypoint owns `Map<tabId, SessionState>` | Pure, foldable by frame handlers; one session per tab |
| Per-tab status cache + identity | `src/background/tabs.ts` (`Map<tabId, TabEntry>`) | Heartbeat needs fresh state without round-trips |
| Suppression windows + join-time convergence gates | `SessionState.recentCommands`, `converged`, `settleUntil`, `awaitingReload` (one session per tab — all scalars now that each WS runtime is keyed by `tabId`) | Co-located with the rest of session state; pruned on record / on tab close / on (re)connect — see [`protocol-client.md`](protocol-client.md#feedback-loop-suppression) |
| Navigation-guard arming | `navGuardedTabs: Map<tabId, adapterId>` + `navGuardTimers` in `entrypoints/background.ts` | Independent of `sessions` (the `identity` message can arrive before the WS session exists); cleared on every teardown path |
| Adapter activation, command handler ref, status interval | Module-level in `src/adapters/runtime.ts` | One adapter per page; module-state matches |
| Creds (`syncUrl`, `syncPassword`, `clientId`) | `chrome.storage.local['pbsync.tab.<tabId>']`, one slot per syncing tab | Survive worker termination; wiped on `chrome.tabs.onRemoved` and on browser restart; see [`storage.md`](storage.md) |

The content side never persists anything across page loads — it boots fresh in every tab, and the SPA-navigation hook tears the active adapter down + re-evaluates whenever `location.href` changes.

## Anchored rooms: pull-back, not leave

Default and single mode are **anchored**: the room is "we're watching *this* content," and the correct response to a tab drifting off it is to yank the tab back, not to eject the user. Navigation never leaves a room. The **only** user-driven leave is the popup's Leave Room button.

Two mechanisms enforce the anchor, covering different kinds of departure:

- **Cursor-trigger arbitration (all sites).** The adapter's in-page DOM click listener calls `emitCursorTrigger` when the user clicks a nav control. The background decides per mode + playlist (`handleCursorTrigger`): default-in-playlist & freeform → `CURSOR_CHANGE_REQUEST`; default-off-list & single-mismatch → `pullTabBackToCursor`, which dispatches a synthetic `cursor_change` back to the adapter (synth-click, `location.href` fallback). This is the primary, all-sites-safe path — it's the only signal on sites whose URL doesn't change between videos.
- **The navigation-guard (opt-in).** A `chrome.tabs.onUpdated` listener catches the departures the DOM listener can't see — home link, related-video thumbnails, address bar, back/forward, JS redirect, cross-site. Opt-in per adapter via `Adapter.guardNavigation` (the flag rides the `identity` message; the background stores `navGuardedTabs`). Purely additive; never replaces the DOM path.

Both replaced the older "soft-leave + Rejoin" model wholesale — that scaffolding (`softLeaveTab`, `softLeftTabs`, `handleRejoinRoom`, the `rejoin_room` popup envelope, the Rejoin button) is gone. The full arbitration matrix and guard gating live in [`protocol-client.md` §Viewer-driven cursor changes](protocol-client.md#viewer-driven-cursor-changes).

### URL matching is identity-based and adapter-owned

The guard never string-compares URLs. Membership is **by video identity**: `isRoomUrl` resolves the live tab URL to a canonical `videoId` through the *active adapter's* pure, DOM-free `videoIdForUrl(url)` matcher and compares against the cursor + playlist `videoId`s. Each adapter ships that matcher in its own `url` module (e.g. `src/adapters/miruro/url.ts`), registered by adapter id in `src/adapters/url-matchers.ts`; the background imports the registry **without** pulling in the DOM-bound adapter class. A `null` id (wrong site, home, search) counts as off-playlist. This is what absorbs miruro's optional `/watch/<id>/<slug>` slug and lets the share-link `?sync_url=&sync_password=` handoff params sit in the address bar without tripping the guard — only identity-bearing parts of the URL are read.

### Re-converging without closing the socket

A guard pull-back is a `chrome.tabs.update` — a full reload. The WS lives in the background and survives it, and the guard deliberately keeps it open: a close would announce a spurious `client_left` / `client_joined` flap to the room. But a converged session would let the reloaded player's autoplay + resume-position seek leak as wire events, so the guard re-runs the join grace period *in place*: `resetConvergence` un-converges, and `SessionState.awaitingReload` holds convergence off — suppressing `markConverged` even against server frames landing mid-reload — until the reloaded page reports the **cursor's** identity (the `identity` route then clears the flag and `markConverged`s, arming a fresh settle window). `GUARD_RELOAD_CONVERGE_FALLBACK_MS` un-strands a tab whose reload never reports the cursor. See [`protocol-client.md` §Feedback-loop suppression](protocol-client.md#feedback-loop-suppression).

The hard-nav target is built with the share-link credential params re-attached: `withCredentialParams` sets `sync_url` / `sync_password` from the stored creds onto the cursor's (canonical, param-free) `pageUrl`. Sites like miruro strip arbitrary query params when you navigate away, so without this the pull-back would land back on the cursor with the credentials gone — see [`storage.md`](storage.md). This stickiness is enforced only here, at the guard's hard-nav; in-playlist clicks and server-driven cursor changes route through the site's own SPA navigation, which the extension doesn't control for query params.

### Seek-then-play/pause ordering

`applyRoomState` / `applyState` ([`src/background/session.ts`](../src/background/session.ts)) emit **seek first, then play/pause** — play/pause must be the *last* action applied. Some players (Vidstack on miruro) resume playback as a side effect of a seek, so a trailing seek silently undid a leading `pause` and left the tab playing against a paused room — surfacing as a ~5 s re-correction loop. Keeping play/pause last makes "apply room state" land the `playerState` the frame asked for.

## Service-worker lifetime (MV3)

On Chromium ≥ 116, an open `WebSocket` resets the service-worker idle timer on every frame, so the worker stays alive while any pooled runtime has an open socket. When the last one closes (intentionally or after exhausted reconnects), the worker idles and eventually unloads. The next inbound message or `chrome.runtime` event wakes it again; `bootstrap()` enumerates every `pbsync.tab.<tabId>` slot, verifies the tab still exists via `chrome.tabs.get(tabId)`, prunes orphan slots, and re-`connect()`s the survivors.

A separate one-shot guard runs before that: `wipeIfFreshBrowserSession()` checks a sentinel in `chrome.storage.session` (which the browser clears on each restart). When the sentinel is absent, every `pbsync.tab.*` key is removed before bootstrap reads them — so a browser restart never auto-rejoins a room. `chrome.storage.session` is MV3-only; the Firefox MV2 port will substitute a module-scope `let booted = false` flag.

On Firefox MV2 the background page is long-lived by default; no special handling needed.

## Out-of-scope (deferred to follow-up specs)

- **More site adapters.** [`miruro`](adapter-miruro.md) is the first concrete adapter alongside the `_template` test scaffold (which still activates only on `?pbsync-template`). Adding crunchyroll, youtube, etc. is one new file per site plus a registry entry in [`src/adapters/runtime.ts`](../src/adapters/runtime.ts).
- **Browser-wide shared `clientId`** so admins see one identity per browser across rooms. Parked while shaping the per-tab connection model — see [`EXTENSION_TODO.md`](../../EXTENSION_TODO.md) Deferred. The pivot would mean one WS per `roomId` (not per `tabId`), which revives the within-room arbitration question.
