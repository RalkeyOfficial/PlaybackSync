# PlaybackSync — WebSocket Sync Server (v1, server-only)

## Context

The rooms feature shipped with CRUD + TTL only (`lib/Controller/RoomController.php`, `lib/Service/RoomService.php`, `lib/Db/Room*.php`). A room currently has no concept of *connected clients* or *playback state* — there is nothing yet that synchronises play/pause/seek between viewers.

This spec adds the **WebSocket sync server**: a long-running PHP daemon, launched via an `occ` command and built on Ratchet, that accepts WS connections to existing rooms, authenticates them with the room password, and broadcasts playback events (play/pause/seek), drift corrections, and content-change resets to all members of the same room.

**Scope is server-only.** No frontend client, no browser-extension integration — those land in later specs. The deliverable here is the daemon + protocol + an `occ` command + a small reverse-proxy doc, verifiable end-to-end with `wscat`/`websocat`.

The protocol is a clean redesign informed by `OLD_CODE/server/`: same problems (tombstones, drift reconciliation, content-identity, late-join extrapolation) were already solved there. We keep the *concepts*, drop the unused messages (`COMMAND`, `SERVER_SHUTDOWN`, `TIME_REPORT`), and rewrite in idiomatic PHP.

---

## Decisions

- **Runtime:** PHP long-running daemon via `occ playbacksync:ws-serve`. Yes, this *is* a long-running PHP process — the standard exception to "PHP has no long-running process". It needs systemd/supervisord to stay alive, will accumulate memory over weeks (recommend a weekly restart), and on restart all rooms lose connections (clients reconnect; see *State model*).
- **WebSocket library:** [`cboden/ratchet`](https://github.com/ratchetphp/Ratchet) v0.4 — the mature ReactPHP-based PHP WS lib.
- **Endpoint URL:** `ws[s]://<host>/index.php/apps/playbacksync/ws/{uuid}`. Daemon binds a local TCP port (default `127.0.0.1:8765`, configurable via `IAppConfig`). Admin's existing Apache/nginx reverse proxy forwards just `/apps/playbacksync/ws/` to that port — example snippets ship in docs.
- **Auth:** Room password sent in the `JOIN` message (verified against the existing `password_hash` via `IHasher::verify()`). No new auth flow, no tokens. Connections that don't `JOIN` within 5s are closed.
- **State model: in-memory only on the daemon.** No new DB columns, no per-event writes, no snapshots. Late-join correctness comes from extrapolated time + event-log replay (see *Late-join* below). Daemon restart = clients reconnect fresh; acceptable given (a) restarts are infrequent, (b) the UX is identical to a transient network blip.
- **Protocol:** redesigned, but adopts the OLD_CODE concepts marked KEEP in the exploration phase. Drops `COMMAND`, `SERVER_SHUTDOWN`, `TIME_REPORT` (defined in OLD_CODE but never used). All four message groups in v1: core / drift+clock / episode-change / buffer.
- **No client-facing presence:** members are tracked server-side only; no `MEMBER_JOINED`/`LEFT` broadcasts. Matches OLD_CODE intent.
- **Process model:** ship the `occ` command and a sample systemd unit + Apache/nginx proxy snippets. No separate Docker container; the daemon runs in the same environment as Nextcloud (in `nextcloud-docker-dev` it runs inside the existing PHP container).

---

## Architecture overview

```
   Browser (future client)
        │  wss://host/index.php/apps/playbacksync/ws/{uuid}
        ▼
   ┌──────────────────────────────────────┐
   │ Apache / nginx (existing NC frontend)│
   │  Location /apps/playbacksync/ws/ ─┐  │
   └───────────────────────────────────┼──┘
                                       ▼
                       ┌─────────────────────────────────┐
                       │  occ playbacksync:ws-serve      │
                       │  Ratchet IoServer @ 127.0.0.1:8765
                       │                                 │
                       │  RoomRegistry (in-memory)       │
                       │   ├─ Map<uuid, RoomRuntime>     │
                       │   │   ├─ playback state         │
                       │   │   ├─ event log (ring 200)   │
                       │   │   └─ Map<clientId, Conn>    │
                       │   └─ tombstones                 │
                       │                                 │
                       │  uses: RoomMapper, IHasher,     │
                       │        IAppConfig, LoggerInterface
                       └─────────────────────────────────┘
                                       │ reads only (room+passwordHash lookup)
                                       ▼
                       ┌─────────────────────────────────┐
                       │  oc_playbacksync_rooms (existing)│
                       └─────────────────────────────────┘
```

The daemon **reads** room rows on `JOIN` to verify password and check expiry. It never writes to the DB. The existing hourly `PruneExpiredRoomsJob` keeps cleaning up expired rooms; the daemon also force-closes any in-memory room whose `expiresAt` has passed.

---

## Critical files

### To create

**Backend (PHP):**
- `lib/Command/WsServe.php` — `extends OCP\AppFramework\Console\Command`. Wires up `IoServer::factory()` with a `WampMessageRouter` and the host/port from `IAppConfig`. Blocks on `$server->run()`.
- `lib/WebSocket/MessageRouter.php` — implements `Ratchet\MessageComponentInterface`. Single fan-in for all connections; dispatches to handlers by `type`.
- `lib/WebSocket/RoomRegistry.php` — in-memory map `uuid => RoomRuntime`. Lazy-creates a `RoomRuntime` on first `JOIN` for a given room (after DB lookup).
- `lib/WebSocket/RoomRuntime.php` — per-room state: `PlaybackState`, `Map<clientId, ClientConnection>`, ring-buffer event log (200 entries), `ContentIdentity?`, expiry check. Pure value object — no I/O.
- `lib/WebSocket/PlaybackState.php` — `playerState`, `videoPos`, `lastExplicitEventTs`, `lastStateUpdateTs`, `eventId`. Provides `expectedTime(now)` for late-join extrapolation (`videoPos + (now-lastStateUpdateTs)/1000` when playing).
- `lib/WebSocket/ClientConnection.php` — `clientId`, `Ratchet\ConnectionInterface $conn`, `lastSeen`, `tombstonedUntil?`, `lastEventId`, `clockOffsetMs?`, `rtt?`, `isBuffering`.
- `lib/WebSocket/ContentIdentity.php` — `episodeId`, `providerId`, `pageUrl`, derived `contentKey` (sha256 of `providerId:normalizedUrl:episodeId`).
- `lib/WebSocket/Handler/JoinHandler.php` — auth (verify password via `IHasher`), tombstone reattach, content-identity reconciliation, sends `ROOM_STATE` with replay tail.
- `lib/WebSocket/Handler/EventHandler.php` — play/pause/seek; rate-limit per connection; broadcasts `STATE` with new `eventId`.
- `lib/WebSocket/Handler/EpisodeChangeHandler.php` — broadcasts `EPISODE_CHANGE`; resets `PlaybackState` (paused, pos=0); updates `ContentIdentity`.
- `lib/WebSocket/Handler/HeartbeatHandler.php` — updates `lastSeen`; if drift > threshold, sends `SYNC_ADJUST` per-client.
- `lib/WebSocket/Handler/ClockHandler.php` — `CLOCK_PING` → `CLOCK_PONG` with 4 timestamps.
- `lib/WebSocket/Handler/BufferHandler.php` — sets/clears `isBuffering`; on `BUFFER_END` sends fresh `ROOM_STATE` to that client only.
- `lib/WebSocket/RateLimiter.php` — token bucket, 10 events/sec/conn.
- `lib/WebSocket/MessageValidator.php` — schema-validates incoming JSON (no JSON-Schema runtime needed; hand-rolled validators per type are simpler and the message set is tiny).
- `lib/WebSocket/MessageEncoder.php` — JSON encode/decode + envelope helpers (`error()`, `state()`, `roomState()`, etc.).
- `lib/WebSocket/Tick.php` — periodic `React\EventLoop\TimerInterface` on the loop: every 1s scans for expired tombstones, force-closes rooms past `expiresAt`, drops idle (no heartbeat in 30s) connections.

**Docs:**
- `docs/ws-sync-server.md` — operator guide: how to start the daemon, sample systemd unit, Apache/nginx proxy snippets, configuration keys, troubleshooting.
- `docs/ws-protocol.md` — full message reference (every type, every field, examples). This is what a future client implementer reads.

**Tests (`tests/Unit/WebSocket/`):**
- `PlaybackStateTest.php` — `expectedTime` math for paused/playing.
- `RoomRuntimeTest.php` — event-log ring buffer, tombstone lifecycle, member add/remove.
- `JoinHandlerTest.php` — password OK / wrong / room-not-found / room-expired / content-mismatch / tombstone reattach with replay.
- `EventHandlerTest.php` — broadcast fan-out, rate-limit kick-in, eventId monotonicity.
- `EpisodeChangeHandlerTest.php` — state reset semantics.
- `HeartbeatHandlerTest.php` — drift below/at/above thresholds → no-op / nudge / seek.
- `ClockHandlerTest.php` — 4-timestamp pong shape.
- `MessageValidatorTest.php` — accepts valid, rejects malformed, returns useful error codes.

### To modify

- `composer.json` — add `cboden/ratchet: ^0.4`.
- `lib/AppInfo/Application.php` — register `WsServe` command via `IBootContext`'s app container (commands are auto-discovered when placed under `lib/Command/` for Nextcloud apps; verify and add an explicit registration if not).
- `appinfo/info.xml` — add `<commands>` block listing `OCA\PlaybackSync\Command\WsServe` if needed; bump version.
- `lib/Service/RoomService.php` — expose a `verifyPassword(Room $room, string $plain): bool` helper (thin wrapper around `IHasher::verify()`) so the WS layer doesn't reimplement password verification.
- `docs/` index / README — link to the two new docs.

### Not modified

- DB schema: untouched. No new columns. No new migration.
- `oc_playbacksync_rooms`: read-only from the WS daemon's perspective.
- Frontend: untouched. Vue dashboard does not connect to WS in this spec.

---

## Protocol (v1)

All messages are JSON envelopes `{ "type": "...", ... }`. URL: `ws[s]://host/index.php/apps/playbacksync/ws/{uuid}`. The `{uuid}` is read from the URL by the daemon; clients still send `JOIN` after connecting.

### Client → server

| Type | Required fields | Notes |
|---|---|---|
| `JOIN` | `password`; optional `clientId`, `lastEventId`, `episodeId`, `providerId`, `pageUrl` | First message. Closed after 5s if absent. |
| `EVENT` | `event` ∈ {`play`,`pause`,`seek`}, `clientTs`; `value` (seconds) when seek | Rate-limited 10/s. |
| `EPISODE_CHANGE_REQUEST` | `episodeId`, `providerId`, `pageUrl`, `clientTs` | Hard reset. |
| `HEARTBEAT` | `currentPos`, `playerState` ∈ {`playing`,`paused`,`buffering`} | Every ~5s by spec. |
| `CLOCK_PING` | `clientSendTime` | Recommend 3–5 on first JOIN. |
| `BUFFER_START` | `videoPos` | Suppresses drift correction. |
| `BUFFER_END` | `videoPos` | Triggers per-client `ROOM_STATE`. |

### Server → client

| Type | Sent when | Fields |
|---|---|---|
| `ROOM_STATE` | After `JOIN` and after `BUFFER_END` | `clientId`, `playerState`, `videoPos`, `episodeId?`, `providerId?`, `contentKey?`, `lastEventId`, `serverTs`, `recentEvents[]?` |
| `STATE` | After every `EVENT` | `playerState`, `videoPos`, `eventId`, `serverTs` (broadcast) |
| `EPISODE_CHANGE` | After `EPISODE_CHANGE_REQUEST` | `eventId`, `episodeId`, `providerId`, `contentKey`, `serverTs` (broadcast) |
| `SYNC_ADJUST` | When drift > threshold | `serverTime`, `targetPos`, `mode` ∈ {`nudge-rate`,`seek`} (per-client) |
| `CLOCK_PONG` | Reply to `CLOCK_PING` | `clientSendTime`, `serverRecvTime`, `serverSendTime` |
| `ERROR` | Auth/validation/rate-limit failures | `code`, `message`. Closes connection only for `AUTH_FAILED` / `ROOM_NOT_FOUND` / `ROOM_EXPIRED`. |
| `CONTENT_MISMATCH` | `JOIN` content identity disagrees with room | `expectedContentKey`, `reportedContentKey?` (advisory; followed by `ERROR` + close). |

### Drift thresholds (config keys, defaults)

- `ws_drift_seek_threshold_ms` = `500`
- `ws_drift_nudge_threshold_ms` = `200`
- `ws_drift_cooldown_ms` = `3000` (skip reconciliation this long after explicit events)
- `ws_event_log_size` = `200`
- `ws_tombstone_ms` = `30000`
- `ws_join_timeout_ms` = `5000`
- `ws_idle_close_ms` = `30000`
- `ws_rate_limit_events_per_sec` = `10`

### Late-join sequence

1. Client opens WS to `…/ws/{uuid}` → daemon parses `{uuid}` from URL, looks up `Room` via `RoomMapper::findByUuid()`. If missing or expired → `ERROR ROOM_NOT_FOUND`/`ROOM_EXPIRED` then close.
2. Daemon waits for `JOIN`. Verifies password via `IHasher::verify()`. On failure → `ERROR AUTH_FAILED` + close.
3. If `clientId` matches a tombstoned `ClientConnection` and `tombstonedUntil > now`: reattach (preserve `lastEventId`).
4. Server computes `videoPos = state.expectedTime(now)`.
5. Server sends `ROOM_STATE` with the extrapolated `videoPos`. If reconnection, `recentEvents[]` includes events with `eventId > client.lastEventId`.
6. Client may send 3–5 `CLOCK_PING` to compute its offset; further messaging proceeds normally.

### Drift reconciliation

On `HEARTBEAT`, server computes `expectedPos = state.expectedTime(now)`, drift = `(currentPos - expectedPos) * 1000` ms.
- `|drift|` < `nudge_threshold` → no-op.
- `nudge_threshold` ≤ `|drift|` < `seek_threshold` → `SYNC_ADJUST mode=nudge-rate`.
- `|drift|` ≥ `seek_threshold` → `SYNC_ADJUST mode=seek`.
- Skip entirely if within `cooldown_ms` of last explicit event, or `client.isBuffering`.

---

## Reused patterns / utilities

- **Password verification:** `OCP\Security\IHasher` (already used by `RoomService`).
- **Room lookup / expiry:** existing `RoomMapper::findByUuid()` (`lib/Db/RoomMapper.php`).
- **Config keys:** `OCP\IAppConfig` — same pattern as the existing `restrict_to_admins` key.
- **Logging:** `Psr\Log\LoggerInterface`, retrieved from the app container in the command.
- **Command base:** `OCP\AppFramework\Console\Command` (Nextcloud's Symfony Console wrapper).
- **OLD_CODE precedent:** every protocol decision traces back to a specific OLD_CODE file documented in `references.md`.

---

## Standards applied

- **backend/php-conventions** — `declare(strict_types=1)`, only `OCP\` and project imports, attribute-based annotations, `APP_ID` constant.
- **No frontend changes**, so `frontend/vue-conventions` is N/A for v1.
- **No new user-facing strings**, so no `l10n/` updates needed (operator-facing CLI text is not localized in this app's pattern).

---

## Tasks

### Task 1 — Save spec documentation

Create `agent-os/specs/2026-05-09-1700-ws-sync-server/`:
- `plan.md` — copy of this plan.
- `shape.md` — scope, decisions, Q&A summary from this session (PHP-via-occ, Ratchet, in-memory only, password-in-JOIN auth, full message set, server-only scope).
- `standards.md` — full content of `agent-os/standards/backend/php-conventions.md`.
- `references.md` — pointers to OLD_CODE files (`server/src/types/messages.ts`, `server/src/types/room.ts`, `server/src/handlers/*.ts`, `server/src/utils/drift-reconciliation.ts`, `server/docs/WEBSOCKET_TYPES.md`, `docs/unified_v1_backend_and_network_design.md`) annotated with what each contributed to this design.
- `visuals/` — empty.

### Task 2 — Composer + skeleton

1. `composer require cboden/ratchet:^0.4` (and verify `react/event-loop` is brought in transitively).
2. Create `lib/Command/WsServe.php` with options: `--host` (default from `IAppConfig` `ws_host`, fallback `127.0.0.1`), `--port` (default from `ws_port`, fallback `8765`). For now, just bind, log "listening on host:port", and accept connections that immediately echo a hard-coded `ROOM_STATE`. No real protocol yet — the goal is to confirm the daemon starts, the proxy works, and `wscat` can connect.
3. Smoke test: `occ playbacksync:ws-serve` → in another terminal `websocat ws://127.0.0.1:8765/foo` → daemon logs the connect.

### Task 3 — Reverse-proxy doc + URL routing

Write `docs/ws-sync-server.md` with:
- Sample `nginx` location block for `/apps/playbacksync/ws/`.
- Sample Apache `ProxyPass` / `ProxyPassReverse` for the same path with `mod_proxy_wstunnel`.
- Sample systemd unit `playbacksync-ws.service`.
- The matrix of `IAppConfig` keys used by the daemon (the table under *Drift thresholds* above).

Verify manually: configure the proxy in the dev environment so `wscat ws://localhost/index.php/apps/playbacksync/ws/test` reaches the daemon.

### Task 4 — Domain types

Implement (no I/O, fully unit-tested):
- `PlaybackState` with `expectedTime(int $nowMs): float`.
- `ClientConnection`.
- `ContentIdentity` with `derive(): string` (sha256).
- `RoomRuntime` with `addClient`, `removeClient` (sets `tombstonedUntil`), `pushEvent`, `recentEventsSince(int $eventId)`, `prune(int $nowMs)`.
- `RateLimiter` (token bucket).

Unit tests for each.

### Task 5 — Message router + validator + encoder

- `MessageEncoder` (json_encode helpers, error envelope shape).
- `MessageValidator` per type.
- `MessageRouter` (`MessageComponentInterface`): `onOpen` registers the connection (no roomId yet — assigned on JOIN), `onMessage` parses + validates + dispatches to handlers, `onClose` triggers tombstoning, `onError` logs and closes.
- `RoomRegistry` injected into the router; lazy-creates `RoomRuntime` on first JOIN.

Wire into `WsServe` command: replace the smoke-test echo with the real router.

### Task 6 — Handlers

Implement in this order, each behind unit tests using a fake `ConnectionInterface`:
1. `JoinHandler` (auth, tombstone reattach, content identity, ROOM_STATE with replay).
2. `EventHandler` (broadcast `STATE`, rate-limit, eventId).
3. `EpisodeChangeHandler` (broadcast `EPISODE_CHANGE`, reset state).
4. `ClockHandler` (`CLOCK_PONG`).
5. `HeartbeatHandler` (drift math, `SYNC_ADJUST`).
6. `BufferHandler` (set/clear `isBuffering`, per-client `ROOM_STATE` on `BUFFER_END`).

### Task 7 — Tick / housekeeping

`Tick` runs on the loop every 1s:
- For each `RoomRuntime`: drop expired tombstones, drop idle connections (no `lastSeen` update for `ws_idle_close_ms`), force-close all connections if `room.expiresAt <= now`.
- Periodic memory metric to logger at INFO every 60s.

### Task 8 — Protocol doc

Write `docs/ws-protocol.md` documenting every message type, fields, examples, error codes. Audience: a future client/extension implementer.

### Task 9 — End-to-end manual verification

In `nextcloud-docker-dev`:
1. `composer install` and `occ app:enable playbacksync`.
2. Create a room via the existing UI. Note the `uuid` and password.
3. Start daemon: `occ playbacksync:ws-serve`.
4. Configure the proxy snippet from Task 3.
5. With `websocat`:
   - **Auth fail:** connect → send `JOIN` with wrong password → expect `ERROR AUTH_FAILED` and close.
   - **Auth success:** connect → `JOIN` correct password → expect `ROOM_STATE` with a fresh `clientId`.
   - **Broadcast:** open two `websocat` sessions, both `JOIN` same room. From session A send `EVENT play`. Session B receives `STATE playerState=playing`. A sends `EVENT seek value=120`. Both receive `STATE videoPos=120`.
   - **Late-join extrapolation:** A sends `play` at t=0. Wait 5 seconds. New session C joins → `ROOM_STATE.videoPos ≈ 5`.
   - **Reconnect with replay:** A drops connection mid-session (kill `websocat`), reconnects within 30s with the same `clientId` and last-seen `lastEventId` → `ROOM_STATE.recentEvents[]` contains the events A missed.
   - **Drift correction:** A sends `HEARTBEAT currentPos` 0.7s ahead of expected → expect `SYNC_ADJUST mode=seek`.
   - **Rate limit:** A sends 30 `EVENT`s in 1s → some return `ERROR RATE_LIMITED`; connection stays open.
   - **Room expiry:** force `expires_at` to past in DB; within 1s daemon closes all connections to that room with `ERROR ROOM_EXPIRED`.
6. Run `vendor/bin/phpunit tests/Unit/WebSocket/` — all green.

---

## Out of scope (explicitly deferred)

- Frontend Vue WS client / video player integration.
- Browser-extension piece that drives playback on the target site.
- Public room-join HTTP endpoint (the WS handshake here *is* the join, but a richer HTTP `/r/{uuid}` landing page is later).
- TLS termination by the daemon — admins use existing reverse proxy.
- Persisting playback state across daemon restarts (snapshot to DB) — only re-introduce if operational pain emerges.
- Membership/presence broadcasts to clients (intentional: server-only tracking).
- Per-room metrics / Prometheus exporter (OLD_CODE had this; defer until needed).
