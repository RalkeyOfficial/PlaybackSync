# Plan — Connected client management (kick)

## Context

PlaybackSync currently lets a room owner see who is connected (presence chips on `RoomDetailDialog`, count badge on `RoomCard`) but offers no way to remove a participant. `MISSING_FEATURES.md` flags `DELETE /rooms/{roomId}/clients/{clientId}` as the highest-value parity gap from the OLD design (`OLD_CODE/docs/backend_design_v1.md` §11).

This spec adds the kick endpoint end-to-end:

- Owner-only `DELETE /api/v1/rooms/{uuid}/clients/{clientId}` REST endpoint.
- Daemon admin endpoint that disconnects the target socket, sets a short reconnect block, and sends a final `KICKED` error frame.
- Per-chip kick affordance in `RoomDetailDialog.vue` with an NcDialog confirmation.

Outcome: a room owner can forcibly disconnect a misbehaving participant; the kicked client is briefly prevented from re-joining with the same `clientId`; remaining peers see the presence change on the next refresh.

## Design decisions (confirmed with user)

- **Reconnect block**: short tombstone-style window (new config `ws_kick_block_ms`, default 30000) keyed on `(roomUuid, clientId)`. In-memory only; cleared on daemon restart and on natural expiry.
- **UI**: per-chip kick button in `RoomDetailDialog.vue` (no new list component).
- **Confirmation**: `NcDialog`-based confirm — first richer-confirm in the project, deliberately used here because kick is irreversible.
- **Notice**: daemon sends a final error frame (`errorCode: "KICKED"`) then closes the socket, reusing the existing `MessageException` + `closeAfter` flow.

## Critical files

### Backend (PHP)
- `appinfo/routes.php` — add `room#kickClient` route.
- `lib/Controller/RoomController.php` — add `kickClient($uuid, $clientId)` method (mirrors `destroy` for shape; uses `RoomService::kickClient()`).
- `lib/Service/RoomService.php` — add `kickClient(string $userId, string $uuid, string $clientId): void`. Reuses `getOwnedRoom()` for ownership check, then delegates to a new admin client.
- `lib/Service/AdminKickClient.php` — **new**. Sibling of `PresenceClient.php`; HMAC-signed `POST` to daemon `/admin/rooms/{uuid}/clients/{clientId}/disconnect`. Same config keys (`ws_admin_host`, `ws_admin_port`, `ws_admin_secret`), same 200 ms timeout, same once-logged failure semantics. Throws a typed exception on hard failure so the controller can return 502/503.
- `lib/Exceptions/` — add `KickFailedException` (or reuse `RoomNotFoundException` semantics for "client not found in room"; daemon distinguishes via 404 vs 503).

### Daemon (PHP, WS process)
- `lib/WebSocket/Admin/PresenceHttpServer.php` — register the new `POST /admin/rooms/{uuid}/clients/{clientId}/disconnect` route (it already mounts `Ratchet\Http\HttpServer` and the auth middleware).
- `lib/WebSocket/Admin/KickController.php` — **new**. Resolves the target via `RoomRegistry` → `RoomRuntime`, calls a new `RoomRuntime::kickClient(string $clientId, int $blockMs): KickResult` and returns 200/404/503.
- `lib/WebSocket/Admin/AdminAuthMiddleware.php` — already handles arbitrary methods; verify the HMAC string-to-sign covers method + request target (it does — `"$method\n$requestTarget\n$ts"`).
- `lib/WebSocket/RoomRuntime.php` — add `kickClient(string $clientId, int $blockMs)`:
  1. Look up `ClientConnection`; return "not found" if absent.
  2. Send error frame via existing helper (mirror what `MessageRouter` does for `MessageException` with `closeAfter: true`) with `{type: "ERROR", errorCode: "KICKED"}`.
  3. Close the socket.
  4. Record block in a new `array<string clientId, int blockedUntilMs>` per room.
  5. Remove the client entry / let normal cleanup paths run.
- `lib/WebSocket/Handler/JoinHandler.php` — before assigning `clientId`, check the per-room block map. If `blockedUntilMs > now`, reject with `errorCode: "KICKED"` + `closeAfter: true`. Block map is checked when a `clientId` is supplied; if a client retries with a fresh `clientId` they're allowed (this is acceptable per design — the block is anti-flap, not a ban).
- `lib/WebSocket/WsConfig.php` — add `kickBlockMs` (default 30000, key `ws_kick_block_ms`).
- `lib/WebSocket/Tick.php` — opportunistically prune expired entries from the kick block map (cheap O(blocks)). Not strictly required (lazy expiry on read works) but keeps memory bounded.

### Frontend (Vue + TS)
- `src/components/RoomDetailDialog.vue` — at the chip render block, add a small disconnect icon button per chip (visible only on hover or always, owner-only — owner-only is implicit since the dashboard only shows owned rooms). On click, open a confirm `NcDialog`; on confirm, call new `kickClient()` API and re-fetch the room detail (`getRoom(uuid)` already used).
- `src/services/roomsApi.ts` — add `kickClient(uuid: string, clientId: string): Promise<void>`. `axios.delete` to generated URL.
- `src/stores/rooms.ts` — add a `kickClient(uuid, clientId)` action that calls the API and refreshes via `load()` (or just re-`getRoom` on the open dialog). Surface error via `showError` toast from `@nextcloud/dialogs`.
- `src/components/RoomDetailDialog.vue` — import `IconAccountRemove` (or `IconClose`) and `NcDialog` for confirm.
- `l10n/en.js` and `l10n/nl.js` — add keys (en → nl):
  - `"Disconnect this client"` → `"Verbinding met deze cliënt verbreken"`
  - `"Disconnect client {clientId}?"` → `"Cliënt {clientId} loskoppelen?"`
  - `"They will be disconnected immediately and blocked from rejoining for 30 seconds."` → `"Ze worden direct losgekoppeld en kunnen 30 seconden lang niet opnieuw deelnemen."`
  - `"Disconnect"` → `"Loskoppelen"`
  - `"Client disconnected"` → `"Cliënt losgekoppeld"`
  - `"Could not disconnect client"` → `"Kon cliënt niet loskoppelen"`

### Docs
- `docs/api.md` — document the new endpoint (request/response, status codes 204/403/404/502).
- `docs/ws-sync-server.md` — add the admin `POST /admin/rooms/{uuid}/clients/{clientId}/disconnect` route and the `KICKED` error code to the protocol section.
- `docs/architecture.md` — short note on kick block window.

### Tests
- `tests/unit/Service/RoomServiceTest.php` — non-owner is rejected, missing room is 404 (existing `RoomNotFoundException` pattern), kick delegates to admin client.
- `tests/unit/WebSocket/Admin/KickControllerTest.php` — auth required, room-not-found → 404, success → 200, malformed clientId → 400.
- `tests/unit/WebSocket/RoomRuntimeTest.php` — kicking marks block, block expires after `ws_kick_block_ms`, second client with same id rejected during window.

## Reused patterns (do not reinvent)

- **Ownership check**: `RoomService::getOwnedRoom()` — call before kick, throw `RoomNotFoundException` for non-owners (parity with `deleteOwnedRoom`).
- **Admin HMAC client**: mirror `lib/Service/PresenceClient.php` shape exactly (timeout, header format, once-logged warn on failure).
- **Admin HMAC server**: existing `lib/WebSocket/Admin/AdminAuthMiddleware.php` already verifies `method + requestTarget + ts` — reusable as-is for non-GET routes.
- **closeAfter error frame**: `lib/WebSocket/MessageException.php` + `MessageRouter` already implement "send error then close". Use the same helper from `RoomRuntime::kickClient()`.
- **Tombstone**: `ClientConnection::tombstone()` and `tombstonedUntilMs` exist for the reconnect-grace case — the kick block is conceptually similar but **not the same field** (tombstone is a *grace window allowing the same id to rejoin*; kick block is a *prohibition*). Keep them separate to avoid conflating intent.
- **Frontend confirm/refresh pattern**: `RoomDetailDialog.vue` already calls `getRoom(uuid)` on dialog open — reuse for post-kick refresh.
- **Frontend toast**: `showError` / `showSuccess` from `@nextcloud/dialogs` already used elsewhere.

## Tasks

### Task 1 — Save spec documentation (this task)

Create `agent-os/specs/2026-05-10-1415-connected-client-kick/` with `plan.md`, `shape.md`, `standards.md`, `references.md`, `visuals/`.

### Task 2 — Daemon: kick block + admin route

1. Add `kickBlockMs` getter to `WsConfig` (key `ws_kick_block_ms`, default 30000).
2. Add per-room kick block map to `RoomRuntime` (`array<clientId, blockedUntilMs>`).
3. Add `RoomRuntime::kickClient($clientId, $blockMs): KickResult` returning `NotFound | Kicked`.
4. Add `JoinHandler` check against the block map; reject with `errorCode: "KICKED"` + `closeAfter: true` when blocked.
5. Add `KickController` and register `POST /admin/rooms/{uuid}/clients/{clientId}/disconnect` in `PresenceHttpServer`.
6. Optional: prune expired entries in `Tick`.

### Task 3 — PHP service + REST endpoint

1. Add `AdminKickClient` service mirroring `PresenceClient` (HMAC, 200 ms timeout, typed errors).
2. Add `RoomService::kickClient($userId, $uuid, $clientId)` using `getOwnedRoom()` + `AdminKickClient`.
3. Add `RoomController::kickClient($uuid, $clientId)` returning `204` on success, `404` on missing client, `502` if daemon unreachable.
4. Register `room#kickClient` route in `appinfo/routes.php`: `DELETE /api/v1/rooms/{uuid}/clients/{clientId}`.

### Task 4 — Frontend kick affordance

1. Add `kickClient(uuid, clientId)` to `src/services/roomsApi.ts`.
2. Add store action in `src/stores/rooms.ts`.
3. In `RoomDetailDialog.vue`, render a small "disconnect" button on each chip, wire it to an `NcDialog` confirm, then call the action and re-fetch the open room. Show `showSuccess` / `showError` toasts.
4. Add l10n keys (en + nl) listed above.

### Task 5 — Tests + docs

1. Add unit tests listed under "Tests" above.
2. Update `docs/api.md`, `docs/ws-sync-server.md`, `docs/architecture.md`.

### Task 6 — Sweep `MISSING_FEATURES.md`

Mark the kick item as resolved.

## Verification

End-to-end manual test:
1. Run `occ playbacksync:ws-serve` (daemon).
2. Open the dashboard in two browsers, connect both as the same room with different `clientId`s.
3. Open `RoomDetailDialog` for the room — confirm both chips render.
4. Click the disconnect icon on one chip → confirm NcDialog → confirm.
5. Expect: kicked client's WS receives `{type:"ERROR", errorCode:"KICKED"}` then closes; chip disappears within one refresh; reconnect with same `clientId` within 30s gets `KICKED` again; after expiry, rejoin works.
6. Negative: a non-owner calling `DELETE /api/v1/rooms/{uuid}/clients/{clientId}` gets a 404, not a 403.
7. Negative: stop the daemon, click kick → frontend shows "Could not disconnect client" toast and the dialog stays open.

Automated:
- `composer test` (PHPUnit) for backend unit tests.
- `npm run lint` and `npm run test` for the Vue changes.

## Out of scope

- Persistent block list across daemon restarts.
- Kicking by Nextcloud `userId`.
- Bulk kick / "kick all".
- Surfacing kick events in the in-memory event-log ring buffer.
- Browser extension toast on `KICKED` (separate change in extension repo).
