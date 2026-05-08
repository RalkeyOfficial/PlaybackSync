# PlaybackSync

> **Historical note:** The rules below were ported from `.cursor/rules/*.mdc` and describe the **previous implementation**, now archived under `OLD_CODE/`. They capture the architectural intent of PlaybackSync and remain useful as guidance for the rewrite, but specific paths (`server/`, `docs/`, `schemas/`), file references, and library choices may not match the new codebase. Update or prune sections as the rewrite progresses.

---

## Documentation Priority Order

When reading from `docs/` design documents, resolve conflicts in favor of the higher-priority document:

1. `unified_v1_backend_and_network_design.md` (highest)
2. `backend_network_design_v1.md`
3. `backend_design_v1.md`
4. `extension_design_v1.md`
5. `base_design_v1.md` (lowest)

Lower-priority documents may supply supplementary detail not present in higher-priority ones, but any inconsistency is resolved by the higher-priority document.

---

## Project Standards

### Architecture Principles

- **Single container design**: HTTP dashboard + WebSocket sync in one Node.js process.
- **Minimal dependencies**: No DB, no Redis — all state in-memory.
- **JSON message protocol**: All WebSocket messages are JSON with server-side validation.
- **Structured logging**: Use `pino` for all logging, never `console.log`.
- **No password storage**: Hash passwords using HMAC with server secret; never store plaintext.

### Code Organization

- Server code in `server/`.
- JSON Schemas in `schemas/*.json` for message validation.
- Use `ajv` for all message schema validation.
- Keep functions focused and under ~50 lines when possible.

### Error Handling

- Always validate WebSocket messages with JSON Schema before processing.
- Send `ERROR` messages to clients for recoverable issues.
- Log errors with structured context: `logger.error('event', { roomId, clientId, error })`.
- Never expose internal errors to clients — use friendly error codes.
- **Never mention "expired" in client-facing error messages.** Rooms either exist or don't from the user's perspective.
  - Use `"Room not found"` instead of `"Room expired"` or `"Room not found or expired"`.
  - Server-side logs may mention expiration for debugging; client-facing messages must not.

### State Management

- Rooms stored in `Map<roomId, Room>` in memory.
- Client connections in `Map<clientId, ClientConnection>` per room.
- Use tombstone pattern for client reconnection (`CLIENT_TOMBSTONE_MS` window).
- Event log as ring buffer (last N events per room).

### Development Environment

- **Docker container execution**: Code runs inside Docker containers, not directly on the host.
- **No build commands**: Never run `npm run build` or similar — the dev container handles compilation automatically.
- **Hot reloading**: The dev container (`playbacksync-dev`) uses nodemon with tsx for automatic reload on file change.
- **Volume mounts**: Source is mounted as volumes, so file changes are detected automatically.
- **Testing**: Run tests inside the container, not on the host.

---

## TypeScript & Node.js Patterns

### Type Safety

- TypeScript strict mode.
- Define interfaces for all message types (`JOIN`, `EVENT`, `STATE`, `COMMAND`, `ERROR`).
- Use branded types for `roomId` and `clientId` (UUID strings).
- Prefer `Map` over plain objects for key-value lookups.

### Async Patterns

```typescript
// GOOD — explicit error handling
try {
  await processMessage(msg);
} catch (error) {
  logger.error('Failed to process message', { error, roomId });
  sendError(conn, 'PROCESSING_FAILED');
}

// BAD — silent failures
await processMessage(msg).catch(() => {});
```

### Fastify Patterns

- Use Fastify plugins for route organization.
- Register the WebSocket upgrade handler on the Fastify server instance.
- Use Fastify's built-in JSON Schema validation for HTTP endpoints.
- Return structured JSON responses: `{ success: true, data: {...} }`.

### WebSocket (`ws` library)

- Always validate messages before processing.
- Close connections gracefully on errors.
- Store connection metadata (`roomId`, `clientId`) on the `ws` object.
- Handle cleanup in the `close` event handler.

---

## WebSocket Message Handling

### Message Validation

- Always validate incoming messages with JSON Schema using `ajv` before processing.
- Reject invalid messages immediately with an `ERROR` response.
- Never trust client timestamps — use server `server_ts` for authoritative state.

### Error Messages to Clients

- **Never mention "expired" in client-facing errors.** Use `"Room not found"`.
- Server-side logs may mention expiration for debugging.
- `sendError(ws, 'ROOM_NOT_FOUND', 'Room not found')` ✓
- `sendError(ws, 'ROOM_NOT_FOUND', 'Room expired')` ✗

### Message Flow

```typescript
// GOOD — validate then process
const isValid = validateMessage(msg, schema);
if (!isValid) {
  sendError(conn, 'INVALID_MESSAGE');
  return;
}
await handleMessage(msg, room, client);
```

### Broadcasting

- Broadcast `STATE` after every explicit event (`EVENT`, `EPISODE_CHANGE`).
- Include `server_ts` in all `STATE` messages for client synchronization.
- Use `room.connectedClients.forEach()` to broadcast — don't send to a single client unless intentional.
- Handle closed connections gracefully (catch send errors).

### Rate Limiting

- Apply a per-connection rate limiter for explicit control events.
- Use token bucket or `rate-limiter-flexible`.
- Return `ERROR` with code `RATE_LIMITED` when exceeded.
- Log rate-limit violations for monitoring.

### Reconnection Handling

- On `JOIN` with an existing `clientId`, check for a tombstone.
- If the tombstone is valid, reattach the connection instead of creating a new client.
- Send the current `STATE` immediately after a successful `JOIN`.
- Include `lastKnownTime` in `JOIN` for drift detection.

---

## Drift Reconciliation

### Expected Time Calculation

- Server maintains authoritative `expected_time` based on the last explicit event.
- If `paused == true`: `expected_time = state.time`.
- If `paused == false`: `expected_time = state.time + (now - state.last_state_update_ts)`.
- Never derive time from client reports — only use them for drift detection.

### Reconciliation Algorithm

```typescript
// GOOD — server-authoritative reconciliation
if (now - last_explicit_event_ts < COOLDOWN_WINDOW_MS) {
  return; // Skip during cooldown
}

const expectedTime = calculateExpectedTime(room.state);
const deltas = await requestTimeReports(room.clients);

if (deltas.some(d => Math.abs(d) >= DRIFT_THRESHOLD_MS)) {
  broadcastState({ time: expectedTime }); // Server time, not client time
}
```

### Cooldown Window

- Skip reconciliation for `COOLDOWN_WINDOW_MS` after explicit events.
- Prevents reconciliation from interfering with user actions.
- Update `last_explicit_event_ts` on every `EVENT` / `EPISODE_CHANGE`.

### TIME_REPORT Handling

- Request `TIME_REPORT` from all clients periodically (`DRIFT_CHECK_INTERVAL_MS`).
- Compute delta: `client_time - expected_time`.
- If any client exceeds `DRIFT_THRESHOLD_MS`, broadcast authoritative `STATE`.
- Never adjust server time based on client reports — only correct clients.

### Key Principle

**Server time is authoritative. Clients are corrected to match server time, never the reverse.**

---

## Logging & Metrics

### Structured Logging (`pino`)

```typescript
// GOOD — structured with context
logger.info({ roomId, clientId, event: 'join' }, 'Client joined room');

// BAD — string interpolation
logger.info(`Client ${clientId} joined room ${roomId}`);
```

### Log Levels

- `info`: Normal operations (room created, client joined, events processed).
- `warn`: Recoverable issues (rate limit hit, invalid message format).
- `error`: Exceptions and failures (connection errors, processing failures).

### Anonymization

- Never log passwords (plaintext or hash).
- Mask `clientId` in logs if `ANON_LOGGING=true`.
- Redact IP addresses in production logs.

### Prometheus Metrics

- Use `prom-client` for all metrics.
- Gauge metrics: `playbacksync_rooms_total`, `playbacksync_connections_total`.
- Counter metrics: `playbacksync_events_total`, `playbacksync_rate_limited_total`.
- Expose `/metrics` endpoint on the Fastify server.
- Naming: `playbacksync_<metric_name>_<type>`.

```typescript
// GOOD — increment counter with labels
metrics.eventsTotal.inc({ eventType: 'seek', roomId });

// GOOD — update gauge
metrics.roomsTotal.set(rooms.size);
```

---

## Testing Patterns

### Unit Tests

- Test JSON Schema validators with valid and invalid inputs.
- Test event handlers with mocked room state.
- Test the rate limiter at various event frequencies.
- Use Jest or Mocha as the framework.

### Integration Tests

- Use the test harness (`scripts/test-harness.js`) to simulate multiple WebSocket clients.
- Message flow: client A sends `EVENT` → verify clients B/C receive `STATE`.
- Reconnection: disconnect and reconnect with same `clientId` → verify tombstone reattachment.
- Drift reconciliation: simulate client drift → verify server corrects clients.

### Test Harness Patterns

```typescript
// GOOD — simulate real client behavior
const client = await createTestClient();
await client.join(roomId, password);
await client.sendEvent('seek', 10);
const state = await client.waitForState();
expect(state.time).toBe(10);
```

### Mocking

- Mock WebSocket connections for unit tests.
- Use in-memory room state (don't require a real server).
- Mock time for drift reconciliation tests.
- Mock the rate limiter for event handler tests.

### Test Data

- Use predictable UUIDs for test `roomId`/`clientId`.
- Use fixed timestamps for deterministic tests.
- Clean up test rooms after each test.
