# Architecture

The PlaybackSync extension is a two-process WXT application: a **background service worker** (Chromium MV3) / **long-lived background page** (Firefox MV2), and **content scripts** that run in every page's isolated world. They communicate only through `chrome.runtime` message passing — the background never touches the DOM, the content side never opens a WebSocket. That separation is what makes new-site support a single-file change rather than a refactor.

## Entrypoints

| File | Role | `runAt` |
|------|------|---------|
| `entrypoints/background.ts` | Service worker / background page. WS lifecycle, message routing, command dispatch. | n/a |
| `entrypoints/content.ts` | Adapter runtime bootstrap — picks an adapter for the page, runs status polling, delivers inbound commands. | `document_idle` |
| `entrypoints/credentials.content.ts` | One-shot share-URL credential sniffer. Sends a `credentials` message when the URL carries `?sync_url=&sync_password=` and exits. See [`storage.md`](storage.md). | `document_start` |
| `entrypoints/popup/` | Toolbar popup (stub today; covered by a future spec). | n/a |

## The three layers

```
┌────────────────────────────────────────────────────────────────────┐
│  Background service worker            (entrypoints/background.ts)  │
│  ──────────────────────────────────────────────────────────────    │
│  · WebSocket lifecycle, JOIN handshake, reconnect with replay      │
│  · Heartbeat & clock-ping timers                                   │
│  · Server-frame dispatch → AuthoritativeCommand → tab              │
│  · Feedback-loop suppression (per-tab)                             │
│  · chrome.storage.local for creds                                  │
└────────────────────────────────────────────────────────────────────┘
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

## The message envelope

`src/messages.ts` defines two discriminated unions:

**Content → Background** (`ContentToBackground`):

| kind | payload | when |
|------|---------|------|
| `intent` | `adapterId`, `intent: LocalIntent` (`play`/`pause`/`seek` + time) | User did something to the video |
| `status` | `adapterId`, `state: VideoState` (`currentPos`, `playerState`) | Every 1 s while an adapter is active |
| `identity` | `adapterId`, `identity: ContentIdentity` (`providerId`, `videoId`, `normalizedUrl`) | Once per adapter init |
| `fail` | `adapterId`, `reason: string` | Adapter can't run on this page |
| `credentials` | `syncUrl`, `syncPassword` | Share-URL pickup fires once at `document_start`; first-write-wins on the background side |

**Background → Content** (`BackgroundToContent`):

| kind | payload | when |
|------|---------|------|
| `command` | `command: AuthoritativeCommand` | Server told us to play / pause / seek / sync_adjust / cursor_change |

`tabId` is read from `sender.tab?.id` on the background side; the content side never sets it.

## Where state lives

| State | Where | Why |
|-------|-------|-----|
| WebSocket connection, timers, reconnect bookkeeping | Module-level in `src/background/ws.ts` | One connection per browser; module-state matches |
| Room-shared state (clientId, lastEventId, cursor, playlist, mode, clock offset) | `SessionState` in `src/background/session.ts` | Pure, foldable by frame handlers |
| Per-tab status cache + identity | `src/background/tabs.ts` (`Map<tabId, TabEntry>`) | Heartbeat needs fresh state without round-trips |
| Suppression windows | `SessionState.recentCommandsByTab` | Co-located with the rest of session state; pruned on every record |
| Adapter activation, command handler ref, status interval | Module-level in `src/adapters/runtime.ts` | One adapter per page; module-state matches |
| Creds (`syncUrl`, `syncPassword`, `clientId`) | `chrome.storage.local.pbsync` | Survive worker termination; see [`storage.md`](storage.md) |

The content side never persists anything across page loads — it boots fresh in every tab, and the SPA-navigation hook tears the active adapter down + re-evaluates whenever `location.href` changes.

## Service-worker lifetime (MV3)

On Chromium ≥ 116, an open `WebSocket` resets the service-worker idle timer on every frame, so the worker stays alive for the lifetime of the connection. When the connection closes (intentionally or after exhausted reconnects), the worker idles and eventually unloads. The next inbound message or `chrome.runtime` event wakes it again; `bootstrap()` re-reads `chrome.storage.local` and re-`connect()`s if creds are still present.

On Firefox MV2 the background page is long-lived by default; no special handling needed.

## Out-of-scope (deferred to follow-up specs)

- **More site adapters.** [`miruro`](adapter-miruro.md) is the first concrete adapter alongside the `_template` test scaffold (which still activates only on `?pbsync-template`). Adding crunchyroll, youtube, etc. is one new file per site plus a registry entry in [`src/adapters/runtime.ts`](../src/adapters/runtime.ts).
- **Popup UI** for connection status, current room, manual disconnect.
- **Multi-room / multi-tab arbitration.** Currently the connection is browser-wide and the "active tab" is just "whoever reported status most recently".
- **`currentlyShowing` + `catalogFragment`** on JOIN. The protocol module has the schema; real values arrive when the first site adapter implements scraping.
