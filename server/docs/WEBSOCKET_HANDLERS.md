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

## CLOCK_PING Handler

The CLOCK_PING handler implements NTP-style clock synchronization between clients and the server. This allows the server to track per-client clock offsets and round-trip times (RTT), which are essential for accurate scheduled playback and drift detection.

### Handler Function

```typescript
handleClockPingMessage(
  ws: ExtendedWebSocketWithRateLimit,
  message: unknown,
  roomId: RoomId,
  connectionsByRoom: ConnectionsByRoom
): void
```

### What It Does

When a client sends a CLOCK_PING message, the handler:

1. **Checks authentication** - verifies client has `clientId` (completed JOIN)
2. **Validates message** against CLOCK_PING schema
3. **Validates room** exists and is not expired
4. **Records server receive time** immediately upon message receipt
5. **Records server send time** just before sending response
6. **Calculates estimated RTT** based on server processing time
7. **Sends CLOCK_PONG response** with all four timestamps:
   - `clientSendTime`: From CLOCK_PING message (client timestamp when ping was sent)
   - `serverRecvTime`: Server timestamp when ping was received
   - `serverSendTime`: Server timestamp when pong is being sent
   - `clientRecvTime`: Placeholder (client fills this in when pong is received)
8. **Updates client connection metadata**:
   - `rtt`: Estimated round-trip time (server processing time)
   - `clockOffset`: Estimated clock offset (one-way estimate)
   - `clockSyncTime`: Timestamp when clock sync occurred

### Clock Synchronization Protocol

The CLOCK_PING/CLOCK_PONG protocol follows an NTP-style four-timestamp exchange:

1. **Client sends CLOCK_PING** with `clientSendTime` (T1)
2. **Server receives** and records `serverRecvTime` (T2)
3. **Server sends CLOCK_PONG** with T1, T2, and `serverSendTime` (T3)
4. **Client receives** and records `clientRecvTime` (T4)

The client then calculates:
- **RTT**: `(T4 - T1) - (T3 - T2)` (total time minus server processing time)
- **Clock Offset**: `((T2 - T1) + (T3 - T4)) / 2` (average of forward and reverse path delays)

### Server-Side Tracking

The server tracks clock synchronization metadata on each `ClientConnection`:

- **`clockOffset`**: Estimated clock offset in milliseconds (`serverTime - clientTime`)
  - Initially set to one-way estimate: `serverRecvTime - clientSendTime`
  - Can be refined when client reports final calculation
- **`rtt`**: Round-trip time in milliseconds
  - Initially set to server processing time estimate
  - True RTT requires client to complete the calculation
- **`clockSyncTime`**: Timestamp when clock sync last occurred (for tracking sync freshness)

**Note**: The server's initial estimates are approximations. The true clock offset and RTT require the client to complete the calculation using all four timestamps. The server stores these estimates for monitoring and potential future use in scheduled playback.

### Client Connection Updates

When processing CLOCK_PING:

1. **Updates `lastSeen`**: Marks client as active
2. **Stores estimated RTT**: `client.rtt = serverSendTime - serverRecvTime`
3. **Stores estimated clock offset**: `client.clockOffset = serverRecvTime - clientSendTime`
4. **Records sync time**: `client.clockSyncTime = Date.now()`

### Error Responses

The CLOCK_PING handler can send the following error responses:

- `NOT_AUTHENTICATED`: CLOCK_PING received before JOIN message
- `INVALID_MESSAGE`: Message validation failed (schema errors)
- `ROOM_NOT_FOUND`: Room doesn't exist or is expired

### Usage Pattern

According to the design specification, clients should perform 3-5 ping/pong exchanges on join to establish accurate clock synchronization. This allows:

- **Multiple samples** for better accuracy (averaging reduces noise)
- **RTT measurement** for network condition assessment
- **Clock offset calculation** for scheduled playback timing

### Example Flow

1. Client sends CLOCK_PING: `{ type: "CLOCK_PING", clientSendTime: 1670000000000 }`
2. Server receives at `serverRecvTime: 1670000000010` (10ms later)
3. Server prepares response at `serverSendTime: 1670000000012` (2ms processing)
4. Server sends CLOCK_PONG: `{ type: "CLOCK_PONG", clientSendTime: 1670000000000, serverRecvTime: 1670000000010, serverSendTime: 1670000000012 }`
5. Client receives at `clientRecvTime: 1670000000015` (3ms network delay)
6. Client calculates:
   - RTT: `(1670000000015 - 1670000000000) - (1670000000012 - 1670000000010) = 15 - 2 = 13ms`
   - Clock Offset: `((1670000000010 - 1670000000000) + (1670000000012 - 1670000000015)) / 2 = (10 + (-3)) / 2 = 3.5ms`
7. Server stores estimated values: `rtt: 2ms`, `clockOffset: 10ms`

## BUFFER_START Handler

The BUFFER_START handler processes notifications from clients when playback stalls and buffering begins. When a client is buffering, the server stops attempting to sync that client (skips drift reconciliation) until buffering ends.

### Handler Function

```typescript
handleBufferStartMessage(
  ws: ExtendedWebSocketWithRateLimit,
  message: unknown,
  roomId: RoomId,
  connectionsByRoom: ConnectionsByRoom
): void
```

### What It Does

When a client sends a BUFFER_START message, the handler:

1. **Checks authentication** - verifies client has `clientId` (completed JOIN)
2. **Validates message** against BUFFER_START schema
3. **Validates room** exists and is not expired
4. **Marks client as buffering** by setting `client.isBuffering = true`
5. **Updates `lastSeen` timestamp** for connection health tracking

### Buffering State Management

When a client is marked as buffering:

- **Drift Reconciliation Skipped**: The HEARTBEAT handler checks `client.isBuffering` and skips drift reconciliation if true
- **No SYNC_ADJUST Messages**: The server will not send SYNC_ADJUST messages to buffering clients
- **State Preserved**: Room state and other client metadata remain unchanged

**Purpose**: Buffering clients cannot maintain accurate playback position, so attempting to sync them would be futile and could cause incorrect corrections. The server waits until buffering ends before resuming sync attempts.

### Error Responses

The BUFFER_START handler can send the following error responses:

- `NOT_AUTHENTICATED`: BUFFER_START received before JOIN message
- `INVALID_MESSAGE`: Message validation failed (schema errors)
- `ROOM_NOT_FOUND`: Room doesn't exist or is expired

### Example Flow

1. Client detects playback stall (video element `waiting` event)
2. Client sends BUFFER_START: `{ type: "BUFFER_START", videoPos: 125.5 }`
3. Server validates message
4. Server marks client: `client.isBuffering = true`
5. Server logs: "Client marked as buffering - server will stop syncing this client"
6. Subsequent HEARTBEAT messages from this client are processed but drift reconciliation is skipped

## BUFFER_END Handler

The BUFFER_END handler processes notifications from clients when buffering ends and playback can resume. When buffering ends, the server unmarks the client and sends a ROOM_STATE update to help the client sync up with the current room state.

### Handler Function

```typescript
handleBufferEndMessage(
  ws: ExtendedWebSocketWithRateLimit,
  message: unknown,
  roomId: RoomId,
  connectionsByRoom: ConnectionsByRoom
): void
```

### What It Does

When a client sends a BUFFER_END message, the handler:

1. **Checks authentication** - verifies client has `clientId` (completed JOIN)
2. **Validates message** against BUFFER_END schema
3. **Validates room** exists and is not expired
4. **Unmarks client as buffering** by setting `client.isBuffering = false`
5. **Updates `lastSeen` timestamp** for connection health tracking
6. **Sends ROOM_STATE update** to the client with current room state

### Buffering End Behavior

When buffering ends:

- **Sync Resumed**: The server can resume drift reconciliation for this client
- **State Update Sent**: The server immediately sends a ROOM_STATE message to the client
- **Sync Opportunity**: The ROOM_STATE includes current `videoPos`, `playerState`, and `serverTime`, allowing the client to sync up

**Purpose**: After buffering, the client's playback position may be out of sync with the room state. Sending ROOM_STATE immediately gives the client the authoritative state to sync to, rather than waiting for the next HEARTBEAT cycle.

### ROOM_STATE Update

The ROOM_STATE message sent after BUFFER_END includes:

- **Current playback position** (`videoPos`): Where the room is currently at
- **Player state** (`playerState`): Whether the room is playing or paused
- **Server timestamp** (`server_ts`): For synchronization timing
- **Last event ID** (`lastEventId`): For event ordering
- **Content identity** (if set): Episode and provider information

The client can use this information to:
- Seek to the correct position if needed
- Resume playback if the room is playing
- Sync its clock using the server timestamp

### Error Responses

The BUFFER_END handler can send the following error responses:

- `NOT_AUTHENTICATED`: BUFFER_END received before JOIN message
- `INVALID_MESSAGE`: Message validation failed (schema errors)
- `ROOM_NOT_FOUND`: Room doesn't exist or is expired

### Example Flow

1. Client detects buffering ended (video element `canplay` event)
2. Client sends BUFFER_END: `{ type: "BUFFER_END", videoPos: 125.8 }`
3. Server validates message
4. Server unmarks client: `client.isBuffering = false`
5. Server sends ROOM_STATE to client: `{ type: "ROOM_STATE", clientId: "...", playerState: "playing", videoPos: 130.2, server_ts: 1670000000000, lastEventId: 45 }`
6. Client receives ROOM_STATE and syncs to position 130.2 seconds
7. Subsequent HEARTBEAT messages from this client will resume drift reconciliation

### Integration with HEARTBEAT Handler

The HEARTBEAT handler checks `client.isBuffering` before performing drift reconciliation:

```typescript
if (client.isBuffering) {
  logger.debug('Skipping drift reconciliation: client is buffering');
  return;
}
```

This ensures that:
- Buffering clients are not corrected (they can't maintain accurate position)
- Resources are not wasted on futile sync attempts
- Sync resumes automatically when buffering ends

## Related Documentation

- [WebSocket Implementation Documentation](./WEBSOCKET_IMPLEMENTATION.md) - Server architecture and connection lifecycle
- [WebSocket Types Documentation](./WEBSOCKET_TYPES.md) - Message type definitions and schemas
