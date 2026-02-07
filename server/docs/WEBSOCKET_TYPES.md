# WebSocket Types Documentation

This document describes all WebSocket message types used in the PlaybackSync protocol. All messages are JSON objects validated against JSON Schema definitions.

## Message Format

All WebSocket messages follow this structure:

- **Format**: JSON objects
- **Validation**: JSON Schema validation using `ajv`
- **Schema Location**: `server/schemas/` directory
- **Type Field**: All messages include a `type` field identifying the message type

## Message Categories

Messages are categorized by direction:

- **Client → Server**: Messages sent by clients to the server
- **Server → Client**: Messages sent by the server to clients

## Server State vs Client State

**Important**: The server maintains authoritative playback state that is either `"playing"` or `"paused"`. The server does not track `"buffering"` state because:

- Buffering is a **client-specific condition** (network issues, media loading, device performance, etc.)
- Multiple clients in the same room can have different buffering states simultaneously
- Buffering does not affect the authoritative room playback state (the room is still either playing or paused)

**Server State** (in `PlaybackState`, `StateMessage`, `RoomStateMessage`):
- `playerState`: `"playing"` or `"paused"` only

**Client Buffering Events** (reported via dedicated messages):
- `BUFFER_START`: Sent immediately when playback stalls (buffering begins)
- `BUFFER_END`: Sent immediately when buffering ends and playback can resume
- These messages are sent **immediately** when buffering occurs, not on a periodic schedule

**Client State in HEARTBEAT** (periodic status updates):
- `playerState`: `"playing"`, `"paused"`, or `"buffering"` (client-specific)
- HEARTBEAT messages may include `"buffering"` in `playerState`, but the primary mechanism for reporting buffering events is the dedicated `BUFFER_START`/`BUFFER_END` messages

**Why separate BUFFER_START/BUFFER_END messages?**
- Buffering needs to be reported **immediately** when it happens, not on a periodic heartbeat schedule
- This allows the server to respond quickly to buffering events and make decisions about room state
- HEARTBEAT messages are periodic (e.g., every 5 seconds), which would introduce unacceptable delay for buffering notifications

The server never includes `"buffering"` in its authoritative state broadcasts - buffering is a per-client condition that doesn't affect the room's authoritative playback state.

## Client → Server Messages

### JOIN

Sent when a client wants to join a room. This is the first message that must be sent after establishing a WebSocket connection.

**Important Notes**:

- `roomId` is **not** included in the JOIN message - it is extracted from the WebSocket URL path (`wss://host/{roomId}`)
- `clientId` is **generated server-side** and returned in the `ROOM_STATE` response
- `clientId` can be optionally provided for reconnection scenarios (to reattach to a previous session)

**Schema**: `schemas/join.json`

**TypeScript Interface**:

```typescript
interface JoinMessage {
  type: 'JOIN';
  password: string; // Room password (plaintext)
  clientId?: string; // Optional: Previous client identifier for reconnection (UUID v4 format)
  lastKnownTime?: number; // Optional: Last known playback time (seconds)
}
```

**Required Fields**:

- `type`: Must be `"JOIN"`
- `password`: Room password (plaintext, validated against hash)

**Optional Fields**:

- `clientId`: Previous client identifier for reconnection (received from previous `ROOM_STATE`). If provided, must match UUID v4 pattern
- `lastKnownTime`: Last known playback time in seconds (for drift detection)

**Validation Rules**:

- `password` must be non-empty string
- `clientId` must match UUID v4 pattern if provided: `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`
- `lastKnownTime` must be >= 0 if provided

**Example (First Connection)**:

```json
{
  "type": "JOIN",
  "password": "test-password-123",
  "lastKnownTime": 12.345
}
```

**Example (Reconnection)**:

```json
{
  "type": "JOIN",
  "password": "test-password-123",
  "clientId": "123e4567-e89b-12d3-a456-426614174001",
  "lastKnownTime": 12.345
}
```

**Response**: Server sends `ROOM_STATE` (with server-generated `clientId`) or `ERROR` message

---

### EVENT

Sent by clients for explicit playback control events (play, pause, seek).

**Schema**: `schemas/event.json`

**TypeScript Interface**:

```typescript
interface EventMessage {
  type: 'EVENT';
  event: 'play' | 'pause' | 'seek';
  value?: number; // Required for 'seek' events (seconds)
  client_ts: number; // Client timestamp (monotonic or epoch ms)
}
```

**Required Fields**:

- `type`: Must be `"EVENT"`
- `event`: Event type (`"play"`, `"pause"`, or `"seek"`)
- `client_ts`: Client timestamp (monotonic or epoch milliseconds)

**Conditional Fields**:

- `value`: Required when `event` is `"seek"`, must be >= 0 (seconds)

**Validation Rules**:

- `event` must be one of: `"play"`, `"pause"`, `"seek"`
- `value` is required if `event === "seek"`
- `value` must be >= 0 if provided
- `client_ts` must be a number

**Examples**:

Play event:

```json
{
  "type": "EVENT",
  "event": "play",
  "client_ts": 1670000000000
}
```

Pause event:

```json
{
  "type": "EVENT",
  "event": "pause",
  "client_ts": 1670000000000
}
```

Seek event:

```json
{
  "type": "EVENT",
  "event": "seek",
  "value": 123.456,
  "client_ts": 1670000000000
}
```

**Response**: Server broadcasts `STATE` message to all clients in the room

---

### EPISODE_CHANGE_REQUEST

Sent by clients to request changing the episode being watched. Episode changes are treated as **hard resets** that invalidate all previous playback state.

**Schema**: `schemas/episode-change-request.json`

**TypeScript Interface**:

```typescript
interface EpisodeChangeRequestMessage {
  type: 'EPISODE_CHANGE_REQUEST';
  episodeId: string | number;
  providerId: string;
  pageUrl: string;
  client_ts: number;
}
```

**Required Fields**:

- `type`: Must be `"EPISODE_CHANGE_REQUEST"`
- `episodeId`: Episode ID or episode number (string or number)
- `providerId`: Provider identifier (non-empty string)
- `pageUrl`: Page URL (non-empty string)
- `client_ts`: Client timestamp (monotonic or epoch ms)

**Validation Rules**:

- `episodeId` can be string or number
- `providerId` must be non-empty string
- `pageUrl` must be non-empty string
- `client_ts` must be a number

**Example**:

```json
{
  "type": "EPISODE_CHANGE_REQUEST",
  "episodeId": 5,
  "providerId": "netflix",
  "pageUrl": "https://netflix.com/watch/12345",
  "client_ts": 1670000000000
}
```

**Example with String Episode ID**:

```json
{
  "type": "EPISODE_CHANGE_REQUEST",
  "episodeId": "episode-5",
  "providerId": "netflix",
  "pageUrl": "https://netflix.com/watch/12345",
  "client_ts": 1670000000000
}
```

**Server Processing**:

1. Validates message schema
2. Verifies client is authenticated (must have completed JOIN)
3. Computes `derivedContentKey` from URL + provider + episode (SHA-256 hash)
4. Increments `eventId` for ordering
5. Resets playback state: `playerState = 'paused'`, `videoPos = 0`
6. Updates room content identity with new episode metadata
7. Broadcasts `EPISODE_CHANGE` message to all clients
8. Broadcasts `STATE` message to ensure all clients have updated playback state

**Response**: Server broadcasts `EPISODE_CHANGE` message to all clients, followed by a `STATE` message

**Error Responses**:

- `NOT_AUTHENTICATED`: Message received before JOIN authentication
- `INVALID_MESSAGE`: Message validation failed (schema errors)
- `ROOM_NOT_FOUND`: Room doesn't exist or is expired

---

### HEARTBEAT

Sent by clients at regular intervals to report their current playback status. The server uses these messages to detect when clients drift out of sync and automatically corrects them.

Think of heartbeats like a "check-in" message - clients send them periodically to let the server know where they are in the video and what state their player is in. If the server notices a client is drifting behind or ahead, it sends a `SYNC_ADJUST` message to bring them back in sync.

**Schema**: `schemas/heartbeat.json`

**TypeScript Interface**:

```typescript
interface HeartbeatMessage {
  type: 'HEARTBEAT';
  currentPos: number; // Current playback position reported by client (seconds)
  playerState: 'playing' | 'paused' | 'buffering'; // Current player state
  clockSample?: number; // Optional clock sample for clock synchronization (client timestamp)
}
```

**Required Fields**:

- `type`: Must be `"HEARTBEAT"`
- `currentPos`: Current playback position in seconds (>= 0)
- `playerState`: Current player state - must be one of `"playing"`, `"paused"`, or `"buffering"`

**Optional Fields**:

- `clockSample`: Optional clock sample for clock synchronization (client timestamp)

**Validation Rules**:

- `currentPos` must be >= 0
- `playerState` must be one of: `"playing"`, `"paused"`, `"buffering"`
- `clockSample` must be a number if provided

**Example (Playing)**:

```json
{
  "type": "HEARTBEAT",
  "currentPos": 123.456,
  "playerState": "playing",
  "clockSample": 1670000000000
}
```

**Example (Paused)**:

```json
{
  "type": "HEARTBEAT",
  "currentPos": 123.456,
  "playerState": "paused"
}
```

**Example (Buffering)**:

```json
{
  "type": "HEARTBEAT",
  "currentPos": 123.456,
  "playerState": "buffering"
}
```

**Server Processing**:

1. Updates the client's `lastSeen` timestamp
2. Skips drift reconciliation if within a cooldown window after an explicit event (like play/pause/seek)
3. Calculates the expected playback time based on room state
4. Compares expected time with reported `currentPos` to detect drift
5. If drift exceeds threshold, sends `SYNC_ADJUST` message to correct it

**Drift Reconciliation**: The server uses HEARTBEAT messages for drift detection and reconciliation. Clients send HEARTBEAT messages periodically, and the server automatically detects when clients drift out of sync and sends SYNC_ADJUST messages to correct them. The server does not request TIME_REPORT messages - all drift reconciliation is handled through HEARTBEAT messages.

**Response**: Server may send `SYNC_ADJUST` message if drift is detected, or no response if client is in sync

**Error Responses**:

- `NOT_AUTHENTICATED`: HEARTBEAT received before JOIN authentication
- `INVALID_MESSAGE`: Message validation failed (schema errors)
- `ROOM_NOT_FOUND`: Room doesn't exist or is expired

---

### CLOCK_PING

Sent by clients for clock synchronization using an NTP-style protocol. This message is used to calculate per-client clock offset and round-trip time (RTT), which are essential for accurate scheduled playback and drift detection.

**Schema**: `schemas/clock-ping.json`

**TypeScript Interface**:

```typescript
interface ClockPingMessage {
  type: 'CLOCK_PING';
  clientSendTime: number; // Client timestamp when ping was sent (epoch ms)
}
```

**Required Fields**:

- `type`: Must be `"CLOCK_PING"`
- `clientSendTime`: Client timestamp when ping was sent (epoch milliseconds, >= 0)

**Validation Rules**:

- `clientSendTime` must be >= 0
- `clientSendTime` must be a number

**Example**:

```json
{
  "type": "CLOCK_PING",
  "clientSendTime": 1670000000000
}
```

**Server Processing**:

1. Records server receive time immediately upon message receipt
2. Records server send time just before sending response
3. Calculates estimated RTT based on server processing time
4. Sends CLOCK_PONG response with all four timestamps
5. Updates client connection metadata:
   - `rtt`: Estimated round-trip time
   - `clockOffset`: Estimated clock offset (one-way estimate)
   - `clockSyncTime`: Timestamp when clock sync occurred

**Clock Synchronization Protocol**:

The CLOCK_PING/CLOCK_PONG protocol follows an NTP-style four-timestamp exchange:

1. **Client sends CLOCK_PING** with `clientSendTime` (T1)
2. **Server receives** and records `serverRecvTime` (T2)
3. **Server sends CLOCK_PONG** with T1, T2, and `serverSendTime` (T3)
4. **Client receives** and records `clientRecvTime` (T4)

The client then calculates:
- **RTT**: `(T4 - T1) - (T3 - T2)` (total time minus server processing time)
- **Clock Offset**: `((T2 - T1) + (T3 - T4)) / 2` (average of forward and reverse path delays)

**Usage Pattern**:

According to the design specification, clients should perform 3-5 ping/pong exchanges on join to establish accurate clock synchronization. This allows:
- Multiple samples for better accuracy (averaging reduces noise)
- RTT measurement for network condition assessment
- Clock offset calculation for scheduled playback timing

**Response**: Server sends `CLOCK_PONG` message with all four timestamps

**Error Responses**:

- `NOT_AUTHENTICATED`: CLOCK_PING received before JOIN authentication
- `INVALID_MESSAGE`: Message validation failed (schema errors)
- `ROOM_NOT_FOUND`: Room doesn't exist or is expired

---

### BUFFER_START

Sent by clients **immediately** when playback stalls and buffering begins. This is a high-priority message that must be sent as soon as buffering is detected, not on a periodic schedule.

**Why separate from HEARTBEAT?**
- Buffering needs to be reported **immediately** when it happens, not on a periodic heartbeat schedule (e.g., every 5 seconds)
- This allows the server to respond quickly to buffering events and make decisions about room state
- HEARTBEAT messages are periodic and would introduce unacceptable delay for buffering notifications

**TypeScript Interface**:

```typescript
interface BufferStartMessage {
  type: 'BUFFER_START';
  videoPos: number; // Current playback position when buffering started (seconds)
}
```

**Required Fields**:

- `type`: Must be `"BUFFER_START"`
- `videoPos`: Current playback position in seconds (>= 0) when buffering started

**Example**:

```json
{
  "type": "BUFFER_START",
  "videoPos": 123.456
}
```

**Server Processing**:

1. Marks the client as buffering by setting `client.isBuffering = true`
2. Updates client's `lastSeen` timestamp for connection health tracking
3. Server stops drift reconciliation for this client (skips SYNC_ADJUST messages)
4. Room continues playback for other clients (does not pause the entire room)

**Buffering State Management**:

When a client is marked as buffering:
- **Drift Reconciliation Skipped**: The HEARTBEAT handler checks `client.isBuffering` and skips drift reconciliation if true
- **No SYNC_ADJUST Messages**: The server will not send SYNC_ADJUST messages to buffering clients
- **State Preserved**: Room state and other client metadata remain unchanged

**Purpose**: Buffering clients cannot maintain accurate playback position, so attempting to sync them would be futile and could cause incorrect corrections. The server waits until buffering ends before resuming sync attempts.

**Priority**: High-medium priority - buffering events are important but should not block control events

---

### BUFFER_END

Sent by clients **immediately** when buffering ends and playback can resume. This is a high-priority message that must be sent as soon as buffering ends.

**TypeScript Interface**:

```typescript
interface BufferEndMessage {
  type: 'BUFFER_END';
  videoPos: number; // Current playback position when buffering ended (seconds)
}
```

**Required Fields**:

- `type`: Must be `"BUFFER_END"`
- `videoPos`: Current playback position in seconds (>= 0) when buffering ended

**Example**:

```json
{
  "type": "BUFFER_END",
  "videoPos": 125.789
}
```

**Server Processing**:

1. Unmarks client as buffering by setting `client.isBuffering = false`
2. Updates client's `lastSeen` timestamp for connection health tracking
3. Sends ROOM_STATE update to the client with current room state
4. Server can resume drift reconciliation for this client

**Buffering End Behavior**:

When buffering ends:
- **Sync Resumed**: The server can resume drift reconciliation for this client
- **State Update Sent**: The server immediately sends a ROOM_STATE message to the client
- **Sync Opportunity**: The ROOM_STATE includes current `videoPos`, `playerState`, and `serverTime`, allowing the client to sync up

**Purpose**: After buffering, the client's playback position may be out of sync with the room state. Sending ROOM_STATE immediately gives the client the authoritative state to sync to, rather than waiting for the next HEARTBEAT cycle.

**Priority**: High-medium priority - buffering events are important but should not block control events

**Important**: Both `BUFFER_START` and `BUFFER_END` are sent **immediately** when buffering occurs, not on a periodic schedule. This ensures the server can respond quickly to buffering events.

---

## Server → Client Messages

### CLOCK_PONG

Sent by the server in response to CLOCK_PING messages. This message contains all four timestamps needed for the client to calculate clock offset and round-trip time (RTT).

**Schema**: `schemas/clock-pong.json`

**TypeScript Interface**:

```typescript
interface ClockPongMessage {
  type: 'CLOCK_PONG';
  clientSendTime: number; // Client timestamp when ping was sent (from CLOCK_PING)
  serverRecvTime: number; // Server timestamp when ping was received (epoch ms)
  serverSendTime: number; // Server timestamp when pong is being sent (epoch ms)
  clientRecvTime?: number; // Client timestamp when pong is received (epoch ms, filled in by client)
}
```

**Required Fields**:

- `type`: Must be `"CLOCK_PONG"`
- `clientSendTime`: Client timestamp when ping was sent (from CLOCK_PING message)
- `serverRecvTime`: Server timestamp when ping was received (epoch milliseconds, >= 0)
- `serverSendTime`: Server timestamp when pong is being sent (epoch milliseconds, >= 0)

**Optional Fields**:

- `clientRecvTime`: Client timestamp when pong is received (epoch milliseconds, filled in by client when received)

**Validation Rules**:

- `clientSendTime` must be >= 0
- `serverRecvTime` must be >= 0
- `serverSendTime` must be >= 0
- `clientRecvTime` must be >= 0 if provided

**Example**:

```json
{
  "type": "CLOCK_PONG",
  "clientSendTime": 1670000000000,
  "serverRecvTime": 1670000000010,
  "serverSendTime": 1670000000012
}
```

**Client Processing**:

When the client receives CLOCK_PONG, it should:

1. Record `clientRecvTime` (T4) when the message is received
2. Calculate RTT: `(clientRecvTime - clientSendTime) - (serverSendTime - serverRecvTime)`
3. Calculate clock offset: `((serverRecvTime - clientSendTime) + (serverSendTime - clientRecvTime)) / 2`
4. Use these values for scheduled playback timing and drift detection

**Clock Synchronization**:

The four timestamps enable accurate clock synchronization:
- **T1** (`clientSendTime`): When client sent ping
- **T2** (`serverRecvTime`): When server received ping
- **T3** (`serverSendTime`): When server sent pong
- **T4** (`clientRecvTime`): When client receives pong (filled in by client)

**When Sent**:

- Immediately after receiving a CLOCK_PING message
- Sent only to the client that sent the CLOCK_PING (not broadcast)

---

### STATE

Authoritative playback state broadcast sent by the server to all clients in a room.

**Schema**: `schemas/state.json`

**TypeScript Interface**:

```typescript
interface StateMessage {
  type: 'STATE';
  playerState: 'playing' | 'paused'; // Server state: either playing or paused. Buffering is client-specific.
  videoPos: number; // Current playback position in seconds
  provider?: string; // Optional provider identifier
  episode?: number; // Optional episode number
  server_ts: number; // Server timestamp
  eventId: number; // Event ID for ordering
}
```

**Required Fields**:

- `type`: Must be `"STATE"`
- `playerState`: Current player state - either `"playing"` or `"paused"`. Note: Server state is always either playing or paused. Only individual clients can be buffering (reported via `BUFFER_START`/`BUFFER_END` messages).
- `videoPos`: Current playback position in seconds (>= 0)
- `server_ts`: Server timestamp (monotonic or epoch milliseconds)
- `eventId`: Event ID for ordering (integer >= 0)

**Optional Fields**:

- `provider`: Provider identifier
- `episode`: Episode number or identifier

**Validation Rules**:

- `playerState` must be either `"playing"` or `"paused"` (not `"buffering"` - that's client-specific)
- `videoPos` must be >= 0
- `eventId` must be integer >= 0
- `server_ts` must be a number

**Important Note**: Server state only tracks `"playing"` or `"paused"`. The `"buffering"` state is client-specific and is reported by clients via `BUFFER_START`/`BUFFER_END` messages (sent immediately when buffering occurs). The server does not maintain buffering state because buffering is a per-client condition (network issues, media loading, etc.) that doesn't affect the authoritative room state.

**Example**:

```json
{
  "type": "STATE",
  "playerState": "playing",
  "videoPos": 123.456,
  "provider": "netflix",
  "episode": 5,
  "server_ts": 1670000000000,
  "eventId": 42
}
```

**When Sent**:

- After every explicit event (EVENT, EPISODE_CHANGE_REQUEST)
- On client JOIN (as part of ROOM_STATE)
- Not sent during drift reconciliation (drift correction uses SYNC_ADJUST instead)

---

### ROOM_STATE

Sent to clients on JOIN/REJOIN with full room state. Includes the server-generated `clientId` that clients should use for reconnection.

**TypeScript Interface**:

```typescript
interface RoomStateMessage {
  type: 'ROOM_STATE';
  clientId: string; // Server-generated client identifier (UUID v4) - use for reconnection
  playerState: 'playing' | 'paused'; // Server state: either playing or paused. Buffering is client-specific.
  videoPos: number; // Current playback position in seconds
  episodeId?: string | number;
  providerId?: string;
  derivedContentKey?: string;
  lastEventId: number;
  server_ts: number;
  recentEvents?: Array<{
    type: string; // Event type (e.g., 'play', 'pause', 'seek', 'episode_change')
    value?: number | string; // Optional event value (e.g., seek position in seconds)
    clientId?: string; // Client ID that triggered the event
    ts: number; // Timestamp when event occurred (milliseconds)
    eventId: number; // Event ID for ordering
  }>;
}
```

**Required Fields**:

- `type`: Must be `"ROOM_STATE"`
- `clientId`: Server-generated client identifier (UUID v4 format). Clients should store this and include it in subsequent JOIN messages for reconnection
- `playerState`: Current player state - either `"playing"` or `"paused"`. Note: Server state is always either playing or paused. Only individual clients can be buffering (reported via `BUFFER_START`/`BUFFER_END` messages).
- `videoPos`: Current playback position in seconds (>= 0)
- `lastEventId`: Last event ID (integer)
- `server_ts`: Server timestamp (monotonic or epoch ms)

**Optional Fields**:

- `episodeId`: Episode ID (string or number)
- `providerId`: Provider identifier
- `derivedContentKey`: Derived content key for content identity
- `recentEvents`: Array of events that occurred since the client's last known `eventId` (only included for reconnections with valid tombstone)

**Important Note**: Server state only tracks `"playing"` or `"paused"`. The `"buffering"` state is client-specific and is reported by clients via `BUFFER_START`/`BUFFER_END` messages (sent immediately when buffering occurs). The server does not maintain buffering state because buffering is a per-client condition (network issues, media loading, etc.) that doesn't affect the authoritative room state.

**Example (First Connection)**:

```json
{
  "type": "ROOM_STATE",
  "clientId": "123e4567-e89b-12d3-a456-426614174001",
  "playerState": "playing",
  "videoPos": 123.456,
  "episodeId": 5,
  "providerId": "netflix",
  "derivedContentKey": "netflix:12345:ep5",
  "lastEventId": 42,
  "server_ts": 1670000000000
}
```

**Example (Reconnection with Event Replay)**:

```json
{
  "type": "ROOM_STATE",
  "clientId": "123e4567-e89b-12d3-a456-426614174001",
  "paused": false,
  "time": 125.789,
  "episodeId": 5,
  "providerId": "netflix",
  "derivedContentKey": "netflix:12345:ep5",
  "lastEventId": 45,
  "server_ts": 1670000001000,
  "recentEvents": [
    {
      "type": "seek",
      "value": 120.0,
      "clientId": "456e7890-e89b-12d3-a456-426614174002",
      "ts": 1670000000500,
      "eventId": 43
    },
    {
      "type": "play",
      "clientId": "456e7890-e89b-12d3-a456-426614174002",
      "ts": 1670000000600,
      "eventId": 44
    },
    {
      "type": "pause",
      "clientId": "789e0123-e89b-12d3-a456-426614174003",
      "ts": 1670000000800,
      "eventId": 45
    }
  ]
}
```

**Reconnection**: To reconnect with the same client identity, include the `clientId` from a previous `ROOM_STATE` in your `JOIN` message. This allows the server to reattach your connection if you disconnect and reconnect within the tombstone window (default: 30 seconds).

**Event Replay**: For reconnections with a valid tombstone, the server includes a `recentEvents` array containing events that occurred since the client's last known `eventId`. This allows clients to replay missed events and catch up to the current state.

---

### EPISODE_CHANGE

Authoritative episode change broadcast sent to all clients in a room. This message is sent after processing an `EPISODE_CHANGE_REQUEST` and indicates that the room's content identity has changed.

**TypeScript Interface**:

```typescript
interface EpisodeChangeMessage {
  type: 'EPISODE_CHANGE';
  eventId: number;
  episodeId: string | number;
  providerId: string;
  derivedContentKey: string;
  server_ts: number;
}
```

**Required Fields**:

- `type`: Must be `"EPISODE_CHANGE"`
- `eventId`: Event ID for ordering (integer) - matches the updated room state eventId
- `episodeId`: Episode ID (string or number) - the new episode being watched
- `providerId`: Provider identifier - the streaming provider
- `derivedContentKey`: Derived content key - SHA-256 hash computed from URL + provider + episode
- `server_ts`: Server timestamp (monotonic or epoch ms) - when the episode change was processed

**Derived Content Key**:

The `derivedContentKey` is computed server-side using SHA-256 hash of the format:

```
SHA256(providerId:normalizedUrl:episodeId)
```

Where:

- `providerId`: Provider identifier from the request
- `normalizedUrl`: URL pathname (query params and hash removed)
- `episodeId`: Episode ID from the request

**Example**:

```json
{
  "type": "EPISODE_CHANGE",
  "eventId": 43,
  "episodeId": 6,
  "providerId": "netflix",
  "derivedContentKey": "37d23e8195997b2fc5fd295840776e6ac6baae6f015c3f025c5d136ae6c28186",
  "server_ts": 1670000001000
}
```

**Example with String Episode ID**:

```json
{
  "type": "EPISODE_CHANGE",
  "eventId": 44,
  "episodeId": "episode-7",
  "providerId": "hulu",
  "derivedContentKey": "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6a7b8c9d0e1f2",
  "server_ts": 1670000002000
}
```

**When Sent**:

- After processing an `EPISODE_CHANGE_REQUEST` message
- Broadcast to all connected clients in the room (including the sender)
- Always followed by a `STATE` message with updated playback state (`paused = true`, `time = 0`)

**Client Behavior**:

Clients should:

1. Compare `derivedContentKey` with their local derivation
2. If match: Load episode if not already loaded, seek to 0, pause
3. If mismatch: Enter "out-of-sync content" state, surface UI warning, refuse to apply play/seek events

**Important**: Episode changes reset playback state. All clients should pause and seek to 0 when receiving this message.

---

### SYNC_ADJUST

Sent by the server to a specific client when drift is detected. This message tells the client how to correct their playback position to stay in sync with the room.

When clients send `HEARTBEAT` messages, the server compares their reported position with where they should be. If there's a significant difference (drift), the server sends this message to correct it. For small drifts, the server uses "nudge-rate" mode which slightly adjusts playback speed. For large drifts, it uses "seek" mode which jumps directly to the correct position.

**Schema**: `schemas/sync-adjust.json`

**TypeScript Interface**:

```typescript
interface SyncAdjustMessage {
  type: 'SYNC_ADJUST';
  serverTime: number; // Server timestamp (monotonic or epoch ms)
  targetPos: number; // Target playback position to sync to (seconds)
  mode: 'nudge-rate' | 'seek'; // Sync adjustment mode
}
```

**Required Fields**:

- `type`: Must be `"SYNC_ADJUST"`
- `serverTime`: Server timestamp (monotonic or epoch milliseconds)
- `targetPos`: Target playback position to sync to in seconds (>= 0)
- `mode`: Sync adjustment mode - either `"nudge-rate"` for small corrections or `"seek"` for large corrections

**Validation Rules**:

- `targetPos` must be >= 0
- `mode` must be one of: `"nudge-rate"`, `"seek"`
- `serverTime` must be a number

**Sync Modes**:

- **`nudge-rate`**: For small drifts (typically < 2 seconds). The client should slightly adjust playback rate to gradually catch up or slow down to the target position. This provides smooth correction without noticeable jumps.
- **`seek`**: For large drifts (typically >= 2 seconds). The client should immediately seek to the `targetPos`. This provides instant correction when the drift is too large for gradual adjustment.

**Example (Nudge Rate Mode)**:

```json
{
  "type": "SYNC_ADJUST",
  "serverTime": 1670000000000,
  "targetPos": 125.5,
  "mode": "nudge-rate"
}
```

**Example (Seek Mode)**:

```json
{
  "type": "SYNC_ADJUST",
  "serverTime": 1670000000000,
  "targetPos": 130.0,
  "mode": "seek"
}
```

**When Sent**:

- After processing a `HEARTBEAT` message that shows significant drift
- Only sent to the specific client that sent the HEARTBEAT (not broadcast to all clients)
- Not sent during cooldown periods after explicit events (play/pause/seek)

**Client Behavior**:

Clients should:

1. Receive `SYNC_ADJUST` message
2. If `mode === "nudge-rate"`: Gradually adjust playback rate to reach `targetPos`
3. If `mode === "seek"`: Immediately seek to `targetPos`
4. Continue normal playback after correction

---

### ERROR

Error response sent for various failure scenarios.

**Schema**: `schemas/error.json`

**TypeScript Interface**:

```typescript
interface ErrorMessage {
  type: 'ERROR';
  code: string; // Error code
  message: string; // Human-readable error message
  server_ts?: number; // Optional server timestamp
}
```

**Required Fields**:

- `type`: Must be `"ERROR"`
- `code`: Error code (non-empty string)
- `message`: Human-readable error message (non-empty string)

**Optional Fields**:

- `server_ts`: Server timestamp

**Common Error Codes**:

- `AUTH_FAILED`: Authentication failed (invalid room ID or password)
- `NOT_AUTHENTICATED`: Message received before JOIN authentication
- `INVALID_MESSAGE`: Message validation failed (schema validation errors)
- `RATE_LIMITED`: Rate limit exceeded
- `ROOM_NOT_FOUND`: Room doesn't exist or is expired
- `PROCESSING_FAILED`: Error processing message

**Validation Rules**:

- `code` must be non-empty string
- `message` must be non-empty string

**Examples**:

Authentication failed:

```json
{
  "type": "ERROR",
  "code": "AUTH_FAILED",
  "message": "Invalid room or password",
  "server_ts": 1670000000000
}
```

Invalid message:

```json
{
  "type": "ERROR",
  "code": "INVALID_MESSAGE",
  "message": "Message validation failed: /roomId: must match pattern \"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$\"",
  "server_ts": 1670000000000
}
```

Rate limited:

```json
{
  "type": "ERROR",
  "code": "RATE_LIMITED",
  "message": "Rate limit exceeded. Please wait before sending more messages.",
  "server_ts": 1670000000000
}
```

---

## Type Unions

### ClientToServerMessage

Union type of all client-to-server messages:

```typescript
type ClientToServerMessage =
  | JoinMessage
  | EventMessage
  | EpisodeChangeRequestMessage
  | HeartbeatMessage
  | ClockPingMessage
  | BufferStartMessage
  | BufferEndMessage;
```

### ServerToClientMessage

Union type of all server-to-client messages:

```typescript
type ServerToClientMessage =
  | StateMessage
  | RoomStateMessage
  | SyncAdjustMessage
  | EpisodeChangeMessage
  | ErrorMessage
  | ClockPongMessage;
```

### WebSocketMessage

Union type of all WebSocket messages:

```typescript
type WebSocketMessage = ClientToServerMessage | ServerToClientMessage;
```

## Message Validation

All messages are validated against JSON Schema definitions:

- **Schema Location**: `server/schemas/` directory
- **Validation Library**: `ajv` (Another JSON Schema Validator)
- **Validation Utility**: `src/utils/validation.ts`

### Validation Process

1. **Parse JSON**: Convert raw message to JavaScript object
2. **Identify Type**: Extract `type` field from message
3. **Load Schema**: Load corresponding schema from `schemas/` directory
4. **Validate**: Use ajv compiled validator to validate message
5. **Handle Errors**: Return validation errors if invalid

### Validation Errors

Invalid messages result in:

- **ERROR Message**: Sent to client with error details
- **Error Format**: Includes field path and error message
- **Connection Handling**: Connection may be closed for severe errors

Example validation error response:

```json
{
  "type": "ERROR",
  "code": "INVALID_MESSAGE",
  "message": "/roomId: must match pattern \"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$\"",
  "server_ts": 1670000000000
}
```

## Timestamps

### Client Timestamps (`client_ts`)

- **Format**: Number (monotonic or epoch milliseconds)
- **Purpose**: Used for ordering events and drift detection
- **Validation**: Must be a number

### Server Timestamps (`server_ts`)

- **Format**: Number (monotonic or epoch milliseconds)
- **Purpose**: Authoritative timestamp for state synchronization
- **Validation**: Must be a number

**Note**: Timestamps can be either monotonic (relative) or epoch milliseconds (absolute). The server accepts both formats.

## Field Naming Conventions

- **camelCase**: Used for most fields (e.g., `roomId`, `clientId`, `lastKnownTime`)
- **snake_case**: Used for timestamp fields (e.g., `client_ts`, `server_ts`)
- **UPPER_CASE**: Used for message type constants (e.g., `"JOIN"`, `"EVENT"`)

## Related Documentation

- [WebSocket Implementation Documentation](./WEBSOCKET_IMPLEMENTATION.md) - Server implementation details
- [Rooms API Documentation](./ROOMS_API.md) - HTTP API for room management
