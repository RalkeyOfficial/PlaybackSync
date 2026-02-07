# PlaybackSync – Backend Design (v1)

## Overview
This document details the backend service for PlaybackSync v1: responsibilities, technical specifications, message schemas, implementation notes, deployment artifacts (Dockerfile, docker-compose), observability, testing, and operational guidance. It assumes the browser extension and dashboard (owner UI) are implemented in tandem and that authentication for the dashboard is handled externally (Authelia).

Goals for v1
- Single combined service (HTTP dashboard + WebSocket sync) in one container
- Minimal external dependencies (no DB / no Redis)
- Small, efficient container image
- Clear JSON message protocol with server-side validation
- Safe behavior for small trusted groups (typical: 1 room, 3 concurrent clients)

Non-goals (v1)
- Horizontal scaling / multi-instance operation
- Persistent storage of rooms
- Built-in user accounts / advanced auth

---

## 1. Language & stack
Recommendation: **Node.js** (18/20 LTS) + Fastify for HTTP + `ws` for WebSocket handling.
Rationale: Node.js images are compact (alpine variants), tooling is mature, and `ws` is minimal and reliable. Combining Fastify + ws on a single server is straightforward.

Key libraries
- fastify (HTTP dashboard + admin REST)
- ws (WebSocket server)
- ajv (JSON Schema validation)
- pino (structured JSON logging)
- prom-client (Prometheus metrics)
- rate-limiter-flexible or a simple token-bucket implementation for rate limits
- uuid (UUID v4 for room IDs & client IDs)

Container base image: `node:20-alpine` (small image)

---

## 2. High-level architecture (single container)
- HTTP server (Fastify)
  - Dashboard UI endpoints (protected by Authelia)
  - Admin API endpoints: create_room, revoke_room, list_rooms, room_state
  - Healthcheck endpoint `/healthz`
  - Metrics endpoint `/metrics`
- WebSocket server (ws) attached to same HTTP server
  - Accepts client connections
  - Validates `JOIN` with room_id + password
  - Routes incoming messages to handlers
  - Broadcasts STATE / COMMAND

All components run in the same Node process.

---

## 3. Config & environment variables
Required env vars (examples and defaults):
- `PORT=8080`
- `SHARE_HOSTNAME=share.playbacksync.mydomain.tld` (used in share redirects)
- `SYNC_HOSTNAME=sync.playbacksync.mydomain.tld` (wss host used for client params)
- `ROOM_TTL_SECONDS=86400` (24h)
- `DRIFT_THRESHOLD_MS=500` (0.5s)
- `COOLDOWN_WINDOW_MS=3000` (3s) — suspend reconciliation for this window after explicit event
- `CLIENT_TOMBSTONE_MS=30000` (30s) — allow quick reconnect identity
- `RATE_LIMIT_EVENTS_PER_SEC=10`
- `LOG_LEVEL=info`
- `ANON_LOGGING=true` (mask IPs / PII)

Additionally, rooms track **target video identity** derived from the owner-selected stream URL (see sections 4 and 6).` (mask IPs / PII)

Secrets and sensitive config should be set via environment variables on the host's docker-compose file.

---

## 4. In-memory data model
All state is kept in memory. Example shape:

```
rooms = Map<roomId, Room>

Room {
  roomId: string,
  passwordHash: string,
  createdAt: number,
  expiresAt: number,

  // Canonical video identity for the room
  target: {
    showId: string,
    provider: string,
    streamUrl: string,
  },

  connectedClients: Map<clientId, ClientConnection>,

  state: {
    paused: boolean,
    time: number,
    provider: string,
    episode: number,
    last_explicit_event_ts: number,
    last_state_update_ts: number,
  },

  eventLog: Array<RecentEvent>, // ring buffer, last N explicit events
}

ClientConnection {
  clientId: string,
  conn: ws, // ws connection object
  lastSeen: number,
  tombstonedUntil?: number,
}

RecentEvent {
  type: string,
  value?: number | string,
  clientId?: string,
  ts: number,
}
```

Note: `passwordHash` should be a one-way hash of the room password (e.g., bcrypt or sha256 with server secret) so that the plaintext password is not retained in memory logs. For simplicity and speed, a HMAC using a server-side secret and SHA256 is sufficient for equality checks without storing plaintext.

---

## 5. WebSocket message protocol (JSON)
All messages are JSON objects. Use `ajv` server-side to validate messages. Timestamps are monotonic or epoch ms depending on use; prefer monotonic client_ts for ordering but server will accept epoch ms as well.

Client → Server (examples)

`JOIN`:
```
{ "type": "JOIN", "roomId": "<uuid>", "password": "<password>", "clientId": "<uuid-v4>", "lastKnownTime": 12.345 }
```

`EVENT` (explicit control):
```
{ "type":"EVENT", "event": "play"|"pause"|"seek", "value": <seconds|undefined>, "client_ts": 1670000000000 }
```

`EPISODE_CHANGE`:
```
{ "type":"EPISODE_CHANGE", "provider":"<provider>", "episode": 5, "url":"<page url>", "client_ts": 1670000000000 }
```

`TIME_REPORT` (drift reporting):
```
{ "type":"TIME_REPORT", "current_time": 123.456, "client_ts": 1670000000000 }
```

Server → Client

`STATE` (authoritative state):
```
{ "type":"STATE", "paused": false, "time": 123.456, "provider":"<provider>", "episode": 5, "server_ts": 1670000000000 }
```

`COMMAND` (server-initiated action):
```
{ "type":"COMMAND", "cmd": "seek"|"play"|"pause", "value": 123.456 }
```

`ERROR`:
```
{ "type":"ERROR", "code": "AUTH_FAILED", "message": "Invalid room or password" }
```

Validation: each message type will have an explicit JSON Schema used by `ajv`. Messages failing validation are rejected and optionally cause a friendly `ERROR` reply.

---

## 6. Core server loops (pseudocode)

### On WS connection
1. Accept socket
2. Wait for `JOIN` message within a short timeout (e.g., 5s). If not received, close.
3. Validate room and password. If invalid, send `ERROR` and close.
4. Add client to `room.connectedClients`
5. Send current `STATE`
6. Resume normal message handling for that client

### On receiving `EVENT` or `EPISODE_CHANGE`
1. Validate message schema
2. Update `room.state` immediately
3. Append to room.eventLog
4. Update `room.state.last_explicit_event_ts = now`
5. Broadcast `STATE` to all connected clients (or a `COMMAND` if you prefer only action messages)

Note: When broadcasting, tag messages with server_ts and the authoritative show id so clients can double-check before applying.

### Drift reconciliation (event-driven via HEARTBEAT)
The server maintains an **expected playback time** derived from the last explicit event and current play/pause state.

Expected time calculation:
- If `playerState == 'paused'`:
  - `expected_time = state.videoPos`
- If `playerState == 'playing'`:
  - `expected_time = state.videoPos + (now - state.last_state_update_ts)`

Note: Server state is always either `'playing'` or `'paused'`. Buffering is client-specific and reported via HEARTBEAT messages, but does not affect the authoritative server state.

Reconciliation algorithm (per room):
1. If `now - last_explicit_event_ts < COOLDOWN_WINDOW_MS` → skip
2. Request `TIME_REPORT` from all connected clients
3. For each client, compute `delta = client_time - expected_time`
4. If **any** client satisfies `abs(delta) >= DRIFT_THRESHOLD_MS`:
   - Server does **not** shift authoritative time to max/min
   - Server keeps authoritative `expected_time`
   - Broadcast `STATE { videoPos: expected_time, playerState }` to all clients

This ensures that:
- A single heavily drifted client is corrected even if the group average is close
- Authority remains server-derived, not client-derived
- Fast-forward or rewind intent is only respected via explicit control events

Implementation note: this replaces the earlier "max-time heuristic". Expected time is now deterministic and server-owned.

### On disconnect
- Mark client `lastSeen = now` and set `tombstonedUntil = now + CLIENT_TOMBSTONE_MS`
- Remove connection object from `connectedClients` but keep tombstone metadata for CLIENT_TOMBSTONE_MS so a fast reconnect using same `clientId` can re-associate

---

## 7. Reconnect / backoff policy (client-side guidance)
Client should implement exponential backoff with jitter. Recommended parameters:
- initialDelay = 500 ms
- factor = 2
- maxDelay = 30000 ms (30s)
- jitter = uniform random in [-0.2*delay, +0.2*delay]

On reconnect success:
- Re-send `JOIN` with `roomId`, `password`, `clientId`, and `lastKnownTime`
- If server sees a tombstone for that `clientId` and `tombstonedUntil` not passed, treat as same client connection and reattach.

Server-side: keep client tombstone for `CLIENT_TOMBSTONE_MS` (default 30s). This reduces flapping issues on flaky mobile networks.

---

## 8. Rate limiting & abuse protection
- Per-connection rate limiter for explicit control events: e.g., max `RATE_LIMIT_EVENTS_PER_SEC` events per second (default 10). Throttle or reject over-limit messages with `ERROR`.
- Global per-room floods: limit broadcast rate to clients to avoid DoS.
- Validate message sizes and schemas to avoid memory exhaustion.

---

## 9. Logging & anonymization
- Use `pino` structured JSON logs to stdout.
- Do not log raw passwords. Log `roomId` and hashed password only if needed (prefer not to log passwordHash either).
- Redact client IPs and any PII if `ANON_LOGGING=true`.
- Log levels: `info` for normal ops, `warn` for recoverable issues, `error` for exceptions.
- Example log lines:
  - `room.created roomId=<id> ttl=<seconds>`
  - `client.join roomId=<id> clientId=<masked>`
  - `event.received roomId=<id> event=seek value=123 clientId=<masked>`

Audit buffer: keep last N explicit events per room in-memory (ring buffer). This can be exposed to the dashboard.

---

## 10. Metrics (Prometheus)
Expose `/metrics`. Track:
- `playbacksync_rooms_total` (gauge)
- `playbacksync_connections_total` (gauge)
- `playbacksync_events_total` (counter)
- `playbacksync_reconciliation_runs_total` (counter)
- `playbacksync_rate_limited_total` (counter)

Add standard process metrics (heap, cpu) from `prom-client`.

---

## 11. Admin HTTP API (Fastify)
Protected by external auth (Authelia); server does not implement user auth.

Endpoints (JSON REST):
- `POST /api/rooms` → create room
  - body: `{ "ttl": 86400, "targetUrl": "https://..." }`
  - server generates `roomId` and `password` and returns share link and password one-time in response
- `DELETE /api/rooms/:roomId` → revoke (immediately destroy room and close connections)
- `GET /api/rooms` → list rooms (id, createdAt, participantCount, last_state)
- `GET /api/rooms/:roomId` → room details and recent events
- `GET /healthz` → return 200 if server running
- `GET /metrics` → Prometheus metrics

Note: When creating a room, server should store `targetShowId` and include it in `STATE` broadcasts.

---

## 12. Dockerfile and docker-compose
### Dockerfile (example)
```
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY . .
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "./dist/server.js"]
```

Build process for development can use a multi-stage build to compile TypeScript if used.

### docker-compose.yml (example)
```
version: '3.8'
services:
  playbacksync:
    image: playbacksync:local
    build: .
    container_name: PlaybackSync
    environment:
      - PORT=8080
      - SHARE_HOSTNAME=share.playbacksync.mydomain.tld
      - SYNC_HOSTNAME=sync.playbacksync.mydomain.tld
      - ROOM_TTL_SECONDS=86400
      - DRIFT_THRESHOLD_MS=500
      - COOLDOWN_WINDOW_MS=3000
      - CLIENT_TOMBSTONE_MS=30000
      - RATE_LIMIT_EVENTS_PER_SEC=10
      - LOG_LEVEL=info
      - ANON_LOGGING=true
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.playbacksync.rule=Host(`share.playbacksync.mydomain.tld`) || Host(`sync.playbacksync.mydomain.tld`)"
      - "traefik.http.routers.playbacksync.entrypoints=websecure"
      - "traefik.http.routers.playbacksync.tls=true"
      
    ports:
      - "8080:8080"
    restart: unless-stopped
```

Traefik will handle TLS / Let’s Encrypt externally.

---

## 13. Healthchecks & graceful shutdown
- HTTP `/healthz` returns 200 when server is up; include basic internal checks (event loop responsive, memory under threshold)
- On SIGTERM/SIGINT:
  - stop accepting new connections
  - notify connected clients with a `SERVER_SHUTDOWN` notice
  - wait up to 5s for graceful close, then forcibly close sockets

---

## 14. Testing & local dev
- Provide unit tests with Jest (or Mocha) for message validators (JSON Schema), event handlers, and rate limiter.
- Provide a small test harness (`scripts/test-harness.js`) that can spawn multiple WS clients connecting to the server, send sequences of events, and verify resulting STATE broadcasts.
- Provide an integration test that runs the built Docker image via `docker-compose` and runs the harness against it.

Example harness responsibilities:
- spawn N clients
- have client A send `seek` to 10s
- confirm clients B/C receive `STATE` within 500ms and update
- simulate network disconnect and reconnect with same `clientId` to confirm tombstone reattachment

---

## 15. Resource estimates
For target load (1 room, 3 users):
- CPU: single vCPU, but actual usage minimal (0.05–0.2 cores typical)
- RAM: 50–150 MB
- Disk: minimal for logs; 256 MB ephemeral disk is fine

For headroom: run with 128 MB memory reservation and 0.5 vCPU available. This is safe for single-instance homelab deployment.

---

## 16. Operational notes
- Ensure the host used for the container has system-time stable (NTP) — timestamps are not relied upon for strict ordering, but monotonic timers are useful.
- Monitor `/metrics` with Prometheus and alert on `playbacksync_connections_total == 0` during expected usage, error increases, or reconciliation failures.
- Rotate logs (host-level) and ensure `ANON_LOGGING` is enabled to avoid sensitive data leakage.

---

## 17. Future migration notes
To scale or persist later, consider:
- Switch to Redis for ephemeral state + pub/sub (rooms shard across instances)
- Store room metadata in PostgreSQL if you need durable rooms
- Add token-based auth to avoid sending passwords over URLs (if threat model changes)

---

## 18. Deliverables (what I'll provide)
If you want I will produce the following artifacts in the repo:
- `server/` implementation (Node.js + Fastify + ws)
- JSON Schemas (`schemas/*.json`) for all message types
- `Dockerfile` and `docker-compose.yml` (Traefik labels included)
- `scripts/test-harness.js` to simulate clients
- Example `Makefile` tasks: `make build`, `make run`, `make test`
- Basic unit tests for validators and core event handlers

---

If any of this conflicts with your preferences, or you want the Python variant instead, say so and I will produce the corresponding concrete files and code samples.

