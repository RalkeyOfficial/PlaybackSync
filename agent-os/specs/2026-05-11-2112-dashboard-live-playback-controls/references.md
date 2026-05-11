# References for Dashboard Live Playback Controls

## Similar Implementations

### kickClient end-to-end flow (closest production analogue)

- **REST route:** `appinfo/routes.php` — `room#kickClient`, `DELETE /api/v1/rooms/{uuid}/clients/{clientId}`
- **Controller:** `lib/Controller/RoomController.php` `kickClient()` (~L128–142) — `@NoAdminRequired`, `@NoCSRFRequired`, calls service, maps exceptions to HTTP status
- **Service:** `lib/Service/RoomService.php` `kickClient()` (~L147–150) — ownership check via `getOwnedRoom()`, delegates to `AdminKickClient`
- **Admin HTTP client:** `lib/Service/AdminKickClient.php` `kick()` (~L46–94) — HMAC-SHA256 signed POST to daemon at `127.0.0.1:8766/admin/rooms/{uuid}/clients/{clientId}/disconnect`
- **Daemon HTTP route table:** `lib/WebSocket/Admin/PresenceHttpServer.php` (L20–24)
- **Daemon handler:** `lib/WebSocket/Admin/KickController.php` — calls `RoomRegistry::find()` then mutates via `RoomRuntime::kickClient()`

**Key patterns to borrow:**
- HMAC canonical: `"{METHOD}\n{path}\n{nowMs}"`, header `"t={nowMs},sig={hex}"`
- Result-enum return (`RESULT_KICKED`, `RESULT_ROOM_NOT_FOUND`, `RESULT_CLIENT_NOT_FOUND`) mapped to HTTP status
- Exception types per failure mode (`KickFailedException`, `ClientNotFoundException`)
- 0.2s timeout on the loopback admin HTTP call

### Client EVENT handler (in-protocol playback control)

- **File:** `lib/WebSocket/Handler/EventHandler.php` (~L73–79)
- **Relevance:** Today only WebSocket-connected clients can drive playback. They send an `EVENT` frame, the handler calls `RoomRuntime::applyPlay/Pause/Seek()`, then broadcasts a `STATE` frame to all active connections (except sender). The new admin endpoint will hit the same `RoomRuntime` methods but broadcast to **all** connections (no sender to exclude).
- **Key code path to mirror:**
  ```php
  $frame = $this->encoder->state($runtime->state, $nowMs);
  foreach ($runtime->activeConnectionsExcept($ctx->clientId) as $peer) {
      $peer->send($frame);
  }
  ```
  Admin equivalent passes `null` to `activeConnectionsExcept()` — broadcast to everyone.

### RoomRuntime state machine

- **File:** `lib/WebSocket/RoomRuntime.php`
- **Reuse:** `applyPlay($nowMs)`, `applyPause($nowMs)`, `applySeek(float $videoPos, $nowMs)` — server-authoritative state mutation that bumps `eventId` and appends to the event log ring buffer (200 events, used for reconnect replay).
- **Reuse:** `activeConnectionsExcept(?string $clientId)` — broadcast helper. Pass `null` to include all clients.

### MessageEncoder

- **File:** `lib/WebSocket/MessageEncoder.php`
- **Reuse:** `state(PlaybackState $state, int $nowMs)` — produces the canonical `STATE` outbound frame consumed by all clients.

## Frontend references

### RoomDetailDialog — where the controls go

- **File:** `src/components/RoomDetailDialog.vue` (~L116–122)
- **Anchor:** The existing playback status row that shows the play/pause/buffer icon and `videoPos`. Insert the new control row directly below.

### Pinia rooms store — pattern for the new action

- **File:** `src/stores/rooms.ts`
- **Reference action:** `kickClient(uuid, clientId)` — already wraps an API call with error handling. Mirror it, adding optimistic mutation of `room.live` and snapshot-on-error rollback.
