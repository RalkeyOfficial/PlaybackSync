# Toolbar popup

The extension's user-facing surface. Shows the current connection
state, what the room is watching, and a Leave Room button. Lives in
[`entrypoints/popup/`](../entrypoints/popup/); talks to the background
via a long-lived `chrome.runtime.Port` named `'pbsync-popup'`.

## What the popup shows

The popup has four mutually exclusive views, driven by a single
`PopupStatus` tag:

| Status | When | View |
|--------|------|------|
| `no_credentials` | No creds in `chrome.storage.local.pbsync` | Header + grey "No room" pill + guidance copy ("Open a share link…") |
| `connecting` | Creds present, socket opening or `ROOM_STATE` not yet received | Amber "Connecting" pill + "Connecting to `<host>`…" copy |
| `joined` | `ROOM_STATE` applied; `clientId` is set | Green "Joined" pill + cursor block (provider · label, page URL link) + mode chip + Leave Room button |
| `disconnected` | Creds present, socket dropped (reconnect-pending or terminal) | Red "Offline" pill + "Connection lost. Trying to reconnect…" copy + Leave Room button |

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
| `leave_room` | — | User clicked Leave Room |

**Background → Popup** (`BackgroundToPopup`):

| kind | payload | when |
|------|---------|------|
| `snapshot` | `snapshot: PopupSnapshot` | On port-connect + every popup-visible state change |

The snapshot shape:

```ts
interface PopupSnapshot {
  status: PopupStatus              // derived in the background
  clientId: string | null
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
auto-cleans on popup close. The background keeps a `Set<Port>` and
pushes to every entry on every state change.

## What triggers a broadcast

The background calls `notify*` helpers from
[`src/background/popupBroadcast.ts`](../src/background/popupBroadcast.ts)
at these exact points:

| Event | Trigger | Hook |
|-------|---------|------|
| About to open WebSocket | `ws.openSocket` | `notifyConnecting(url)` |
| Socket reached `'open'` | `ws.onOpen` | `notifyOpen()` |
| Socket closed (any reason) | `ws.onClose`, `ws.disconnect` | `notifyDisconnected()` |
| `ROOM_STATE` applied | `ws.handleFrame` ROOM_STATE arm | `notifyRoomStateChanged()` |
| `CURSOR_CHANGE` applied | `ws.handleFrame` CURSOR_CHANGE arm | `notifyCursorChanged()` |
| Creds loaded / accepted / cleared | `bootstrap`, `handleCredentials`, `handlePopupMessage` | `setPopupCreds(…)` |

Frames that **don't** trigger a broadcast:

- **`STATE`** — fires ~1 Hz per active tab and only updates
  `lastEventId`, which the popup doesn't display. Broadcasting on
  every tick would obscure the events that actually matter.
- **`PLAYLIST_UPDATE`** — there's no playlist UI in this slice.
- **`SYNC_ADJUST`**, **`CLOCK_PONG`** — pure protocol mechanics,
  invisible to the user.

## Leave Room semantics

The wire protocol has no LEAVE frame. "Leave" is a purely client-side
operation:

1. Popup posts `{ kind: 'leave_room' }` on the port.
2. Background calls `disconnect()` — closes the socket with code
   1000, sets `terminated = true`, stops timers.
3. Background calls `clearCreds()` — wipes
   `chrome.storage.local.pbsync`.
4. Background resets session identity (`clientId`, `lastEventId`,
   `cursor`, `playlist`) so a subsequent share-URL pickup against a
   different room can't accidentally JOIN with a stale clientId.
5. Background calls `setPopupCreds(null)` — clears the broadcast
   mirror and pushes a fresh `no_credentials` snapshot to every open
   port.

The popup re-renders to the no-creds view; it does not close itself.
The user can stay on that view and read the guidance text.

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
