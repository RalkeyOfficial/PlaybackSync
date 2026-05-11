# Dashboard live playback controls — Shaping Notes

## Scope

Add live playback control buttons (Play/Pause toggle, Reset to 0, Seek to absolute position) to the room detail modal in the dashboard. Pressing a button sends the command to the WebSocket daemon via an HMAC-signed admin HTTP call, which mutates the room's authoritative playback state and broadcasts a `STATE` frame to all connected clients.

## Decisions

- **Controls in v1:** Play/Pause (single toggle), Reset (pause + seek 0), Seek (absolute position in seconds via numeric input + Go button). Episode change is out of scope for v1.
- **Authorization:** Reuse `RoomService::getOwnedRoom()` — rooms are already per-user, so visibility ≡ ownership. Same model as the existing kickClient flow.
- **Seek UX:** Numeric input (seconds) + Go button. The daemon does not track media duration, so an absolute slider is not feasible without extra plumbing.
- **Event log integration:** Admin commands flow through the same `RoomRuntime::applyPlay/Pause/Seek()` calls as client `EVENT` frames, so they bump `eventId` and are appended to the ring buffer. Reconnecting clients replay them via `ROOM_STATE.recentEvents` automatically.
- **Optimistic UI:** The store patches `room.live.playerState`/`videoPos` in-place immediately, snapshotting first for rollback on error, then triggers a refresh to reconcile with daemon truth.
- **"No live session" state:** If `RoomRegistry::find($uuid)` returns null, the daemon responds 404 → controller maps to 409 `room_not_live` → frontend shows a warning note card and disables the control row. (A runtime only exists once a client has JOINed.)
- **HMAC reuse vs duplication:** The HMAC signing block will be triplicated across `PresenceClient`, `AdminKickClient`, and the new `AdminPlaybackClient`. Per project guidance ("three similar lines is better than a premature abstraction"), we leave it inline. Extract only when a fourth admin client appears.

## Context

- **Visuals:** None — user opted for "pick a reasonable layout."
- **References:** Existing kickClient end-to-end flow (REST → service → AdminKickClient → daemon admin HTTP → RoomRuntime → broadcast), and the client `EVENT` handler (`lib/WebSocket/Handler/EventHandler.php`) which is the in-protocol analogue of what we're adding via admin.
- **Product alignment:** Aligns with Phase 1 of the roadmap (WebSocket sync server + room management). Owner-side control is a natural extension of the synchronized-playback mission.

## Standards Applied

- `backend/php-conventions` — strict types, `OCP\` imports, controller annotations (`@NoAdminRequired`, `@NoCSRFRequired`).
- `frontend/vue-conventions` — `<script setup lang="ts">`, `@nextcloud/vue` components, `t('playbacksync', …)` for every user-facing string, Pinia for state.
