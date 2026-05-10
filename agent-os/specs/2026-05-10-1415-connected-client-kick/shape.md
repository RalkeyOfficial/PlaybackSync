# Connected client management (kick) — Shaping Notes

## Scope

Add a way for a room owner to forcibly disconnect a single connected WebSocket client by `clientId`. End-to-end: REST endpoint → loopback admin HTTP → daemon disconnect + short reconnect block → UI affordance per chip in the existing `RoomDetailDialog`.

The kicked client is not persistently banned — they can rejoin with a fresh `clientId`, and the same `clientId` can rejoin after `ws_kick_block_ms` (default 30s) elapses. The block exists to prevent immediate re-flap, not to be a security boundary.

## Decisions

- **REST surface**: `DELETE /api/v1/rooms/{uuid}/clients/{clientId}`. Owner-only. Mirrors existing `DELETE /api/v1/rooms/{uuid}` ownership pattern (`RoomService::getOwnedRoom`) — non-owners get `RoomNotFoundException` (404), not 403, to avoid leaking room existence.
- **Daemon admin route**: `POST /admin/rooms/{uuid}/clients/{clientId}/disconnect`. New handler `KickController` registered in the existing `PresenceHttpServer`, behind the existing `AdminAuthMiddleware` (HMAC-SHA256 over `method\nrequestTarget\nts`).
- **Reconnect block**: in-memory per-room `array<clientId, blockedUntilMs>`. Kept separate from the existing `tombstonedUntilMs` (which is a *grace window allowing reconnect*, the opposite intent).
- **Notice to kicked client**: send a final `{type: "ERROR", errorCode: "KICKED"}` frame, then close. Reuses the `MessageException` + `closeAfter` flow from `MessageRouter`.
- **UI**: per-chip disconnect icon in `RoomDetailDialog.vue`. `NcDialog` confirmation (more deliberate than the native `window.confirm` used for room delete; chosen because kick is irreversible).
- **Ownership inference**: the dashboard only ever shows owned rooms, so the kick affordance is visible everywhere a room chip is — no extra owner check needed in the UI.

## Context

- **Visuals:** None.
- **References studied:**
  - `RoomController::destroy` and `RoomService::deleteOwnedRoom` for the ownership pattern.
  - `PresenceClient` and `RoomLiveStateEnricher` for the loopback-bridge pattern.
  - `PresenceController` + `AdminAuthMiddleware` + `PresenceHttpServer` for the daemon-side admin pattern.
  - `RoomDetailDialog.vue` chip render (`live.clients` mapped to colored chips) for the UI surface.
  - `RoomRuntime` + `ClientConnection` for the per-room connection map and tombstone semantics.
- **Product alignment:** Roadmap is silent on kick. `MISSING_FEATURES.md` lists kick as the highest-value parity item from the OLD `backend_design_v1.md` §11. Implementing it closes the most-cited gap without expanding scope.

## Standards Applied

- `backend/php-conventions` — strict types, OCP-only imports, controller annotations on the new endpoint.
- `frontend/vue-conventions` — `<script setup lang="ts">`, `@nextcloud/vue` imports (`NcDialog`, `NcButton`), `t('playbacksync', …)` for all UI strings, both `l10n/en.js` and `l10n/nl.js` updated.
