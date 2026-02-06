# WebSocket Implementation Documentation

This document describes how the WebSocket server works - how connections are established, how messages flow through the system, and how the server manages client connections. Think of this as the "how it works" guide.

For detailed information about specific message types and their formats, see [WebSocket Types Documentation](./WEBSOCKET_TYPES.md).

For detailed information about how individual message handlers work, see [WebSocket Handlers Documentation](./WEBSOCKET_HANDLERS.md).

## Overview

The PlaybackSync server uses WebSocket connections to synchronize playback state across multiple clients in real-time. The WebSocket server is integrated with the Fastify HTTP server and handles bidirectional communication between the server and clients.

## Architecture

### Server Integration

The WebSocket server is integrated with Fastify using the `ws` library:

- **WebSocket Server**: Created using `WebSocketServer` with `noServer: true` to handle upgrades manually
- **HTTP Upgrade Handler**: Registered on the underlying Node.js HTTP server to intercept upgrade requests
- **Connection Management**: Connections are tracked by room ID in an in-memory `Map`

### Connection Lifecycle

Here's what happens when a client connects:

1. **Connection Request**: Client initiates WebSocket connection via HTTP upgrade to `wss://host/{roomId}`
2. **Room ID Extraction**: Server extracts `roomId` from the WebSocket URL path (`/{roomId}`)
3. **Room Validation**: Server checks if the room exists and is not expired **before** accepting the connection. If invalid, connection is rejected immediately.
4. **Connection Accepted**: If room is valid, connection is accepted and `roomId` is stored on the connection
5. **JOIN Timeout Started**: Server starts a timer (default: 5 seconds). If no `JOIN` message arrives within this time, the connection is closed.
6. **JOIN Message**: Client must send a `JOIN` message with the room password
7. **Authentication**: Server validates the password and checks connection limits
8. **Client Registration**: Server generates or reattaches a `clientId` for the client (handles reconnection with tombstone pattern)
9. **Rate Limiter Setup**: Rate limiter state is created and stored on the connection for EVENT message rate limiting
10. **State Sync**: Server sends `ROOM_STATE` message with current room state, assigned `clientId`, and optionally `recentEvents` for reconnections
11. **Active State**: Connection is now active and can send/receive messages:
    - ✅ Clients can send `EVENT`, `EPISODE_CHANGE_REQUEST`, and `HEARTBEAT` messages
    - ✅ Server broadcasts `STATE` messages after processing events
    - ✅ Server sends `SYNC_ADJUST` messages for drift correction
12. **Disconnection**: Connection is closed (client disconnect, timeout, error, or room deletion). If client was registered, a tombstone is created for reconnection window.

## Connection Handling

### Connection Setup

When a WebSocket connection is established:

```typescript
handleConnection(ws: ExtendedWebSocket, req: { url?: string })
```

The handler performs the following:

1. **Extracts roomId**: Parses `roomId` from the WebSocket URL path (`/{roomId}`)
2. **Validates roomId**: Ensures `roomId` is a valid UUID v4 format. If invalid, connection is rejected.
3. **Validates room exists**: Checks if the room exists and is not expired **before** accepting the connection. If room is invalid, connection is closed immediately.
4. **Stores roomId**: If room is valid, `roomId` is stored on the connection object
5. **Logs connection**: Structured log entry with request URL and roomId
6. **Sets JOIN timeout**: Timer that closes connection if no `JOIN` message received within timeout period
7. **Registers event handlers**: Sets up handlers for `message`, `close`, and `error` events

### Extended WebSocket Interface

Connections use an extended WebSocket interface that includes metadata:

```typescript
interface ExtendedWebSocket extends WebSocket {
  roomId?: RoomId; // Room ID (set after successful JOIN)
  clientId?: ClientId; // Client ID (set after successful JOIN)
  joinTimeout?: NodeJS.Timeout; // Timeout timer for JOIN message
  rateLimiterState?: RateLimiterState; // Rate limiter state for EVENT message rate limiting
}
```

**Metadata Fields**:

- `roomId`: Set when connection is established (extracted from URL)
- `clientId`: Set after successful JOIN authentication
- `joinTimeout`: Timer that closes connection if no JOIN message received
- `rateLimiterState`: Token bucket state for rate limiting EVENT messages (initialized during JOIN)

### Connection Tracking

Connections are tracked in memory:

- **Storage**: `Map<RoomId, Set<ExtendedWebSocket>>`
- **Key**: Room ID (UUID v4)
- **Value**: Set of WebSocket connections for that room
- **Cleanup**: Connections are automatically removed on disconnect

## Message Processing

### Message Flow

When a message arrives from a client, here's what happens:

1. **Size Check**: Message size is validated against `maxMessageSizeBytes` limit. If exceeded, connection is closed.
2. **Parse**: Convert raw `Buffer` to UTF-8 string and parse JSON
3. **Route**: Extract `type` field and route to appropriate handler based on message type
4. **Validate**: Handler validates message against JSON Schema using `ajv` before processing
5. **Process**: Handler processes the message and updates room state if needed
6. **Respond**: Handler sends response messages (if needed) - either to the sender or broadcast to all clients

### Message Validation

All incoming messages are validated using JSON Schema validation:

- **Schema Location**: `server/schemas/` directory
- **Validation Library**: `ajv` (Another JSON Schema Validator)
- **Validation Utility**: `src/utils/validation.ts`

Invalid messages result in:

- **ERROR message**: Sent to client with error details
- **Connection closure**: Connection may be closed for severe errors

For details on message schemas and types, see [WebSocket Types Documentation](./WEBSOCKET_TYPES.md).

### Message Types

The server currently handles the following message types:

**Client → Server** (handled):

- `JOIN` - Client authentication and room joining (required first message)
- `EVENT` - Playback control events (play, pause, seek)
- `EPISODE_CHANGE_REQUEST` - Request to change episode
- `HEARTBEAT` - Regular status updates for drift detection

**Server → Client** (sent):

- `ROOM_STATE` - Full room state sent on join/rejoin (includes `clientId` and optionally `recentEvents`)
- `STATE` - Authoritative playback state broadcast (sent after events)
- `EPISODE_CHANGE` - Episode change broadcast (sent after episode change requests)
- `SYNC_ADJUST` - Drift correction message (sent to specific client when drift detected)
- `ERROR` - Error responses for various failure scenarios

For complete message type definitions, see [WebSocket Types Documentation](./WEBSOCKET_TYPES.md).

## Connection Timeout

### JOIN Timeout

Connections must send a `JOIN` message within the configured timeout:

- **Default**: 5 seconds (configurable via `JOIN_TIMEOUT_MS` environment variable)
- **Behavior**: Connection is closed with code `1008` if timeout expires
- **Clearing**: Timeout is cleared **only** when a `JOIN` message is received. Other message types do not clear the timeout.
- **Purpose**: Ensures clients authenticate quickly and prevents unauthenticated connections from staying open

### Timeout Configuration

```typescript
ws.joinTimeout = setTimeout(() => {
  if (ws.readyState === WebSocket.OPEN) {
    logger.warn('WebSocket connection closed due to JOIN timeout');
    ws.close(1008, 'JOIN timeout - no JOIN message received');
  }
}, config.joinTimeoutMs);
```

## Event Handlers

### Message Handler

Handles incoming messages from clients:

```typescript
ws.on('message', (data: Buffer) => {
  // Clear JOIN timeout
  // Parse JSON
  // Validate message
  // Process message based on type
});
```

**Message Routing**:

Messages are routed to handlers based on the `type` field:

- `JOIN` → `handleJoinMessage()` - Authentication and room joining
- `EVENT` → `handleEventMessage()` - Playback control events (play/pause/seek)
- `EPISODE_CHANGE_REQUEST` → `handleEpisodeChangeRequest()` - Episode change requests
- `HEARTBEAT` → `handleHeartbeatMessage()` - Status updates for drift detection
- Other message types → Logged as unhandled (not processed)

**Error Handling**:

- **Invalid JSON**: Connection closed with code `1003` ("Invalid message format")
- **Message too large**: Connection closed with code `1009` if exceeds `maxMessageSizeBytes`
- **Validation errors**: `ERROR` message sent to client with `INVALID_MESSAGE` code
- **Processing errors**: Logged with structured context, connection may be closed depending on severity
- **Rate limit exceeded**: `ERROR` message with code `RATE_LIMITED` sent to client (for EVENT messages)
- **Not authenticated**: `ERROR` message with code `NOT_AUTHENTICATED` sent to client (for messages requiring JOIN)

### Close Handler

Handles connection closure:

```typescript
ws.on('close', (code: number, reason: Buffer) => {
  // Clean up timeout
  // Remove from connection tracking
  // Log closure event
});
```

**Cleanup**:

- Clears JOIN timeout if still active
- Removes connection from room tracking
- Logs closure with structured logging

### Error Handler

Handles connection errors:

```typescript
ws.on('error', (error: Error) => {
  // Log error
  // Close connection with code 1011
});
```

**Error Codes**:

- `1003`: Invalid message format
- `1008`: JOIN timeout
- `1011`: Internal server error

## Room Management

### Connection Tracking by Room

Connections are organized by room ID:

```typescript
const connectionsByRoom = new Map<RoomId, Set<ExtendedWebSocket>>();
```

**Operations**:

- **Add**: When client successfully joins a room
- **Remove**: On connection close or room deletion
- **Query**: Get all connections for a room

### Room Deletion

When a room is deleted via `DELETE /api/rooms/:roomId`:

```typescript
closeConnectionsForRoom(roomId: RoomId)
```

**Behavior**:

1. Retrieves all connections for the room
2. Closes each connection with code `1001` ("Room deleted")
3. Removes room from tracking map
4. Logs closure events

## Server Setup

### Initialization

The WebSocket server is initialized during HTTP server startup:

```typescript
setupWebSocketServer(server: FastifyInstance)
```

**Process**:

1. Creates `WebSocketServer` with `noServer: true`
2. Registers upgrade handler on Node.js HTTP server
3. Handles upgrade requests and creates connections
4. Logs server initialization

### Upgrade Handler

HTTP upgrade requests are handled by:

```typescript
nodeServer.on('upgrade', (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, ws => {
    handleConnection(ws as ExtendedWebSocket, request);
  });
});
```

## Error Handling

### Message Processing Errors

**Invalid JSON**:

- Connection closed with code `1003`
- Error logged with structured logging

**Validation Errors**:

- `ERROR` message sent to client
- Error details included in response
- Connection remains open (recoverable error)

**Processing Errors**:

- Error logged with context
- Connection may be closed depending on severity

### Connection Errors

**Network Errors**:

- Logged with structured context
- Connection closed with code `1011`

**Timeout Errors**:

- JOIN timeout logged as warning
- Connection closed with code `1008`

## Logging

All WebSocket events are logged using structured logging (pino):

**Log Levels**:

- `info`: Connection established, messages received, connection closed
- `warn`: JOIN timeout, connection errors
- `error`: Processing errors, connection failures
- `debug`: Message type received (for debugging)

**Structured Fields**:

- `roomId`: Room identifier (masked if `ANON_LOGGING=true`)
- `clientId`: Client identifier (masked if `ANON_LOGGING=true`)
- `url`: Request URL
- `code`: Close code
- `reason`: Close reason
- `error`: Error object

## Message Handlers

The server has handlers for each message type that process incoming messages and update room state accordingly. Each handler:

1. Validates the message against its JSON Schema
2. Checks authentication (client must have completed JOIN)
3. Validates room exists and is not expired
4. Processes the message and updates room state if needed
5. Sends response messages (either to sender or broadcast to all clients)

For detailed documentation on how each handler works, see [WebSocket Handlers Documentation](./WEBSOCKET_HANDLERS.md).

## Configuration

### Environment Variables

| Variable                      | Default | Description                                                        |
| ----------------------------- | ------- | ------------------------------------------------------------------ |
| `JOIN_TIMEOUT_MS`             | `5000`  | Timeout in milliseconds for JOIN message (5 seconds)               |
| `RATE_LIMIT_EVENTS_PER_SEC`   | `10`    | Maximum number of EVENT messages allowed per second per connection |
| `MAX_MESSAGE_SIZE_BYTES`      | `65536` | Maximum message size in bytes (64KB default)                      |
| `MAX_CONNECTIONS_PER_ROOM`    | `100`   | Maximum number of concurrent connections per room                  |
| `CLIENT_TOMBSTONE_MS`         | `30000` | Reconnection window in milliseconds (30 seconds default)          |
| `MAX_BROADCAST_RATE_PER_SEC`  | `50`    | Maximum broadcast rate per room (prevents DoS)                    |

### Configuration Access

Configuration is accessed via:

```typescript
import { getConfig } from '../config';
const config = getConfig();
```

## Security Considerations

### Authentication

- **JOIN Message**: Required for all connections, validates room ID and password
- **Password Validation**: Uses HMAC-SHA256 hash comparison
- **Timeout**: Connections without JOIN are closed

### Message Validation

- **Schema Validation**: All messages validated against JSON Schema
- **Type Safety**: TypeScript types ensure compile-time safety
- **Runtime Validation**: ajv validates at runtime

### Connection Security

- **TLS**: Use WSS (WebSocket Secure) in production
- **Origin Validation**: Consider validating Origin header
- **Rate Limiting**: Token bucket rate limiter per connection for EVENT messages
- **Message Size Limits**: Messages exceeding `MAX_MESSAGE_SIZE_BYTES` are rejected
- **Connection Limits**: Maximum connections per room enforced (`MAX_CONNECTIONS_PER_ROOM`)
- **Password Authentication**: HMAC-SHA256 hash comparison for room passwords

## Performance

### Connection Management

- **In-Memory Storage**: Fast access using `Map` and `Set`
- **Lazy Cleanup**: Connections removed on disconnect
- **Efficient Lookups**: O(1) room connection lookups

### Message Processing

- **Fast Validation**: ajv compiled validators (< 1ms per message)
- **JSON Parsing**: Native `JSON.parse()` for message parsing
- **Async Processing**: Non-blocking event handlers

## Testing

Unit tests for WebSocket implementation are located in:

- `src/__tests__/websocket/server-setup.test.ts` - Connection handling and JOIN message tests
- `src/__tests__/websocket/join-handler.test.ts` - JOIN message handler tests
- `src/__tests__/websocket/event-handler.test.ts` - EVENT message handler tests
- `src/__tests__/websocket/episode-change-handler.test.ts` - EPISODE_CHANGE_REQUEST message handler tests
- `src/__tests__/websocket/drift-reconciliation.test.ts` - HEARTBEAT and drift detection tests

Tests cover:

- Connection acceptance and room validation
- JOIN timeout behavior
- Connection metadata storage
- Connection close handling and tombstone creation
- Error handling
- Multiple concurrent connections
- Message validation and routing
- Rate limiting behavior
- Broadcasting behavior
- Reconnection logic

## Related Documentation

- [WebSocket Types Documentation](./WEBSOCKET_TYPES.md) - Complete message type definitions and schemas
- [WebSocket Handlers Documentation](./WEBSOCKET_HANDLERS.md) - Detailed handler implementation documentation
- [Rooms API Documentation](./ROOMS_API.md) - HTTP API for room management
