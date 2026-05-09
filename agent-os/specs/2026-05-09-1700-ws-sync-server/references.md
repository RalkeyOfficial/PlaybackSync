# References for WebSocket Sync Server

The protocol in this spec is a clean redesign, but every concept was informed by the previous standalone Node.js implementation. Each reference below points to a specific OLD_CODE file and notes what it contributed to this design — so a future implementer or reviewer can compare the PHP port against the proven Node behaviour.

## Protocol design

### `OLD_CODE/server/src/types/messages.ts`
TypeScript interfaces for every message type, both client→server and server→client. Used to derive the v1 message catalog. We adopt JOIN, EVENT, EPISODE_CHANGE_REQUEST, HEARTBEAT, CLOCK_PING, BUFFER_START/END (client→server) and ROOM_STATE, STATE, EPISODE_CHANGE, SYNC_ADJUST, CLOCK_PONG, ERROR, CONTENT_MISMATCH (server→client). We drop COMMAND, SERVER_SHUTDOWN, TIME_REPORT (defined but never used).

### `OLD_CODE/server/docs/WEBSOCKET_TYPES.md`
Long-form spec for every message — fields, examples, edge cases. The single most useful reference when writing the PHP message validators and `docs/ws-protocol.md`.

### `OLD_CODE/docs/unified_v1_backend_and_network_design.md`
High-level protocol design rationale: why server time is authoritative, why drift uses HEARTBEAT instead of TIME_REPORT, why content identity is needed. Read first when something seems arbitrary.

### `OLD_CODE/docs/backend_network_design_v1.md`
Event flow and priority table. Useful when deciding what blocks what (e.g. drift correction is suppressed during cooldown windows after explicit events).

## State model and runtime

### `OLD_CODE/server/src/types/room.ts`
Defines `Room`, `PlaybackState`, `ClientConnection`, `ContentIdentity`. Direct precedent for the PHP `RoomRuntime`, `PlaybackState`, `ClientConnection`, `ContentIdentity` value objects.

### `OLD_CODE/server/src/storage/rooms.ts`
In-memory room map, lazy creation, cleanup. The PHP `RoomRegistry` mirrors this except it reads room identity from `oc_playbacksync_rooms` instead of an in-process Map (we only keep playback state in memory; identity lives in the DB).

### `OLD_CODE/server/src/utils/connection-helpers.ts`
Constants (event-log ring buffer size = 100), clientId generation. We bump the ring buffer to 200 because typical viewing sessions in a Nextcloud context may be longer.

## Handlers (1-for-1 PHP equivalents)

### `OLD_CODE/server/src/handlers/websocket.ts`
Connection lifecycle: open, message dispatch, close, error. Maps to the PHP `MessageRouter` (`MessageComponentInterface`).

### `OLD_CODE/server/src/handlers/join.ts`
Auth, tombstone reattach, content-identity reconciliation, ROOM_STATE construction with event replay. The most complex handler — the PHP `JoinHandler` follows the same control flow.

### `OLD_CODE/server/src/handlers/event.ts`
Rate-limit check, broadcast STATE, increment eventId, append to event log. Maps to `EventHandler`.

### `OLD_CODE/server/src/handlers/episode-change.ts`
Hard reset semantics: paused, videoPos=0, new ContentIdentity. Maps to `EpisodeChangeHandler`.

### `OLD_CODE/server/src/handlers/heartbeat.ts`
Drift math + SYNC_ADJUST emission. Maps to `HeartbeatHandler`.

### `OLD_CODE/server/src/handlers/clock-sync.ts`
Four-timestamp NTP-style PING/PONG. Maps to `ClockHandler`.

### `OLD_CODE/server/src/handlers/buffer.ts`
Sets `isBuffering` to suppress drift correction. On BUFFER_END, re-sends ROOM_STATE for that one client to resync. Maps to `BufferHandler`.

## Drift / time math

### `OLD_CODE/server/src/utils/drift-reconciliation.ts`
`calculateExpectedTime()` and `getCurrentVideoPos()`. The exact formula adopted by `PlaybackState::expectedTime(int $nowMs): float` in PHP:

```
if (paused) videoPos
else        videoPos + (now - lastStateUpdateTs) / 1000
```

### `OLD_CODE/server/src/config.ts`
Drift thresholds (nudge=200ms, seek=500ms, cooldown=3000ms, tombstone=30s). Adopted as defaults in our `IAppConfig` keys.

## Patterns we did NOT port

- `OLD_CODE/server/src/routes/` — Fastify HTTP routes (rooms CRUD, dashboard, healthz, metrics). The Nextcloud port reuses the existing PHP `RoomController`, and the dashboard/metrics endpoints are out of scope for v1.
- `OLD_CODE/server/src/utils/rate-limiter.ts` — token bucket implementation. Reimplemented in PHP rather than ported because the API surface needed is small.
- JSON Schema validation (`OLD_CODE/server/src/schemas/`) — replaced with hand-rolled validators per type. The message set is small enough that a runtime schema library adds more weight than value.

## Patterns from the existing PlaybackSync app

### `lib/Service/RoomService.php` (current code)
- Password generation, hashing, and validation patterns. The WS layer adds a `verifyPassword(Room $room, string $plain): bool` helper here (a thin `IHasher::verify()` wrapper) so the WS handlers don't reach for `IHasher` directly.

### `lib/Db/RoomMapper.php` (current code)
- `findByUuid()` is the single DB call the daemon needs. No new mapper methods required.

### `lib/BackgroundJob/PruneExpiredRoomsJob.php` (current code)
- Hourly job that deletes expired rooms. The WS daemon doesn't need to participate — it just force-closes any in-memory room whose `expiresAt` has passed (checked in `Tick`).

### `agent-os/specs/2026-05-09-1430-room-creation-management/`
- Format and layout precedent for this spec folder.
