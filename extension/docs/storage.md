# Storage

The extension uses `chrome.storage.local` for the few pieces of state that must survive a service-worker restart, plus `chrome.storage.session` for one cold-boot sentinel. Everything else is module-state in the running worker (which is fine — MV3 restores it on the next wake-up).

The wrapper is at [`src/background/storage.ts`](../src/background/storage.ts). Only the WS client + background entrypoint read/write through it; nothing else in the codebase touches `chrome.storage` directly.

## Schema — one slot per syncing tab

Each tab that is (or was) syncing has its own JSON object under `chrome.storage.local['pbsync.tab.<tabId>']`:

```jsonc
{
  "syncUrl":      "wss://<nextcloud-host>/index.php/apps/playbacksync/ws/<room-uuid>",
  "syncPassword": "<plaintext room password>",
  "clientId":     "<server-assigned hex string>"        // optional, written by the client
}
```

| Field | Set by | Read by | Why it lives here |
|-------|--------|---------|-------------------|
| `syncUrl` | Share-URL pickup on that tab | `ws.ts` on every connect for that tab | Tells the client which room to join |
| `syncPassword` | Same | `ws.ts` (sent inside `JOIN`) | Authenticates against `room.password_hash` |
| `clientId` | `ws.ts` on the first `ROOM_STATE` after JOIN | `ws.ts` on subsequent reconnects (becomes `JOIN.clientId`) | Lets the daemon resume the session via tombstone replay |

Per-tab keying means multiple rooms can coexist in one browser, share-URL pickups never fight for one global slot, and `chrome.tabs.onRemoved` has a precise cleanup signal: remove the matching key, no one else cares.

## Cold-boot sentinel

`chrome.storage.session['pbsync.booted']` is a single boolean. Set on the first service-worker boot of a browser session by `wipeIfFreshBrowserSession()`; cleared by the browser on each restart. When the sentinel is absent at boot, every `pbsync.tab.*` key is removed before `bootstrap()` reads them — so a browser restart never auto-rejoins.

`chrome.storage.session` is MV3-only. A Firefox MV2 port will substitute a module-scope `let booted = false` flag set on first `defineBackground` invocation.

## Share-URL pickup

The standard way creds enter the extension is the share-link flow:

1. Visit `/apps/playbacksync/r/{uuid}`; the browser surfaces a Basic Auth prompt.
2. Enter the one-time password; `ShareController` 302s to `room.bootstrapUrl?sync_url=…&sync_password=…`.
3. The dedicated content script [`entrypoints/credentials.content.ts`](../entrypoints/credentials.content.ts) sniffs those params at `document_start` and sends a `credentials` message to the background — tagged with the capturing tab's `sender.tab.id` (Chrome supplies this).
4. The background's `handleCredentials(tabId, …)` writes the pair to `pbsync.tab.<tabId>` via `saveCreds(tabId, …)` and calls `ensureConnectedWithCreds(tabId, …)`.

There is **no first-write-wins guard**. Each tab gets its own slot. Pasting a share URL into a second tab joins that tab to its own room without disturbing the first.

The URL is left untouched after handoff — `sync_password` stays visible in the address bar. Hardening that path is a server-side concern (fragment handoff, server-set cookie) and out of scope for this slice.

The credential params are also treated as **sticky**: when the navigation-guard pulls a tab back to the room cursor (see [architecture.md](architecture.md)), the hard-nav target is built with `sync_url` / `sync_password` re-attached from the stored creds (`withCredentialParams` in [`entrypoints/background.ts`](../entrypoints/background.ts)). The cursor's `pageUrl` is the canonical param-free form, and some sites (miruro) strip arbitrary query params when you navigate away — so without this the pull-back would land back on the cursor with the credentials gone. This is enforced **only at the guard's hard-nav pull-back**, not on in-playlist episode clicks or server-driven cursor changes (those route through the site's own SPA navigation, which the extension doesn't control for query params). Re-attaching the params is harmless: `credentials.content.ts` is first-write-wins, and the guard's URL matching ignores these params when deciding playlist membership, so it never loops.

## Dev workflow — seeding creds by hand

Available as a manual fallback / debug tool when there's no convenient share link (e.g. testing against `occ playbacksync:ws-serve` without a real dashboard round-trip):

1. Create a room via the PlaybackSync dashboard. Copy the WS URL (`wss://<host>/index.php/apps/playbacksync/ws/<uuid>`) and the one-time password.
2. Find the tab id you want to seed: open the page you want to sync, run `(await chrome.tabs.query({active: true, currentWindow: true}))[0].id` in any extension DevTools console.
3. With `npm run dev` running and the extension loaded, open the **background service worker's DevTools** — `chrome://extensions` → PlaybackSync → "Inspect views: service worker".
4. In the worker console, run:
   ```js
   await chrome.storage.local.set({
     'pbsync.tab.<TAB_ID>': {
       syncUrl: 'wss://<host>/index.php/apps/playbacksync/ws/<uuid>',
       syncPassword: '<password>',
     },
   })
   ```
5. Reload the extension (`chrome://extensions` → "Reload"). The next worker boot picks up the slot via `loadAllCreds()` and calls `ensureConnectedWithCreds()`.

To leave the room / wipe creds for a single tab:

```js
await chrome.storage.local.remove('pbsync.tab.<TAB_ID>')
```

To inspect what's currently stored:

```js
const all = await chrome.storage.local.get(null)
Object.fromEntries(Object.entries(all).filter(([k]) => k.startsWith('pbsync.tab.')))
```

## Lifecycle

```
Background boot
  │
  ▼ wipeIfFreshBrowserSession()
   ├─ sentinel present → no-op
   └─ sentinel absent  → remove every pbsync.tab.* key, then set sentinel
  │
  ▼ loadAllCreds()
   ├─ empty → idle (hint logged, no connects)
   └─ entries present, for each (tabId, creds):
       │
       ▼ chrome.tabs.get(tabId)
        ├─ tab missing → clearCreds(tabId)        ← orphan prune
        └─ tab live    → ensureConnectedWithCreds(tabId, creds)
                          │
                          ▼ first ROOM_STATE for that tab
                          saveClientId(tabId, frame.clientId)
                          │
                          (steady state)
                          │
                          ▼ on chrome.tabs.onRemoved
                          disconnect(tabId) + clearCreds(tabId)
                          │
                          ▼ on terminal close (AUTH_FAILED / KICKED / …)
                          tearDownTab(tabId) wipes the slot automatically
```

`saveClientId(tabId, …)` reads-then-writes so a stale clientId can't overwrite a slot whose creds were just rewritten.

## What's deliberately *not* stored here

- **Cursor / playlist / playerState.** Room-shared and authoritative server-side. Caching them locally would just risk drift.
- **`lastEventId`.** Held in each tab's `SessionState` only — losing it across a worker restart is fine; the worst case is we don't get a replay on reconnect, which is recoverable (we get a fresh `ROOM_STATE` instead).
- **Per-adapter cache.** Adapters are stateless across page loads.

## Future tightening

- **Auto-`clearCreds` on terminal `AUTH_FAILED`** for one tab is already wired (`tearDownTab` runs on every terminal close). What's still missing is surfacing a popup notification so the user understands why their tab dropped out.
- **Cross-tab clientId sharing.** Today each tab mints its own `clientId`. The "one identity per browser" idea is parked in [`EXTENSION_TODO.md`](../../EXTENSION_TODO.md); making it work would mean pivoting from per-tab WS to per-room WS, plus solving within-room arbitration.
