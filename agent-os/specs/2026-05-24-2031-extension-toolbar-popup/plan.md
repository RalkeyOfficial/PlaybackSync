# Extension — Toolbar Popup

## Context

The browser extension can now drive a real sync session (`_template` + miruro adapters, v2 WS client, share-URL credential pickup all landed), but there is no user-facing surface inside the extension itself. The popup is currently a placeholder (`[playbacksync] popup opened` log, "Extension scaffold — not wired up yet." copy in [`extension/entrypoints/popup/index.html`](../../../extension/entrypoints/popup/index.html)). End-users have no way to see *whether* they're connected, *what room* they're in, *what the room is currently watching*, or *how to leave* — they can only inspect `chrome.storage.local` from DevTools, which is not a real product affordance.

This slice wires the popup into the existing background session state and gives users a minimal status dashboard: connection state, current cursor (provider + label + URL), and a Leave Room button. It's the last item under "Next up" in [`EXTENSION_TODO.md`](../../../EXTENSION_TODO.md); once it lands, the extension is feature-complete for the room-joiner role and the remaining work shifts to owner-driven controls (deferred slices).

Credentials are intentionally **share-URL-only**. The popup does *not* expose a manual creds form — credentials arrive via [`entrypoints/credentials.content.ts`](../../../extension/entrypoints/credentials.content.ts) sniffing `?sync_url=&sync_password=` on the share-link landing. When there are no creds, the popup instructs the user to open a share link.

## Decisions (from shaping)

- **Vanilla TS + plain CSS, no framework.** The popup is small (3 widgets, one button) and the extension is framework-free today; adding Vue/Preact would cost more in build complexity than it saves. The Nextcloud-side `@nextcloud/vue` components are not usable here (different bundle, different runtime).
- **Push-based liveness via `chrome.runtime.Port`.** Popup opens a long-lived `Port` on mount; the background broadcasts a fresh snapshot whenever session state changes (socket open/close, ROOM_STATE applied, CURSOR_CHANGE applied, creds cleared). No polling, no stale data, port closes automatically when the popup unmounts.
- **Broadcast only on lifecycle/cursor events, not per-tick.** `applyState` fires every second per tab and only mutates `lastEventId`; the popup doesn't care. We broadcast on: `connecting`, `open`, `ROOM_STATE`, `CURSOR_CHANGE`, `close`, `clearCreds`. `PLAYLIST_UPDATE` is deferred (no playlist UI in this slice).
- **No manual credentials entry.** Confirmed in shaping. Disconnected/no-creds state shows guidance text only; no form.
- **Cursor display = provider + label + URL.** `cursor.providerId · cursor.label ?? cursor.videoId` as the primary line, `cursor.pageUrl` as a small clickable link below. Clicking opens the URL in a new tab (popup itself isn't navigable).
- **Leave = `clearCreds()` + `disconnect()`.** No protocol-level LEAVE frame exists ([`extension/src/background/ws.ts:112-118`](../../../extension/src/background/ws.ts#L112-L118)). The popup sends a `leave_room` message; the background calls `clearCreds()` then `disconnect()`, broadcasts the now-empty snapshot, and the popup re-renders to the no-creds state without closing.
- **Connection state is a derived union, computed in the background.** The popup never reads raw socket / `clientId` / creds fields — it gets a single `status: 'no_credentials' | 'connecting' | 'joined' | 'disconnected'` value. Keeps the popup logic trivial and centralizes the truth.
- **No tests.** Matches existing extension posture (miruro / WS-client / share-URL-creds all deferred Vitest setup). Verification is `npm run compile` + `npm run lint` + manual smoke against a live daemon.

## Tasks

1. **Save spec documentation** (this folder: `plan.md`, `shape.md`, `standards.md`, `references.md`).

2. **Define the popup ↔ background messaging contract.** Extend [`extension/src/messages.ts`](../../../extension/src/messages.ts):
   - Add `PopupStatus = 'no_credentials' | 'connecting' | 'joined' | 'disconnected'`.
   - Add `PopupSnapshot` carrying `status`, `clientId`, `cursor`, `mode`, `syncUrl` (password is **never** included).
   - Add `PopupToBackground = { kind: 'leave_room' }` (the snapshot push is via Port, not request/response).
   - Add `BackgroundToPopup = { kind: 'snapshot'; snapshot: PopupSnapshot }`.
   - JSDoc each export per the documentation policy declared in the WS-client spec.

3. **Wire the background broadcast surface.** New file [`extension/src/background/popupBroadcast.ts`](../../../extension/src/background/popupBroadcast.ts):
   - `registerPopupPort(port)` — adds the port to a `Set`, sends one initial snapshot, removes on `onDisconnect`.
   - `broadcastSnapshot(snapshot)` — sends to every connected port.
   - `getDerivedStatus(creds, hasActiveSocket, clientId)` — central helper mapping the runtime triple to a single `PopupStatus`.
   - `notifyPopupOnChange()` — small wrapper the call sites invoke; it grabs current state from the session/ws/storage and broadcasts.

4. **Hook the broadcast into existing lifecycle points.** Modify [`extension/src/background/ws.ts`](../../../extension/src/background/ws.ts):
   - On socket open / close / reconnect-pending: call `notifyPopupOnChange()`.
   - In the `ROOM_STATE` handler (after `applyRoomState`): call `notifyPopupOnChange()`.
   - In the `CURSOR_CHANGE` handler (after `applyCursorChange`): call `notifyPopupOnChange()`.
   - In `disconnect()`: call `notifyPopupOnChange()` after the socket close completes.
   - Do **not** broadcast from the `STATE` or `PLAYLIST_UPDATE` handlers.

5. **Background route handler for `leave_room` + popup port.** Modify [`extension/entrypoints/background.ts`](../../../extension/entrypoints/background.ts):
   - Add `chrome.runtime.onConnect` listener: when `port.name === 'pbsync-popup'`, call `registerPopupPort(port)` and attach a `port.onMessage` handler for the `leave_room` envelope. On `leave_room`: `disconnect(); await clearCreds(); notifyPopupOnChange()`.
   - The existing `chrome.runtime.onMessage` route for content scripts is unchanged.

6. **Build the popup UI.** Replace the placeholder in [`extension/entrypoints/popup/index.html`](../../../extension/entrypoints/popup/index.html) and [`extension/entrypoints/popup/main.ts`](../../../extension/entrypoints/popup/main.ts):
   - Single-page layout, ~320px wide, sections rendered conditionally on `status`:
     - **Header.** "PlaybackSync" + a small status pill (color-coded: grey/no-creds, amber/connecting, green/joined, red/disconnected).
     - **`no_credentials`.** Short copy: "Not in a room. Open a share link from a PlaybackSync room owner to join."
     - **`connecting`.** "Connecting to …" with the `syncUrl` host shown.
     - **`joined`.** Room block: cursor line, page URL link, mode chip, Leave Room button.
     - **`disconnected`.** "Connection lost. Reconnecting…" + Leave Room button.
   - On mount: `const port = chrome.runtime.connect({ name: 'pbsync-popup' })`; listen on `port.onMessage`, re-render on each snapshot.
   - Leave button handler: `port.postMessage({ kind: 'leave_room' })`; optimistic disabled "leaving…" state until the broadcast push arrives with `no_credentials`.

7. **Manifest sanity.** [`extension/wxt.config.ts`](../../../extension/wxt.config.ts) already declares `manifest.action.default_title = 'PlaybackSync'` — no change needed.

8. **Documentation pass.**
   - New file [`extension/docs/popup.md`](../../../extension/docs/popup.md): popup ↔ background messaging contract, port lifecycle, broadcast trigger points, the `PopupStatus` state machine, the credentials-are-share-URL-only design choice, the Leave Room semantics.
   - [`extension/docs/architecture.md`](../../../extension/docs/architecture.md): add the popup as a third layer (Port-based snapshot channel), update the "Popup UI" out-of-scope bullet.
   - [`extension/README.md`](../../../extension/README.md): add a popup smoke-test step under §"Smoke test against a real sync daemon".

9. **Update the punch list.** Move "Toolbar popup." in [`EXTENSION_TODO.md`](../../../EXTENSION_TODO.md) from "Next up" to "Already shipped" with a link to this spec.

## Critical files

**Created:**

- `extension/src/background/popupBroadcast.ts`
- `extension/docs/popup.md`
- `agent-os/specs/2026-05-24-2031-extension-toolbar-popup/{plan,shape,standards,references}.md`

**Modified:**

- `extension/src/messages.ts` — add `PopupSnapshot`, `PopupStatus`, `PopupToBackground`, `BackgroundToPopup`.
- `extension/src/background/ws.ts` — broadcast on lifecycle/ROOM_STATE/CURSOR_CHANGE/close.
- `extension/entrypoints/background.ts` — `onConnect` listener for `pbsync-popup` port; `leave_room` handler.
- `extension/entrypoints/popup/index.html` — real UI, framework-free.
- `extension/entrypoints/popup/main.ts` — Port lifecycle, render-on-snapshot logic.
- `extension/docs/architecture.md` — popup added to the diagram + push-channel paragraph; out-of-scope bullet removed.
- `extension/README.md` — popup smoke-test step.
- `EXTENSION_TODO.md` — move bullet to "Already shipped".

**Reused, not modified:**

- `extension/src/background/storage.ts` — `loadCreds()`, `clearCreds()` already do what's needed.
- `extension/src/background/session.ts` — `SessionState.clientId / cursor / mode` already populated by existing `applyRoomState` / `applyCursorChange`.
- `extension/src/background/ws.ts::disconnect()` — already does the socket teardown.

## Verification

1. `cd extension && npm run compile && npm run lint` — must be clean.

2. **No-creds smoke.** Fresh profile, no creds in storage. Click the toolbar icon. Popup shows header + grey "no room" pill + "Not in a room…" copy. No JS errors in popup DevTools.

3. **Share-URL join → joined state.** Open the share URL. Watch the popup transition `connecting` (amber) → `joined` (green); cursor line renders once `ROOM_STATE` lands.

4. **Cursor change pushes a fresh snapshot.** Open a miruro page in the synced tab; the popup re-renders with the new cursor line ("miruro · 166617-ep4") and a clickable `pageUrl`.

5. **Mode chip reflects room mode.** Test against `default`, `single`, `freeform` rooms.

6. **Leave Room.** Click → optimistic "leaving…" → snapshot arrives with `no_credentials` → no-creds view. `chrome.storage.local.get('pbsync')` returns `{}`. No reconnect attempts.

7. **Reconnect / disconnected state.** Stop the daemon; pill flips red, "Connection lost. Reconnecting…" copy renders. Leave Room still works. Restart daemon; pill flips green.

8. **No broadcast spam.** With the popup open and a video playing, verify popup DevTools console does not show a snapshot push per `STATE` tick — only on lifecycle/ROOM_STATE/CURSOR_CHANGE events.

9. **Port cleanup.** Close/reopen the popup five times during an active session. Background console: `popupBroadcast` port set should not grow.

10. **Password never surfaced.** Inspect snapshot envelopes in popup DevTools console; confirm no `syncPassword` field, only `syncUrl`.

## Out of scope

- **Manual credentials entry.** Confirmed in shaping: creds come from the share URL, never the popup.
- **Owner-driven controls** (`CURSOR_CHANGE_REQUEST`, `PLAYLIST_UPDATE` from the popup). Encoder ready; separate slice.
- **Playlist view.** `session.playlist` is populated but no UI in this slice.
- **Multi-room / multi-tab arbitration UI.**
- **i18n.** English-only in the popup; matches the rest of the extension.
- **Icons.** Tracked separately under "Cross-browser packaging polish".
- **Vitest setup / unit tests.** Same posture as previous extension slices.
