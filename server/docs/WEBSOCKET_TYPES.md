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

Sent by clients to request changing the episode being watched.

**Schema**: `schemas/episode-change-request.json`

**TypeScript Interface**:

```typescript
interface EpisodeChangeRequestMessage {
  type: 'EPISODE_CHANGE_REQUEST';
  episodeId: string | number;
  providerId: string;
  pageUrl: string;
  clientTime: number;
}
```

**Required Fields**:

- `type`: Must be `"EPISODE_CHANGE_REQUEST"`
- `episodeId`: Episode ID or episode number (string or number)
- `providerId`: Provider identifier (non-empty string)
- `pageUrl`: Page URL (non-empty string)
- `clientTime`: Client timestamp

**Validation Rules**:

- `episodeId` can be string or number
- `providerId` must be non-empty string
- `pageUrl` must be non-empty string
- `clientTime` must be a number

**Example**:

```json
{
  "type": "EPISODE_CHANGE_REQUEST",
  "episodeId": 5,
  "providerId": "netflix",
  "pageUrl": "https://netflix.com/watch/12345",
  "clientTime": 1670000000000
}
```

**Response**: Server broadcasts `EPISODE_CHANGE` message to all clients

---

### TIME_REPORT

Sent by clients in response to drift reconciliation requests from the server.

**Schema**: `schemas/time-report.json`

**TypeScript Interface**:

```typescript
interface TimeReportMessage {
  type: 'TIME_REPORT';
  current_time: number; // Current playback time (seconds)
  client_ts: number; // Client timestamp
}
```

**Required Fields**:

- `type`: Must be `"TIME_REPORT"`
- `current_time`: Current playback time in seconds (>= 0)
- `client_ts`: Client timestamp

**Validation Rules**:

- `current_time` must be >= 0
- `client_ts` must be a number

**Example**:

```json
{
  "type": "TIME_REPORT",
  "current_time": 123.456,
  "client_ts": 1670000000000
}
```

**Response**: Server uses this for drift reconciliation calculations

---

## Server → Client Messages

### STATE

Authoritative playback state broadcast sent by the server to all clients in a room.

**Schema**: `schemas/state.json`

**TypeScript Interface**:

```typescript
interface StateMessage {
  type: 'STATE';
  paused: boolean;
  time: number; // Current playback time (seconds)
  provider?: string; // Optional provider identifier
  episode?: number; // Optional episode number
  server_ts: number; // Server timestamp
  eventId: number; // Event ID for ordering
}
```

**Required Fields**:

- `type`: Must be `"STATE"`
- `paused`: Whether playback is paused (boolean)
- `time`: Current playback time in seconds (>= 0)
- `server_ts`: Server timestamp (monotonic or epoch milliseconds)
- `eventId`: Event ID for ordering (integer >= 0)

**Optional Fields**:

- `provider`: Provider identifier
- `episode`: Episode number or identifier

**Validation Rules**:

- `paused` must be boolean
- `time` must be >= 0
- `eventId` must be integer >= 0
- `server_ts` must be a number

**Example**:

```json
{
  "type": "STATE",
  "paused": false,
  "time": 123.456,
  "provider": "netflix",
  "episode": 5,
  "server_ts": 1670000000000,
  "eventId": 42
}
```

**When Sent**:

- After every explicit event (EVENT, EPISODE_CHANGE)
- During drift reconciliation
- On client JOIN (as part of ROOM_STATE)

---

### ROOM_STATE

Sent to clients on JOIN/REJOIN with full room state. Includes the server-generated `clientId` that clients should use for reconnection.

**TypeScript Interface**:

```typescript
interface RoomStateMessage {
  type: 'ROOM_STATE';
  clientId: string; // Server-generated client identifier (UUID v4) - use for reconnection
  paused: boolean;
  time: number;
  episodeId?: string | number;
  providerId?: string;
  derivedContentKey?: string;
  lastEventId: number;
  serverTime: number;
}
```

**Required Fields**:

- `type`: Must be `"ROOM_STATE"`
- `clientId`: Server-generated client identifier (UUID v4 format). Clients should store this and include it in subsequent JOIN messages for reconnection
- `paused`: Playback state (boolean)
- `time`: Current playback time (seconds)
- `lastEventId`: Last event ID (integer)
- `serverTime`: Server timestamp

**Optional Fields**:

- `episodeId`: Episode ID (string or number)
- `providerId`: Provider identifier
- `derivedContentKey`: Derived content key for content identity

**Example**:

```json
{
  "type": "ROOM_STATE",
  "clientId": "123e4567-e89b-12d3-a456-426614174001",
  "paused": false,
  "time": 123.456,
  "episodeId": 5,
  "providerId": "netflix",
  "derivedContentKey": "netflix:12345:ep5",
  "lastEventId": 42,
  "serverTime": 1670000000000
}
```

**Reconnection**: To reconnect with the same client identity, include the `clientId` from a previous `ROOM_STATE` in your `JOIN` message. This allows the server to reattach your connection if you disconnect and reconnect within the tombstone window (default: 30 seconds).

---

### COMMAND

Server-initiated action command sent to clients.

**Schema**: `schemas/command.json`

**TypeScript Interface**:

```typescript
interface CommandMessage {
  type: 'COMMAND';
  cmd: 'seek' | 'play' | 'pause';
  value?: number; // Required for 'seek' commands (seconds)
  server_ts?: number; // Optional server timestamp
}
```

**Required Fields**:

- `type`: Must be `"COMMAND"`
- `cmd`: Command type (`"seek"`, `"play"`, or `"pause"`)

**Conditional Fields**:

- `value`: Required when `cmd` is `"seek"`, must be >= 0 (seconds)

**Optional Fields**:

- `server_ts`: Server timestamp

**Validation Rules**:

- `cmd` must be one of: `"seek"`, `"play"`, `"pause"`
- `value` is required if `cmd === "seek"`
- `value` must be >= 0 if provided

**Examples**:

Play command:

```json
{
  "type": "COMMAND",
  "cmd": "play",
  "server_ts": 1670000000000
}
```

Seek command:

```json
{
  "type": "COMMAND",
  "cmd": "seek",
  "value": 123.456,
  "server_ts": 1670000000000
}
```

---

### EPISODE_CHANGE

Authoritative episode change broadcast sent to all clients.

**TypeScript Interface**:

```typescript
interface EpisodeChangeMessage {
  type: 'EPISODE_CHANGE';
  eventId: number;
  episodeId: string | number;
  providerId: string;
  derivedContentKey: string;
  serverTime: number;
}
```

**Required Fields**:

- `type`: Must be `"EPISODE_CHANGE"`
- `eventId`: Event ID for ordering (integer)
- `episodeId`: Episode ID (string or number)
- `providerId`: Provider identifier
- `derivedContentKey`: Derived content key
- `serverTime`: Server timestamp

**Example**:

```json
{
  "type": "EPISODE_CHANGE",
  "eventId": 43,
  "episodeId": 6,
  "providerId": "netflix",
  "derivedContentKey": "netflix:12345:ep6",
  "serverTime": 1670000001000
}
```

---

### CONTENT_MISMATCH

Advisory message sent when content identity doesn't match.

**TypeScript Interface**:

```typescript
interface ContentMismatchMessage {
  type: 'CONTENT_MISMATCH';
  expectedContentKey: string;
  reportedContentKey?: string;
  server_ts: number;
}
```

**Required Fields**:

- `type`: Must be `"CONTENT_MISMATCH"`
- `expectedContentKey`: Expected derived content key
- `server_ts`: Server timestamp

**Optional Fields**:

- `reportedContentKey`: Client-reported content key

**Example**:

```json
{
  "type": "CONTENT_MISMATCH",
  "expectedContentKey": "netflix:12345:ep5",
  "reportedContentKey": "netflix:12345:ep6",
  "server_ts": 1670000000000
}
```

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
- `INVALID_MESSAGE`: Message validation failed
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

### SERVER_SHUTDOWN

Notification sent to clients when server is shutting down.

**TypeScript Interface**:

```typescript
interface ServerShutdownMessage {
  type: 'SERVER_SHUTDOWN';
  server_ts: number;
}
```

**Required Fields**:

- `type`: Must be `"SERVER_SHUTDOWN"`
- `server_ts`: Server timestamp

**Example**:

```json
{
  "type": "SERVER_SHUTDOWN",
  "server_ts": 1670000000000
}
```

**When Sent**: During graceful server shutdown

---

## Type Unions

### ClientToServerMessage

Union type of all client-to-server messages:

```typescript
type ClientToServerMessage =
  | JoinMessage
  | EventMessage
  | EpisodeChangeRequestMessage
  | TimeReportMessage;
```

### ServerToClientMessage

Union type of all server-to-client messages:

```typescript
type ServerToClientMessage =
  | StateMessage
  | RoomStateMessage
  | CommandMessage
  | EpisodeChangeMessage
  | ContentMismatchMessage
  | ErrorMessage
  | ServerShutdownMessage;
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

### Client Timestamps (`client_ts`, `clientTime`)

- **Format**: Number (monotonic or epoch milliseconds)
- **Purpose**: Used for ordering events and drift detection
- **Validation**: Must be a number

### Server Timestamps (`server_ts`, `serverTime`)

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
