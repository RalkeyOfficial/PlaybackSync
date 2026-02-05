# WebSocket Implementation Documentation

This document describes the WebSocket server implementation for PlaybackSync, including connection handling, message processing, and lifecycle management.

For detailed information about WebSocket message types and their schemas, see [WebSocket Types Documentation](./WEBSOCKET_TYPES.md).

## Overview

The PlaybackSync server uses WebSocket connections to synchronize playback state across multiple clients in real-time. The WebSocket server is integrated with the Fastify HTTP server and handles bidirectional communication between the server and clients.

## Architecture

### Server Integration

The WebSocket server is integrated with Fastify using the `ws` library:

- **WebSocket Server**: Created using `WebSocketServer` with `noServer: true` to handle upgrades manually
- **HTTP Upgrade Handler**: Registered on the underlying Node.js HTTP server to intercept upgrade requests
- **Connection Management**: Connections are tracked by room ID in an in-memory `Map`

### Connection Lifecycle

1. **Connection Establishment**: Client initiates WebSocket connection via HTTP upgrade to `wss://host/{roomId}`
2. **Room ID Extraction**: Server extracts `roomId` from the WebSocket URL path
3. **JOIN Timeout**: Connection must send a `JOIN` message within the configured timeout (default: 5 seconds)
4. **Authentication**: `JOIN` message is validated and authenticated (password verification)
5. **Client ID Generation**: Server generates a unique `clientId` for the client (or reattaches if reconnection)
6. **Rate Limiter Initialization**: Rate limiter state is created and stored on the connection for EVENT message rate limiting
7. **State Sync**: Server sends `ROOM_STATE` message with current room state and assigned `clientId`
8. **Active State**: Connection is active and can send/receive messages:
   - ✅ Clients can send `EVENT` messages (play, pause, seek)
   - ✅ Server broadcasts `STATE` messages after processing events
9. **Disconnection**: Connection is closed (client disconnect, timeout, error, or room deletion)

## Connection Handling

### Connection Setup

When a WebSocket connection is established:

```typescript
handleConnection(ws: ExtendedWebSocket, req: { url?: string })
```

The handler performs the following:

1. **Extracts roomId**: Parses `roomId` from the WebSocket URL path (`/{roomId}`)
2. **Validates roomId**: Ensures `roomId` is a valid UUID v4 format
3. **Logs connection**: Structured log entry with request URL and roomId
4. **Sets JOIN timeout**: Timer that closes connection if no `JOIN` message received
5. **Registers event handlers**: Sets up handlers for `message`, `close`, and `error` events

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

1. **Receive**: Raw message arrives as `Buffer`
2. **Parse**: Convert to UTF-8 string and parse JSON
3. **Validate**: Validate message against JSON Schema using `ajv`
4. **Process**: Handle message based on type
5. **Respond**: Send response messages (if needed)

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

The server handles the following message types:

**Client → Server**:

- `JOIN` - Client authentication and room joining
- `EVENT` - Playback control events (play, pause, seek)
- `EPISODE_CHANGE_REQUEST` - Request to change episode
- `TIME_REPORT` - Drift reconciliation time reports

**Server → Client**:

- `STATE` - Authoritative playback state broadcast
- `COMMAND` - Server-initiated commands
- `ERROR` - Error responses
- `ROOM_STATE` - Full room state on join/rejoin
- `EPISODE_CHANGE` - Episode change broadcast
- `CONTENT_MISMATCH` - Content identity mismatch advisory
- `SERVER_SHUTDOWN` - Server shutdown notification

For complete message type definitions, see [WebSocket Types Documentation](./WEBSOCKET_TYPES.md).

## Connection Timeout

### JOIN Timeout

Connections must send a `JOIN` message within the configured timeout:

- **Default**: 5 seconds (configurable via `JOIN_TIMEOUT_MS` environment variable)
- **Behavior**: Connection is closed with code `1008` if timeout expires
- **Clearing**: Timeout is cleared when any message is received (before validation)

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

- `JOIN` messages are handled by `handleJoinMessage()`
- `EVENT` messages are handled by `handleEventMessage()`
- Other message types are logged and will be handled in future phases

**Error Handling**:

- Invalid JSON: Connection closed with code `1003`
- Validation errors: `ERROR` message sent to client
- Processing errors: Logged and connection may be closed
- Rate limit exceeded: `ERROR` message with code `RATE_LIMITED` sent to client

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

## EVENT Message Handling

### Overview

The `EVENT` message handler processes explicit playback control events (play, pause, seek) from clients. These events represent user intent, not authoritative state. The server updates room state and broadcasts authoritative `STATE` messages to all clients in the room.

### Handler Function

```typescript
handleEventMessage(ws: ExtendedWebSocket, message: unknown, roomId: RoomId)
```

### Processing Flow

1. **Authentication Check**: Verifies client has completed JOIN (has `clientId`)
2. **Message Validation**: Validates EVENT message against JSON Schema
3. **Room Validation**: Ensures room exists and is not expired
4. **Rate Limiting**: Checks per-connection rate limit (token bucket algorithm)
5. **State Update**: Updates room state based on event type:
   - `play`: Sets `paused = false`
   - `pause`: Sets `paused = true`
   - `seek`: Updates `time` to the provided value
6. **Event Logging**: Appends event to room's event log (ring buffer, max 100 events)
7. **State Broadcasting**: Broadcasts `STATE` message to all connected clients
8. **Logging**: Logs event processing with structured logging

### Rate Limiting

Rate limiting is implemented using a token bucket algorithm:

- **Per-Connection**: Each WebSocket connection has its own rate limiter state
- **Token Bucket**: Tokens refill at a configurable rate (default: 10 events/second)
- **Initialization**: Rate limiter state is created during JOIN and stored on the WebSocket connection
- **Check**: Before processing an EVENT, the rate limiter checks if a token is available
- **Exceeded**: If rate limit is exceeded, an `ERROR` message with code `RATE_LIMITED` is sent and the event is not processed

**Rate Limiter Implementation**:

```typescript
class RateLimiter {
  check(state: RateLimiterState): boolean
  createState(): RateLimiterState
}
```

The rate limiter state is stored on the `ExtendedWebSocket` interface:

```typescript
interface ExtendedWebSocket extends WebSocket {
  rateLimiterState?: RateLimiterState;
}
```

### State Updates

When processing an EVENT message, the server:

1. **Increments `eventId`**: Each event gets a unique, incrementing event ID
2. **Updates Timestamps**:
   - `last_explicit_event_ts`: Set to current server time
   - `last_state_update_ts`: Set to current server time
3. **Updates Playback State**:
   - For `play`: `paused = false`
   - For `pause`: `paused = true`
   - For `seek`: `time = eventMessage.value`

### Event Logging

Events are logged to a ring buffer per room:

- **Maximum Size**: 100 events (configurable via `MAX_EVENT_LOG_SIZE`)
- **Event Structure**: Includes event type, clientId, timestamp, eventId, and optional value
- **Ring Buffer**: When the log reaches maximum size, oldest events are removed

### State Broadcasting

After processing an EVENT, the server broadcasts a `STATE` message to all connected clients in the room:

- **Authoritative State**: The `STATE` message contains the server's authoritative playback state
- **All Clients**: All clients receive the broadcast, including the client that sent the EVENT
- **Event ID**: The `STATE` message includes the updated `eventId` for ordering
- **Server Timestamp**: Includes `server_ts` for synchronization

**Important**: Clients must not suppress or ignore `STATE` messages they "caused". The server's `STATE` message is always authoritative, even for the originating client.

### Error Responses

The EVENT handler can send the following error responses:

- `NOT_AUTHENTICATED`: EVENT received before JOIN message
- `INVALID_MESSAGE`: Message validation failed (schema errors)
- `RATE_LIMITED`: Rate limit exceeded for this connection
- `ROOM_NOT_FOUND`: Room doesn't exist or is expired

## Configuration

### Environment Variables

| Variable                      | Default | Description                                                        |
| ----------------------------- | ------- | ------------------------------------------------------------------ |
| `JOIN_TIMEOUT_MS`             | `5000`  | Timeout in milliseconds for JOIN message (5 seconds)               |
| `RATE_LIMIT_EVENTS_PER_SEC`   | `10`    | Maximum number of EVENT messages allowed per second per connection |

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
- `src/__tests__/websocket/event-handler.test.ts` - EVENT message handling tests

Tests cover:

- Connection acceptance
- JOIN timeout behavior
- Connection metadata storage
- Connection close handling
- Error handling
- Multiple concurrent connections
- EVENT message processing (play, pause, seek)
- Rate limiting behavior
- State updates and broadcasting
- Event logging

## Related Documentation

- [WebSocket Types Documentation](./WEBSOCKET_TYPES.md) - Complete message type definitions
- [Rooms API Documentation](./ROOMS_API.md) - HTTP API for room management
