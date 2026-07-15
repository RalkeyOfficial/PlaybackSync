# Toolbar popup

The extension's user-facing surface. Shows the current connection
state, what the room is watching, and a Leave Room button. Lives in
[`entrypoints/popup/`](../entrypoints/popup/); talks to the background
via a long-lived `chrome.runtime.Port` named `'pbsync-popup'`.

## What the popup shows

The popup has four mutually exclusive views, driven by a single
`PopupStatus` tag:

The popup is scoped to a single tab: on connect it derives the active tab via `chrome.tabs.query({active: true, currentWindow: true})` and subscribes the background port to that tab's state. Everything below is per-tab — opening the popup over a different tab shows that tab's room.

| Status | When | View |
|--------|------|------|
| `no_credentials` | No creds in this tab's `pbsync.tab.<tabId>` slot | Header + grey "No room" pill + guidance copy ("Open a share link…") |
| `connecting` | Creds present, socket opening or `ROOM_STATE` not yet received | Amber "Connecting" pill + "Connecting to `<host>`…" copy |
| `joined` | `ROOM_STATE` applied; `clientId` is set | Green "Joined" pill + a top row pairing the your-identity chip ("You · `<nickname>`") on the left with the mode chip on the right + cursor block (provider · label, page URL link) + Leave Room button |
| `disconnected` | Creds present, socket dropped — **reconnect-pending only** (transient drop, backoff in progress) | Red "Offline" pill + your-identity chip + "Reconnecting automatically…" copy + Leave Room button |

The **your-identity chip** shows the server-assigned nickname (e.g. `SwiftFox42`)
carried on `ROOM_STATE.nickname`, so you can always see who you are in the room.
It renders whenever the nickname is known (`joined` and reconnecting
`disconnected`); it's omitted before the first `ROOM_STATE` or against an older
daemon that doesn't send one.

The cursor block reads:

```
miruro · Fate/strange Fake ep 4
https://www.miruro.to/watch/166617/fatestrange-fake?ep=4
```

Clicking the URL opens it in a new tab — useful for jumping the
focused tab back to the room's currently-playing page. When the room
has no cursor yet (empty playlist, fresh JOIN), the block reads
"Nothing playing yet." in italics.

## No manual credential entry

Credentials enter the extension via the share-link flow described in
[`storage.md`](storage.md): the user opens
`/apps/playbacksync/r/<uuid>`, types the room password at the Basic
Auth prompt, the 302 lands on a bootstrap URL carrying
`?sync_url=&sync_password=`, and
[`credentials.content.ts`](../entrypoints/credentials.content.ts)
sniffs them at `document_start`.

The popup deliberately exposes **no** form for typing those values in
manually. Two paths for the same input create drift; the share-link
flow is the one true source. When `status === 'no_credentials'`, the
popup just tells the user to open a share link.

## Messaging contract

Two typed envelopes live in [`src/messages.ts`](../src/messages.ts):

**Popup → Background** (`PopupToBackground`):

| kind | payload | when |
|------|---------|------|
| `subscribe` | `tabId: number` | First envelope after `connect()` — binds the port to a tab |
| `leave_room` | `tabId: number` | User clicked Leave Room (wipes creds) — the only user-driven leave |

**Background → Popup** (`BackgroundToPopup`):

| kind | payload | when |
|------|---------|------|
| `snapshot` | `snapshot: PopupSnapshot` | On port-connect + every popup-visible state change |

The snapshot shape:

```ts
interface PopupSnapshot {
  tabId: number | null             // null only for the no-creds placeholder
  status: PopupStatus              // derived in the background
  clientId: string | null
  nickname: string | null          // your own nickname, from ROOM_STATE.nickname
  cursor: CursorRef | null         // from session.cursor
  mode: 'default' | 'single' | 'freeform' | null
  syncUrl: string | null           // password NEVER included
}
```

`syncPassword` is deliberately omitted — only `syncUrl` crosses the
popup boundary. Even though both run in the same process, a typed
boundary makes accidental leaks (copy-to-clipboard, share-this-state,
future debug exports) structurally impossible.

## Why a Port, not `sendMessage`

The popup needs to re-render when the room changes — a cursor move,
a mode flip, a socket drop. Polling is wasteful (the popup is usually
open for a few seconds at a time and the server pushes state changes
faster than any reasonable poll interval); snapshot-on-open is stale
(the cursor can move while the popup is open).

A `chrome.runtime.Port` solves both: long-lived, bidirectional,
auto-cleans on popup close. The background keeps a `Map<Port, tabId>`
binding every open port to a single tab, and pushes only to ports
whose bound tab is the one mutating — so opening the popup over tab A
and tab B simultaneously never crosses streams.

## What triggers a broadcast

The background calls `notify*` helpers from
[`src/background/popupBroadcast.ts`](../src/background/popupBroadcast.ts)
at these exact points:

All hooks take a `tabId` first parameter so they update — and broadcast for — only that tab's mirror.

| Event | Trigger | Hook |
|-------|---------|------|
| About to open WebSocket | `ws.openSocket` | `notifyConnecting(tabId, url)` |
| Socket reached `'open'` | `ws.onOpen` | `notifyOpen(tabId)` |
| Socket closed (any reason) | `ws.onClose`, `ws.disconnect` | `notifyDisconnected(tabId)` |
| `ROOM_STATE` applied | `ws.handleFrame` ROOM_STATE arm | `notifyRoomStateChanged(tabId)` |
| `CURSOR_CHANGE` applied | `ws.handleFrame` CURSOR_CHANGE arm | `notifyCursorChanged(tabId)` |
| Creds accepted / replaced | `ensureConnectedWithCreds` | `setPopupCreds(tabId, {syncUrl})` |
| Creds wiped (leave / fail / terminal) | `tearDownTab` | `notifyPopupCredsCleared(tabId)` |

Frames that **don't** trigger a broadcast:

- **`STATE`** — fires ~1 Hz per active tab and only updates
  `lastEventId`, which the popup doesn't display. Broadcasting on
  every tick would obscure the events that actually matter.
- **`PLAYLIST_UPDATE`** — there's no playlist UI in this slice.
- **`SYNC_ADJUST`**, **`CLOCK_PONG`** — pure protocol mechanics,
  invisible to the user.

## Leave Room semantics

The wire protocol has no LEAVE frame. "Leave" is a purely client-side
operation, scoped to the popup's bound tab, and there is exactly one way
to trigger it: the popup's **Leave Room** button. Navigation never leaves
a room — an off-target click or off-list navigation in default/single
mode pulls the tab back to the cursor instead (see
[`protocol-client.md`](protocol-client.md#viewer-driven-cursor-changes)).

1. Popup posts `{ kind: 'leave_room', tabId }` on the port.
2. Background calls `disconnect(tabId)` — closes that tab's socket with
   code 1000, sets `terminated = true`, stops its timers, removes the
   pool entry.
3. Background calls `tearDownTab(tabId)` — wipes that tab's
   `pbsync.tab.<tabId>` slot, drops its session from the sessions map,
   clears its navigation-guard arming, calls
   `notifyPopupCredsCleared(tabId)` to push a fresh `no_credentials`
   snapshot to any port still bound to that tab, and greys the toolbar
   icon for that tab.

The popup re-renders to the no-creds view; it does not close itself.
Other tabs' runtimes are untouched.

> The earlier "soft leave + Rejoin" mechanism (a background-driven
> teardown that kept creds and offered a one-click Rejoin) is gone.
> Cursor-trigger arbitration now pulls the tab back rather than tearing
> the runtime down, so `softLeftTabs`, the `rejoin_room` envelope, and
> the Rejoin Room button were all removed. The `disconnected` status
> survives only for genuine reconnect-pending drops.

## Optimistic UI

The Leave Room button transitions to a disabled "Leaving…" state the
moment it's clicked, rather than waiting for the snapshot push to
arrive. The push (typically within a few ms) replaces the entire view
with the real no-creds state. The optimistic transition exists so
that if the user clicks twice it doesn't fire two `leave_room`
messages.

## Cross-browser packaging

WXT auto-discovers the popup at `entrypoints/popup/`. The manifest
already declares `action.default_title = 'PlaybackSync'` in
[`wxt.config.ts`](../wxt.config.ts); no popup-specific config is
required. The popup styles use CSS custom properties with a
`prefers-color-scheme` media query, so it picks up the browser's dark
mode without any extra wiring.

## Smoke test

See [`README.md`](../README.md) §"Smoke test against a real sync
daemon" for the end-to-end recipe. The short version: open the popup,
join via a share URL, watch the pill flip amber → green; open a
miruro page in a synced tab, watch the cursor block update; click
Leave Room, watch it flip to the grey no-creds view.
