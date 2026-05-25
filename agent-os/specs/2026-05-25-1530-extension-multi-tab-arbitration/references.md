# References for Multi-Room / Multi-Tab Arbitration

## Foundation specs studied

These are the extension-side slices that shape the surface we are refactoring.

### Plugin foundation (Adapter contract, content runtime)

- **Location:** [`agent-os/specs/2026-05-24-0959-extension-plugin-foundation/`](../2026-05-24-0959-extension-plugin-foundation/)
- **Relevance:** Defines the `Adapter` contract and how the content runtime activates one. Per-tab adapter binding is the load-bearing assumption that makes "each tab is its own user" work — every tab independently resolves an adapter against its page.
- **Key patterns to keep:** the implicit-`tabId` model where the background derives the tab from `sender.tab?.id` rather than the content forwarding it. We keep this; we just stop pretending only one tab matters.

### WS client (protocol + suppression)

- **Location:** [`agent-os/specs/2026-05-24-1230-extension-ws-client/`](../2026-05-24-1230-extension-ws-client/)
- **Relevance:** Defines the JOIN/EVENT/HEARTBEAT/CLOCK_PING/BUFFER + STATE/CURSOR_CHANGE/PLAYLIST_UPDATE/SYNC_ADJUST flow, reconnect-with-replay, and the per-tab suppression / convergence gates. The session-state reshape in Task 3 collapses those per-tab maps to scalars, which is only safe because the per-tab data model from this slice was the **only** justification for the maps' existence.
- **Key patterns to keep:** `SUPPRESSION_WINDOW_MS`, `JOIN_SETTLE_WINDOW_MS`, the `markConverged` / `inSettleWindow` / `shouldSuppress` semantics. Only the shape changes (`Map<tabId, X>` → scalar).

### Share-URL credential pickup

- **Location:** [`agent-os/specs/2026-05-24-1423-extension-share-url-creds/`](../2026-05-24-1423-extension-share-url-creds/)
- **Relevance:** `credentials.content.ts` already runs `document_start` per-tab and forwards captured creds tagged with `sender.tab.id`. So the per-tab credentials storage change in Task 2 is *just* a write-target change — the capture side is already shaped right.
- **Key patterns to keep:** content-script-injected URL sniff at `document_start`. Only `handleCredentials` in `entrypoints/background.ts` needs to drop the first-write-wins guard and write to the per-tab slot instead.

### Toolbar popup (Port-based snapshot channel)

- **Location:** [`agent-os/specs/2026-05-24-2031-extension-toolbar-popup/`](../2026-05-24-2031-extension-toolbar-popup/)
- **Relevance:** Establishes the `'pbsync-popup'` Port channel, the `PopupSnapshot` shape, and the derived `PopupStatus` enum. Task 7 extends rather than replaces this: same port name, same envelope shape (plus `tabId`), but the background keeps a `port → tabId` map and broadcasts only to ports interested in the mutating tab.
- **Key patterns to keep:** vanilla TS framework-free popup, manual creds entry deliberately omitted, snapshot envelope as the only outbound shape.

## Backend reference points (no change in this spec)

- [`lib/WebSocket/Handler/JoinHandler.php`](../../../lib/WebSocket/Handler/JoinHandler.php) — confirms the daemon will treat N tabs in the same room as N distinct clients (line 252 mints a fresh `clientId` per JOIN when none provided).
- [`lib/WebSocket/RoomRuntime.php`](../../../lib/WebSocket/RoomRuntime.php) — confirms `clientId` is scoped per-room, so the "two tabs in the same room with the same clientId" failure mode the daemon prevents (`CLIENT_ID_IN_USE` at JoinHandler.php:247-248) does *not* affect the per-tab model since each tab mints its own clientId.
- [`lib/WebSocket/Admin/PresenceController.php`](../../../lib/WebSocket/Admin/PresenceController.php) — confirms the admin "Connected clients" UI shows one row per `(room, clientId)`, which is the surface we want — each tab shows up as its own client row, exactly as intended.
