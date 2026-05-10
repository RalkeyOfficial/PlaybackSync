# Missing Features Report — OLD vs CURRENT (backend + dashboard only)

Comparison of features documented in `OLD_CODE/docs/` against the current `docs/` and `agent-os/specs/`. Browser-extension features are excluded — backend (PHP / Nextcloud app, WebSocket sync daemon) and dashboard/admin panel only.

## Truly absent (no Phase 1/2 mention)

- **Prometheus metrics** (`/metrics`, `playbacksync_*` gauges/counters). OLD §10. Absent from current docs and roadmap.
- **Global per-room broadcast flood control.** OLD §8 had both per-connection *and* global rate limits — current `docs/ws-sync-server.md` only mentions per-connection (`ws_rate_limit_events_per_sec`).
- **Graceful shutdown / `SERVER_SHUTDOWN` message.** OLD broadcast a notice on SIGTERM. Current accepts "daemon restart drops connections, clients reconnect" as a design tradeoff — but no graceful-close path is specified.
- **WebSocket test harness** (`scripts/test-harness.js` from OLD §14). Phase 1 has PHPUnit but no multi-client WS simulator.
- **Resource budget estimates** (CPU/RAM/disk per room). OLD §15.

## Deferred per current roadmap (not gaps, just FYI)

- **Participant list / live presence in API** — Phase 2 spec `agent-os/specs/2026-05-09-1900-rooms-api-live-state/`.
- **`last_state` DB column** (cached playback state) — Phase 2 migration noted in `docs/architecture.md`.
- **Token-based auth** (replace password-in-URL). OLD §17 future work.
- **Live playback controls in dashboard** — OLD itself marked this out of v1.
- **Event log surfaced in UI** — exists server-side as in-memory ring buffer, no API exposure yet.

## Intentionally dropped/redesigned (worth confirming)

- **`COMMAND` message type** → folded into STATE.
- **`TIME_REPORT`** → replaced by HEARTBEAT carrying `currentPos`.
- **`MEMBER_JOINED`/`MEMBER_LEFT` broadcasts** — current `docs/ws-sync-server.md` explicitly says no client-facing presence.
- **Public ACK/NACK protocol** — kept as internal server concept only.
- **Standalone Node.js Docker service** → replaced by `occ playbacksync:ws-serve` PHP daemon.

## Recommendations to address

If you want parity with the OLD design's operational story, the highest-value items to add to the roadmap are:

1. **Graceful shutdown semantics** — at minimum document the contract (e.g. clients receive close code X and reconnect with backoff).
2. **Metrics story** — even if not Prometheus, document what's observable.

Resolved since this file was first written:

- **Kick endpoint** — `DELETE /api/v1/rooms/{uuid}/clients/{clientId}` is now wired end-to-end (PHP controller → HMAC loopback → daemon `KickController`) with a per-client reconnect block (`ws_kick_block_ms`, default 30 s) and a `KICKED` error frame on the way out. See `agent-os/specs/2026-05-10-1415-connected-client-kick/`.
- **Healthcheck endpoint** — daemon now exposes unauthenticated `GET /healthz` on the loopback admin port (`ws_admin_port`, default 8766) returning aggregate counters (active rooms, connected clients, uptime, tick freshness) plus daemon version. Single-path carve-out evaluated before the HMAC check; response carries no UUIDs / client IDs / secrets. A public `GET /api/v1/health` (`#[PublicPage]`) loopback-passthrough route surfaces the same body wrapped with a reachability envelope so external probes (k8s, status pages) can hit a stable Nextcloud URL — always returns HTTP 200, daemon trouble surfaces as `status: "degraded"`. Bonus: `/api/v1/ws/status` was refactored to actually probe the daemon (it previously only checked install-state) and now distinguishes `not_installed` from `not_running` so the dashboard surfaces a warning state with restart guidance instead of misleadingly reporting "available". See `agent-os/specs/2026-05-10-1530-ws-daemon-healthcheck/`.
- **Public share endpoint** — `GET /apps/playbacksync/r/{uuid}` is now wired end-to-end. Public route (`#[PublicPage]`, `#[NoCSRFRequired]`) gates on HTTP Basic Auth: the username is ignored, the password is verified against the room's argon2id hash via `RoomService::verifyPassword`, and on success the visitor is 302-redirected to `room.targetUrl` with `sync_url=wss://<host>/apps/playbacksync/ws/{uuid}` and `sync_password=<plaintext>` merged into the query (existing query params and fragments preserved). Failed attempts feed Nextcloud's `IThrottler` under action `playbacksync_share`; missing/malformed `Authorization` headers prompt the browser without registering as attempts. Unknown and expired rooms collapse to the same `404 {"error":"not_found"}` surface — never leaks "expired". Contract mirrors OLD_CODE Fastify route. See `agent-os/specs/2026-05-10-1615-public-share-endpoint/`.

---

## Detailed comparison tables

### 1. Room/group lifecycle

| Feature | OLD source | CURRENT status |
|---|---|---|
| Room name (optional nickname) | `backend_design_v1.md` §4 | Present (Phase 1) |
| Room expiration / TTL | `backend_design_v1.md` §3, `base_design_v1.md` §3.1 | Present (Phase 1) |
| Room password protection | `base_design_v1.md` §10 | Present (Phase 1) |
| Room delete/revoke | `backend_design_v1.md` §11 | Present as `DELETE /api/v1/rooms/{uuid}` |
| Participant kick (`DELETE /rooms/:id/clients/:cid`) | `backend_design_v1.md` §11 | Present (Phase 2 — see `agent-os/specs/2026-05-10-1415-connected-client-kick/`) |
| Room details + recent events (`GET /rooms/:id`) | `backend_design_v1.md` §11 | Partial — metadata only; presence/state in Phase 2 |
| Public share endpoint `GET /r/{uuid}` | `backend_design_v1.md` §9.2 | Present (`agent-os/specs/2026-05-10-1615-public-share-endpoint/`) |

### 2. Playback sync protocol

| Feature | OLD source | CURRENT status |
|---|---|---|
| `COMMAND` message type | `backend_design_v1.md` §5 | Dropped — folded into STATE |
| `TIME_REPORT` message | `backend_design_v1.md` §5 | Replaced by HEARTBEAT (`currentPos` + `playerState`) |
| `SERVER_SHUTDOWN` message | `backend_design_v1.md` §13 | Not in current protocol |
| Drift cooldown window | `backend_network_design_v1.md` §4 | Present (`ws_drift_cooldown_ms`) |
| Server-authoritative expected time | `unified_v1_backend_and_network_design.md` §2 | Present (extrapolated) |
| Playback-rate nudging | `backend_network_design_v1.md` §5 | Present (`ws_drift_nudge_threshold_ms`) |
| Hard seek correction | `backend_network_design_v1.md` §5 | Present (`ws_drift_seek_threshold_ms`) |

### 3. Presence / users

| Feature | OLD source | CURRENT status |
|---|---|---|
| Member list (active clients) | `backend_network_design_v1.md` §2 | Deferred to Phase 2 (anonymous, daemon-tracked) |
| `MEMBER_JOINED`/`LEFT` broadcasts | `backend_design_v1.md` §5 | Intentionally omitted from public protocol |
| ACK/NACK public messages | `backend_network_design_v1.md` §2–3 | Internal-only |
| Lagging client flag | `backend_network_design_v1.md` §4 | Implicit (idle-close); not surfaced |
| Buffering state (BUFFER_START/END) | `backend_network_design_v1.md` §4 | Present in `ws-protocol.md` |

### 4. Admin/dashboard

| Feature | OLD source | CURRENT status |
|---|---|---|
| Room creation dialog | `backend_design_v1.md` §11 | Present (Phase 1) |
| Live participant count + state | `backend_design_v1.md` §11 | Phase 2 spec (`...1900-rooms-api-live-state`) |
| Share-link generation | `base_design_v1.md` §9.2 | Present (field + `GET /r/{uuid}` Basic-Auth gated endpoint) |
| Owner play/pause/seek controls | `base_design_v1.md` §9.1 | Out of v1 (OLD also marked deferred) |
| Audit/event log in UI | `backend_design_v1.md` §9 | Server-side ring buffer only; not exposed |

### 5. Backend API endpoints absent from current `api.md`

| Endpoint | Purpose | Status |
|---|---|---|
| `DELETE /rooms/:roomId/clients/:clientId` | Forcibly disconnect participant | Present |
| `GET /rooms/:roomId` (with events) | Full state + recent events | Partial — metadata only |
| `GET /healthz` (daemon admin port) | Daemon liveness + light stats | Present |
| `GET /api/v1/health` (PHP passthrough) | Public liveness probe surfaced via Nextcloud | Present |
| `GET /metrics` | Prometheus metrics | Deferred / undocumented |

### 6. Persistence / data model

| Field/entity | OLD intent | CURRENT status |
|---|---|---|
| `last_state` column | Cached pos/provider/episode | Phase 2 migration |
| Event-log ring buffer | Per-room recent events for replay | Present in-memory; not persisted |
| Client connection metadata (`clientId`, `lastSeen`, `tombstonedUntil`) | Per-client state | In daemon memory only |
| Provider/episode in DB | Canonical video identity | In WS protocol only; DB caching in Phase 2 |

### 7. Auth / security

| Feature | OLD source | CURRENT status |
|---|---|---|
| Token-based auth | `backend_design_v1.md` §17 | Out of MVP |
| Per-connection rate limit | `backend_design_v1.md` §8 | Present (`ws_rate_limit_events_per_sec`) |
| Global per-room flood control | `backend_design_v1.md` §8 | **Not mentioned** |
| Admin secret (HMAC/server secret) | `backend_design_v1.md` §3 | Evolved — argon2id + `ws_admin_secret` for Phase 2 loopback bridge |

### 8. Operational

| Feature | OLD source | CURRENT status |
|---|---|---|
| Docker container (Node.js) | `backend_design_v1.md` §12 | Replaced by `occ playbacksync:ws-serve` daemon |
| Prometheus metrics | `backend_design_v1.md` §10 | **Absent** |
| Structured logging (pino) | `backend_design_v1.md` §9 | Replaced by Nextcloud OCP logging |
| Graceful shutdown (SIGTERM) | `backend_design_v1.md` §13 | **No handshake documented** |
| Test harness | `backend_design_v1.md` §14 | **Absent** |
| Resource estimates | `backend_design_v1.md` §15 | **Absent** |
