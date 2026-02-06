# WebSocket Handlers Documentation

This document describes how each WebSocket message handler works in detail - what they do, how they process messages, and how they update room state. Think of this as the "deep dive" into the handler implementations.

For an overview of the WebSocket server architecture and connection lifecycle, see [WebSocket Implementation Documentation](./WEBSOCKET_IMPLEMENTATION.md).

For message type definitions and schemas, see [WebSocket Types Documentation](./WEBSOCKET_TYPES.md).

## Handler Overview

All handlers follow a similar pattern:

1. **Authentication Check**: Verify client has completed JOIN (has `clientId`)
2. **Message Validation**: Validate message against JSON Schema using `ajv`
3. **Room Validation**: Ensure room exists and is not expired
4. **Process**: Update room state based on message
5. **Respond**: Send response messages (either to sender or broadcast to all clients)

## JOIN Handler

The JOIN handler is the first handler that runs after a connection is established. It authenticates the client and registers them with the room.

### Handler Function

```typescript
handleJoinMessage(
  ws: ExtendedWebSocketWithRateLimit,
  message: unknown,
  roomId: RoomId,
  connectionsByRoom: ConnectionsByRoom
): void
```

### What It Does

When a client sends a JOIN message, the handler:

1. **Validates the message** against the JOIN schema
2. **Checks room exists** and is not expired (room was already validated in `handleConnection`, but checked again in case it was deleted)
3. **Generates or reattaches clientId**:
   - If `clientId` provided: Validates format and attempts reconnection
   - If no `clientId`: Generates new UUID v4 clientId
4. **Checks connection limits** - rejects if room is at capacity (`MAX_CONNECTIONS_PER_ROOM`)
5. **Verifies password** using HMAC-SHA256 hash comparison
6. **Handles reconnection** using tombstone pattern:
   - If valid tombstone exists: Reattaches connection, preserves `lastEventId` for event replay
   - If tombstone expired: Treats as new client (same clientId, but no state preservation)
7. **Registers client** in `room.connectedClients` map
8. **Initializes rate limiter** for EVENT message rate limiting
9. **Tracks connection** in `connectionsByRoom` map
10. **Sends ROOM_STATE** message with current room state, assigned `clientId`, and optionally `recentEvents` for reconnections

### Reconnection Logic

The JOIN handler implements a "tombstone" pattern for reconnections:

- **Tombstone Window**: When a client disconnects, a tombstone is created with an expiration time (`CLIENT_TOMBSTONE_MS`, default 30 seconds)
- **Valid Tombstone**: If client reconnects within the window:
  - Connection is reattached to existing client entry
  - `lastEventId` is preserved for event replay
  - `recentEvents` array is included in ROOM_STATE
- **Expired Tombstone**: If client reconnects after window expires:
  - Old client entry is removed
  - New client entry is created (same clientId, but fresh state)
  - No `recentEvents` included (client syncs from current state)

### Event Replay

For reconnections with valid tombstones, the handler includes a `recentEvents` array in the ROOM_STATE message. This array contains all events that occurred since the client's last known `eventId`, allowing the client to replay missed events and catch up to the current state.

Events are filtered from the room's event log (ring buffer) where `eventId > lastKnownEventId`.

### Rate Limiter Initialization

During JOIN, a rate limiter state is created and stored on the WebSocket connection (`ws.rateLimiterState`). This is used later by the EVENT handler to enforce per-connection rate limits.

### Error Responses

The JOIN handler can send the following error responses:

- `INVALID_MESSAGE`: Message validation failed (schema errors) - connection closed
- `ROOM_NOT_FOUND`: Room doesn't exist or is expired - connection closed
- `ROOM_FULL`: Room connection limit exceeded - connection closed
- `AUTH_FAILED`: Password verification failed - connection closed

### Example Flow

**First Connection:**
1. Client connects to `wss://host/{roomId}`
2. Server validates room exists
3. Client sends JOIN with password
4. Server generates new `clientId`
5. Server sends ROOM_STATE with `clientId` and current state

**Reconnection (Valid Tombstone):**
1. Client disconnects (tombstone created)
2. Client reconnects within 30 seconds
3. Client sends JOIN with previous `clientId` and password
4. Server reattaches connection, preserves `lastEventId`
5. Server sends ROOM_STATE with `clientId`, current state, and `recentEvents` array

## EVENT Handler

The EVENT handler processes explicit playback control events from clients - play, pause, and seek actions. These represent user intent, not authoritative state. The server updates room state and broadcasts authoritative STATE messages to all clients.

### Handler Function

```typescript
handleEventMessage(
  ws: ExtendedWebSocketWithRateLimit,
  message: unknown,
  roomId: RoomId,
  connectionsByRoom: ConnectionsByRoom
): void
```

### What It Does

When a client sends an EVENT message, the handler:

1. **Checks authentication** - verifies client has `clientId` (completed JOIN)
2. **Validates message** against EVENT schema
3. **Validates room** exists and is not expired
4. **Checks rate limit** using token bucket algorithm (per-connection)
5. **Updates room state**:
   - Increments `eventId` for ordering
   - Updates `last_explicit_event_ts` and `last_state_update_ts` to current time
   - Updates playback state based on event type:
     - `play`: Sets `paused = false`
     - `pause`: Sets `paused = true`
     - `seek`: Sets `time = eventMessage.value`
6. **Logs event** to room's event log (ring buffer, max 100 events)
7. **Broadcasts STATE** message to all connected clients in the room

### Rate Limiting

Rate limiting prevents clients from flooding the server with events. It uses a token bucket algorithm:

- **Per-Connection**: Each WebSocket connection has its own rate limiter state
- **Token Bucket**: Tokens refill at configurable rate (default: 10 events/second)
- **Initialization**: Rate limiter state created during JOIN
- **Check**: Before processing EVENT, checks if token is available
- **Exceeded**: If rate limit exceeded, sends `ERROR` with code `RATE_LIMITED` and does not process event

The rate limiter state is stored on the `ExtendedWebSocket` interface as `rateLimiterState`.

### State Updates

When processing an EVENT, the server:

1. **Increments `eventId`**: Each event gets a unique, incrementing event ID for ordering
2. **Updates Timestamps**:
   - `last_explicit_event_ts`: Set to current server time (used for drift reconciliation cooldown)
   - `last_state_update_ts`: Set to current server time
3. **Updates Playback State**:
   - For `play`: `paused = false`
   - For `pause`: `paused = true`
   - For `seek`: `time = eventMessage.value` (must be >= 0)

### Event Logging

Events are logged to a ring buffer per room:

- **Maximum Size**: 100 events (configurable via `MAX_EVENT_LOG_SIZE`)
- **Event Structure**: Includes event type, clientId, timestamp, eventId, and optional value
- **Ring Buffer**: When log reaches maximum size, oldest events are removed (FIFO)
- **Purpose**: Used for event replay on reconnection (via `recentEvents` in ROOM_STATE)

### State Broadcasting

After processing an EVENT, the server broadcasts a `STATE` message to all connected clients in the room:

- **Authoritative State**: The STATE message contains the server's authoritative playback state
- **All Clients**: All clients receive the broadcast, including the client that sent the EVENT
- **Event ID**: The STATE message includes the updated `eventId` for ordering
- **Server Timestamp**: Includes `server_ts` for synchronization

**Important**: Clients must not suppress or ignore STATE messages they "caused". The server's STATE message is always authoritative, even for the originating client. This ensures all clients stay in sync even if network conditions vary.

### Error Responses

The EVENT handler can send the following error responses:

- `NOT_AUTHENTICATED`: EVENT received before JOIN message
- `INVALID_MESSAGE`: Message validation failed (schema errors)
- `RATE_LIMITED`: Rate limit exceeded for this connection
- `ROOM_NOT_FOUND`: Room doesn't exist or is expired

### Example Flow

1. Client sends EVENT: `{ type: "EVENT", event: "play", client_ts: 1670000000000 }`
2. Server validates message and checks rate limit
3. Server updates room state: `paused = false`, increments `eventId`
4. Server logs event to event log
5. Server broadcasts STATE to all clients: `{ type: "STATE", paused: false, time: 123.456, eventId: 43, server_ts: 1670000000100 }`

## EPISODE_CHANGE_REQUEST Handler

The EPISODE_CHANGE_REQUEST handler processes episode change requests from clients. Episode changes are treated as **hard resets** that invalidate all previous playback state. The server updates room content identity, resets playback state, and broadcasts authoritative EPISODE_CHANGE messages to all clients.

### Handler Function

```typescript
handleEpisodeChangeRequest(
  ws: ExtendedWebSocket,
  message: unknown,
  roomId: RoomId,
  connectionsByRoom: ConnectionsByRoom
): void
```

### What It Does

When a client sends an EPISODE_CHANGE_REQUEST message, the handler:

1. **Checks authentication** - verifies client has `clientId` (completed JOIN)
2. **Validates message** against EPISODE_CHANGE_REQUEST schema
3. **Validates room** exists and is not expired
4. **Computes derivedContentKey** from URL + provider + episode using SHA-256 hash
5. **Resets playback state** (hard reset):
   - `paused = true`
   - `time = 0`
6. **Increments `eventId`** for ordering
7. **Updates timestamps**: `last_explicit_event_ts` and `last_state_update_ts` to current time
8. **Updates content identity** with new episode metadata:
   - `episodeId`: From request (string or number)
   - `providerId`: From request
   - `derivedContentKey`: Computed SHA-256 hash
   - `pageUrl`: From request
9. **Updates legacy state fields** (`room.state.provider` and `room.state.episode`) for backward compatibility
10. **Logs episode change event** to room's event log
11. **Broadcasts EPISODE_CHANGE** message to all connected clients
12. **Broadcasts STATE** message to ensure all clients have updated playback state

### Derived Content Key Computation

The `derivedContentKey` is computed using SHA-256 hash to create a unique identifier for the content being watched. This prevents silent desync when clients think they're watching the same content but aren't.

**Computation Process**:

1. **URL Normalization**: Extracts pathname from URL (removes query params and hash for consistency)
2. **Key String Construction**: Creates string: `${providerId}:${normalizedUrl}:${episodeId}`
3. **Hash Computation**: Computes SHA-256 hash of the key string
4. **Error Handling**: Falls back to full URL if URL parsing fails

**Purpose**:

- Prevents silent desync when clients think they're watching the same content but aren't
- Allows lightweight validation without hard-coding provider-specific schemas
- Provides opaque content identity that clients can compare for equality

### State Reset Semantics

Episode changes are **hard resets**:

- **Playback State**: Always reset to `paused = true`, `time = 0`
- **Previous State Invalidated**: All previous playback state is invalidated
- **Drift Logic Suppressed**: Drift reconciliation logic is explicitly reset/suppressed (cooldown window starts)
- **Event ID Incremented**: New event ID ensures proper ordering

**Important**: Episode changes reset playback state even if the room was already paused at time 0. This ensures all clients start from a clean state when an episode changes.

### Content Identity Update

When processing an episode change:

1. **Content Identity Object**: Creates/updates `room.contentIdentity` with:
   - `episodeId`: From request (string or number)
   - `providerId`: From request
   - `derivedContentKey`: Computed SHA-256 hash
   - `pageUrl`: From request

2. **Legacy State Fields**: Updates `room.state.provider` and `room.state.episode` for backward compatibility with older clients

3. **ROOM_STATE Inclusion**: Content identity is included in ROOM_STATE messages sent to clients on JOIN

### Episode Change Broadcasting

After processing an episode change, the server broadcasts two messages:

1. **EPISODE_CHANGE Message**: Contains:
   - `eventId`: Updated event ID for ordering
   - `episodeId`: New episode ID
   - `providerId`: Provider identifier
   - `derivedContentKey`: Computed content key
   - `server_ts`: Server timestamp

2. **STATE Message**: Also broadcasts STATE message to ensure all clients have updated playback state (`paused = true`, `time = 0`)

**Broadcasting Behavior**:

- **All Clients**: All connected clients receive both messages, including the sender
- **Closed Connections**: Gracefully handles closed connections (no errors thrown)
- **Event Ordering**: Both messages include the same `eventId` for ordering

### Error Responses

The EPISODE_CHANGE_REQUEST handler can send the following error responses:

- `NOT_AUTHENTICATED`: EPISODE_CHANGE_REQUEST received before JOIN message
- `INVALID_MESSAGE`: Message validation failed (schema errors)
- `ROOM_NOT_FOUND`: Room doesn't exist or is expired

### Example Flow

1. Client sends EPISODE_CHANGE_REQUEST: `{ type: "EPISODE_CHANGE_REQUEST", episodeId: 6, providerId: "netflix", pageUrl: "https://netflix.com/watch/12345", client_ts: 1670000000000 }`
2. Server validates message
3. Server computes `derivedContentKey` from URL + provider + episode
4. Server resets playback state: `paused = true`, `time = 0`
5. Server updates `room.contentIdentity` with new episode info
6. Server increments `eventId` and updates timestamps
7. Server logs episode change event
8. Server broadcasts EPISODE_CHANGE to all clients
9. Server broadcasts STATE to all clients

## HEARTBEAT Handler

The HEARTBEAT handler processes regular status updates from clients for drift detection. When clients send heartbeats, the server compares their reported playback position with where they should be based on room state. If drift is detected, the server sends a SYNC_ADJUST message to correct it.

### Handler Function

```typescript
handleHeartbeatMessage(
  ws: ExtendedWebSocketWithRateLimit,
  message: unknown,
  roomId: RoomId,
  connectionsByRoom: ConnectionsByRoom
): void
```

### What It Does

When a client sends a HEARTBEAT message, the handler:

1. **Checks authentication** - verifies client has `clientId` (completed JOIN)
2. **Validates message** against HEARTBEAT schema
3. **Validates room** exists and is not expired
4. **Updates client `lastSeen` timestamp** for connection health tracking
5. **Checks cooldown window** - skips drift reconciliation if within cooldown after explicit event
6. **Calculates expected playback time** based on room state (considering paused state and time since last update)
7. **Calculates drift** - difference between expected time and reported `currentPos`
8. **Checks drift threshold** - if drift exceeds threshold, sends SYNC_ADJUST message
9. **Selects sync mode** - chooses `nudge-rate` for small drifts or `seek` for large drifts
10. **Sends SYNC_ADJUST** to the specific client (not broadcast)

### Cooldown Window

After explicit events (EVENT or EPISODE_CHANGE_REQUEST), there's a cooldown window during which drift reconciliation is skipped. This prevents unnecessary corrections immediately after user actions.

- **Purpose**: Avoids correcting drift right after user-initiated events (play/pause/seek)
- **Duration**: Configurable cooldown period after `last_explicit_event_ts`
- **Behavior**: HEARTBEAT messages received during cooldown are processed (lastSeen updated) but drift reconciliation is skipped

### Drift Detection

The handler calculates drift by comparing:

- **Expected Time**: Where the client should be based on room state (paused state, current time, time elapsed)
- **Reported Position**: Where the client says they are (`currentPos` from HEARTBEAT)

If the difference exceeds a threshold (typically a few seconds), drift is detected and correction is needed.

### Sync Adjustment Modes

When drift is detected, the server sends a SYNC_ADJUST message with one of two modes:

- **`nudge-rate`**: For small drifts (typically < 2 seconds). Client should slightly adjust playback rate to gradually catch up or slow down. Provides smooth correction without noticeable jumps.
- **`seek`**: For large drifts (typically >= 2 seconds). Client should immediately seek to the `targetPos`. Provides instant correction when drift is too large for gradual adjustment.

The mode selection is based on the magnitude of the drift.

### Client-Specific Responses

Unlike STATE and EPISODE_CHANGE broadcasts, SYNC_ADJUST messages are sent only to the specific client that sent the HEARTBEAT. This allows per-client drift correction without affecting other clients.

### Error Responses

The HEARTBEAT handler can send the following error responses:

- `NOT_AUTHENTICATED`: HEARTBEAT received before JOIN message
- `INVALID_MESSAGE`: Message validation failed (schema errors)
- `ROOM_NOT_FOUND`: Room doesn't exist or is expired

### Example Flow

1. Client sends HEARTBEAT: `{ type: "HEARTBEAT", currentPos: 120.5, playerState: "playing" }`
2. Server validates message
3. Server checks cooldown window (skips if within cooldown)
4. Server calculates expected time: 125.0 seconds
5. Server calculates drift: 4.5 seconds (client is behind)
6. Server checks threshold: 4.5 seconds exceeds threshold
7. Server selects mode: `seek` (large drift)
8. Server sends SYNC_ADJUST to client: `{ type: "SYNC_ADJUST", serverTime: 1670000000000, targetPos: 125.0, mode: "seek" }`
9. Client receives SYNC_ADJUST and seeks to 125.0 seconds

## Related Documentation

- [WebSocket Implementation Documentation](./WEBSOCKET_IMPLEMENTATION.md) - Server architecture and connection lifecycle
- [WebSocket Types Documentation](./WEBSOCKET_TYPES.md) - Message type definitions and schemas
