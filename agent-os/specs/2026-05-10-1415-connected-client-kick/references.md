# References for Connected client management (kick)

## Similar Implementations

### Owner-only destructive endpoint

- **Location:** `lib/Controller/RoomController.php` `destroy()` + `lib/Service/RoomService.php` `deleteOwnedRoom()` and `getOwnedRoom()`
- **Relevance:** Same authorization shape as the new kick endpoint — the ownership check throws `RoomNotFoundException` for non-owners (no 403, to avoid leaking existence). The new `RoomService::kickClient()` and `RoomController::kickClient()` should mirror these line-for-line for the auth path.
- **Key patterns:** call `getOwnedRoom($userId, $uuid)` first; do the side effect after.

### Loopback admin bridge (PHP → daemon)

- **Location:** `lib/Service/PresenceClient.php`
- **Relevance:** The new `AdminKickClient` is a sibling — same HMAC scheme (`X-PBSync-Admin: t=<ms>,sig=<hex>`), same config keys (`ws_admin_host`, `ws_admin_port`, `ws_admin_secret`), same 200 ms timeout, same once-logged graceful-degradation behavior.
- **Key patterns:** signing string `"$method\n$requestTarget\n$ts"`; HMAC-SHA256 hex; one warn-log per failure mode (don't spam).

### Loopback admin server (daemon side)

- **Location:** `lib/WebSocket/Admin/PresenceController.php`, `lib/WebSocket/Admin/AdminAuthMiddleware.php`, `lib/WebSocket/Admin/PresenceHttpServer.php`
- **Relevance:** The new `KickController` mounts under the same `PresenceHttpServer` and reuses the same auth middleware. `PresenceHttpServer` is the registration point for additional admin routes.
- **Key patterns:** controller resolves a `RoomRuntime` via `RoomRegistry`, returns `Ratchet\Http\Response` with appropriate status. Auth middleware already covers all methods and request targets — no changes needed.

### Sending a terminal error frame then closing

- **Location:** `lib/WebSocket/MessageException.php` + `lib/WebSocket/MessageRouter.php` (~lines 100-110)
- **Relevance:** The "send error then close" pattern for `closeAfter: true` exceptions is the exact mechanism we need to deliver `{type: "ERROR", errorCode: "KICKED"}` and then sever the socket. The new `RoomRuntime::kickClient()` should reuse the same helper so kicks behave identically to other terminal errors.

### Per-connection lifecycle (idle close, tombstone)

- **Location:** `lib/WebSocket/RoomRuntime.php`, `lib/WebSocket/ClientConnection.php`, `lib/WebSocket/Tick.php`
- **Relevance:** Existing per-room maps and the `Tick` loop are the natural homes for the new kick block map (`array<clientId, blockedUntilMs>`) and its periodic pruning. The block map is **separate** from `tombstonedUntilMs` (which permits reconnect within a grace window, the opposite intent).

### Frontend chip render + per-room refresh

- **Location:** `src/components/RoomDetailDialog.vue` (chip block + the `getRoom(uuid)` re-fetch on dialog open)
- **Relevance:** This is where the per-chip disconnect button slots in. The same `getRoom(uuid)` flow is the post-kick refresh path.

### Frontend toast pattern

- **Location:** existing usages of `showError` / `showSuccess` from `@nextcloud/dialogs` in the rooms components
- **Relevance:** Surface kick success/failure with the same toast flow already used for delete.
