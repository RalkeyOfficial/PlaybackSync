# Storage

The extension uses `chrome.storage.local` for the few pieces of state that must survive a service-worker restart. Everything else is module-state in the running worker (which is fine — MV3 restores it on the next wake-up).

The wrapper is at [`src/background/storage.ts`](../src/background/storage.ts). Only the WS client reads/writes through it; nothing else in the codebase touches `chrome.storage` directly.

## Schema (key `pbsync`)

One JSON object lives at `chrome.storage.local.pbsync`:

```jsonc
{
  "syncUrl":      "wss://<nextcloud-host>/index.php/apps/playbacksync/ws/<room-uuid>",
  "syncPassword": "<plaintext room password>",
  "clientId":     "<server-assigned hex string>"        // optional, written by the client
}
```

| Field | Set by | Read by | Why it lives here |
|-------|--------|---------|-------------------|
| `syncUrl` | Share-URL pickup (preferred) or DevTools (fallback) | `ws.ts` on every connect | Tells the client which room to join |
| `syncPassword` | Same | `ws.ts` (sent inside `JOIN`) | Authenticates against `room.password_hash` |
| `clientId` | `ws.ts` on the first `ROOM_STATE` after JOIN | `ws.ts` on subsequent reconnects (becomes `JOIN.clientId`) | Lets the daemon resume the session via tombstone replay |

The whole object is read at background-worker boot. Missing creds = the WS client stays idle and logs a single hint line.

## Share-URL pickup (preferred)

The standard way to get credentials into `pbsync` is to follow a room share link — the dashboard surfaces these per room.

1. Visit `/apps/playbacksync/r/{uuid}`; the browser surfaces a Basic Auth prompt.
2. Enter the one-time password; `ShareController` 302s to `room.bootstrapUrl?sync_url=…&sync_password=…`.
3. The dedicated content script [`entrypoints/credentials.content.ts`](../entrypoints/credentials.content.ts) sniffs those params at `document_start`, sends a `credentials` message to the background.
4. The background calls `loadCreds()`. If `pbsync` is empty it writes the new pair via `saveCreds()` and calls `ws.connect()`. If `pbsync` is already populated it logs `share-URL creds ignored; pbsync already populated` and does nothing.

This is **first-write-wins**: once you're in a room, share-link revisits are a no-op. To switch rooms, clear creds (see below) and follow the new link.

The URL is left untouched after handoff — `sync_password` stays visible in the address bar. Hardening that path is a server-side concern (fragment handoff, server-set cookie) and out of scope for this slice.

## Dev workflow — seeding creds by hand

Available as a manual fallback / debug tool when there's no convenient share link (e.g. testing against `occ playbacksync:ws-serve` without a real dashboard round-trip):

1. Create a room via the PlaybackSync dashboard. Copy `bootstrapUrl` (actually you want the WS URL — `wss://<host>/index.php/apps/playbacksync/ws/<uuid>`) and the one-time password.
2. With `npm run dev` running and the extension loaded, open the **background service worker's DevTools** — `chrome://extensions` → PlaybackSync → "Inspect views: service worker".
3. In the worker console, run:
   ```js
   await chrome.storage.local.set({
     pbsync: {
       syncUrl: 'wss://<host>/index.php/apps/playbacksync/ws/<uuid>',
       syncPassword: '<password>',
     },
   })
   ```
4. Reload the extension (`chrome://extensions` → "Reload"). The next worker boot picks up the creds and calls `ws.connect()`.

To leave the room / wipe creds:

```js
await chrome.storage.local.remove('pbsync')
```

To inspect what's currently stored:

```js
await chrome.storage.local.get('pbsync')
```

## Lifecycle

```
Background boot
  │
  ▼ loadCreds()
   ├─ no entry          → idle (hint logged, no connect)
   └─ entry present
       │
       ▼ ws.connect(creds, session, cb)
       │
       ▼ first ROOM_STATE
       saveClientId(frame.clientId)        ← only writes if it actually changed
       │
       (steady state)
       │
       ▼ on close (terminal)
       caller may clearCreds()             ← e.g. AUTH_FAILED → don't auto-retry with bad password
```

`saveClientId` reads-then-writes so a stale clientId can't overwrite credentials someone just updated.

## What's deliberately *not* stored here

- **Cursor / playlist / playerState.** These are room-shared and authoritative server-side. Caching them locally would just risk drift.
- **`lastEventId`.** Held in `SessionState` only — losing it across a worker restart is fine; the worst case is we don't get a replay on reconnect, which is recoverable (we get a fresh `ROOM_STATE` instead).
- **Per-tab state.** Tabs come and go; no point persisting them.
- **Per-adapter cache.** Adapters are stateless across page loads.

## Future tightening

- **Replace-and-reconnect on a fresh share link.** Today's policy is first-write-wins — once `pbsync` is populated, subsequent share-link visits are ignored. The popup will eventually expose a "leave room" action that calls `clearCreds`, after which the next share link is picked up normally. Adding mid-flight replace semantics is a follow-up once that UI exists.
- **Auto-`clearCreds` on terminal `AUTH_FAILED`.** Today the WS module's `onTerminal` callback only logs. When the daemon hard-rejects credentials (e.g. password rotated server-side) we should wipe them so the next share-link visit isn't blocked by stale-and-broken creds.
- **Multi-room keying.** When per-room state matters (multi-room arbitration), `pbsync` will likely grow into a map keyed by room UUID. That's a schema change worth flagging at the time, not pre-empting now.
