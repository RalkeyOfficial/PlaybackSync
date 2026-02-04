# Rooms API Documentation

This document describes the Room Management API endpoints for PlaybackSync. These endpoints allow you to create and manage synchronized playback rooms.

## Base URL

Admin API endpoints are prefixed with `/api/rooms`. The public share endpoint (`GET /:roomId`) does not use this prefix.

## Authentication

**Important**: The server does not implement authentication for admin API endpoints (`/api/rooms/*`). These endpoints are **publicly accessible** and should be secured using a third-party authentication solution in production environments.

### Admin Endpoints Security

All admin API endpoints (`POST /api/rooms`, `GET /api/rooms`, `GET /api/rooms/:roomId`, `DELETE /api/rooms/:roomId`) have **no built-in authentication**. In production, you must secure these endpoints using:

- **Reverse Proxy Authentication**: Configure your reverse proxy (e.g., Traefik, Nginx, Caddy) to require authentication before forwarding requests to the PlaybackSync server
- **Authentication Services**: Integrate with authentication providers such as:
  - [Authentik](https://goauthentik.io/) - Open-source identity provider
  - [Authelia](https://www.authelia.com/) - Open-source authentication and authorization server
  - [OAuth2 Proxy](https://oauth2-proxy.github.io/oauth2-proxy/) - OAuth2 reverse proxy
  - [Keycloak](https://www.keycloak.org/) - Open-source identity and access management
  - Other authentication solutions that work with reverse proxies

**Example**: Using Authentik with Traefik, you would configure Traefik to require Authentik authentication for all `/api/rooms/*` routes before they reach the PlaybackSync server.

### Public Share Endpoint

The public share endpoint (`GET /:roomId`) uses **HTTP Basic Authentication** built into the server. This endpoint is designed to be publicly accessible - participants authenticate using the room password provided when the room was created.

## Endpoints

### POST /api/rooms

Create a new synchronized playback room.

#### Description

Creates a new room with a unique UUID v4 identifier and a randomly generated password. The room will automatically expire after the specified TTL (Time To Live) period or the default 24H. The password is hashed using HMAC-SHA256 and never stored in plaintext. The plaintext password is only returned once in the creation response.

**Security Note**: This endpoint has **no built-in authentication**. In production, secure it using a third-party authentication solution (e.g., Authentik, Authelia) via reverse proxy configuration. Unauthorized access allows anyone to create rooms.

#### Request

**Method**: `POST`  
**Path**: `/api/rooms`  
**Content-Type**: `application/json`

**Request Body** (optional):

```json
{
  "ttl": 86400,
  "targetUrl": "https://example.com/video"
}
```

**Body Parameters**:

| Parameter   | Type         | Required | Default            | Description                                                                                                             |
| ----------- | ------------ | -------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `ttl`       | number       | No       | `86400` (24 hours) | Time-to-live in seconds. Minimum: 1. After this duration, the room will be automatically removed.                       |
| `targetUrl` | string (URI) | Yes      | -                  | Target video URL for the room. Required for sharing functionality. Used by the share endpoint to redirect participants. |

**Example Request**:

```bash
curl -X POST http://localhost:8080/api/rooms \
  -H "Content-Type: application/json" \
  -d '{
    "ttl": 7200,
    "targetUrl": "https://netflix.com/watch/12345"
  }'
```

#### Response

**Status Code**: `201 Created`

**Response Body**:

```json
{
  "roomId": "123e4567-e89b-12d3-a456-426614174000",
  "password": "aB3dEf9gHiJkLmN0",
  "shareLink": "/123e4567-e89b-12d3-a456-426614174000"
}
```

**Response Fields**:

| Field       | Type             | Description                                                                                                                                                                                                                                                                                                                                              |
| ----------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `roomId`    | string (UUID v4) | Unique room identifier. Use this to reference the room in other API calls and WebSocket connections.                                                                                                                                                                                                                                                     |
| `password`  | string           | Randomly generated password (16 alphanumeric characters). **This is the only time the plaintext password is returned.** Store it securely. Required for clients to join the room via WebSocket.                                                                                                                                                          |
| `shareLink` | string           | Share link for the room pointing to the public share endpoint (`GET /:roomId`). Format depends on `SHARE_HOSTNAME` environment variable: <ul><li>If `SHARE_HOSTNAME` is set: `https://{SHARE_HOSTNAME}/{roomId}`</li><li>If not set: `/{roomId}`</li></ul> Participants visit this link and authenticate via HTTP Basic Authentication to join the room. |

**Example Response**:

```json
{
  "roomId": "550e8400-e29b-41d4-a716-446655440000",
  "password": "Xy9zA2bC3dE4fG5h",
  "shareLink": "https://share.playbacksync.example.com/550e8400-e29b-41d4-a716-446655440000"
}
```

#### Error Responses

**400 Bad Request** - Invalid request body

```json
{
  "statusCode": 400,
  "error": "Bad Request",
  "message": "body/ttl must be >= 1"
}
```

**Possible causes**:

- `targetUrl` is missing (required field)
- `targetUrl` is not a valid URI format
- `ttl` is negative or zero
- `ttl` is not a number
- Invalid JSON in request body

**Example Error Request**:

```bash
curl -X POST http://localhost:8080/api/rooms \
  -H "Content-Type: application/json" \
  -d '{"ttl": -1}'
```

#### Room Initialization

When a room is created, it is initialized with the following default state:

- **Playback State**:
  - `paused`: `true`
  - `time`: `0` (seconds)
  - `provider`: `""` (empty string)
  - `episode`: `0`
  - `eventId`: `0`
  - `last_explicit_event_ts`: Current timestamp
  - `last_state_update_ts`: Current timestamp

- **Connected Clients**: Empty (no clients connected)
- **Event Log**: Empty array
- **Expiration**: `createdAt + (ttl * 1000)` milliseconds

#### Security Notes

- Passwords are hashed using HMAC-SHA256 with the server's secret key
- Plaintext passwords are never stored in memory or logs
- Room IDs are UUID v4, making them unpredictable
- Passwords are 16-character alphanumeric strings (62^16 possible combinations)

---

### GET /api/rooms

List all active (non-expired) rooms.

#### Description

Returns a list of all currently active rooms. Expired rooms (where `expiresAt < now`) are automatically filtered out. Rooms are sorted by creation time, newest first.

**Security Note**: This endpoint has **no built-in authentication**. In production, secure it using a third-party authentication solution (e.g., Authentik, Authelia) via reverse proxy configuration. Unauthorized access exposes information about all active rooms.

#### Request

**Method**: `GET`  
**Path**: `/api/rooms`  
**Query Parameters**: None

**Example Request**:

```bash
curl http://localhost:8080/api/rooms
```

#### Response

**Status Code**: `200 OK`

**Response Body**:

```json
[
  {
    "id": "123e4567-e89b-12d3-a456-426614174000",
    "createdAt": 1672531200000,
    "participantCount": 3,
    "expiresAt": 1672617600000,
    "last_state": {
      "paused": false,
      "time": 123.456,
      "provider": "netflix",
      "episode": 5,
      "last_explicit_event_ts": 1672531300000,
      "last_state_update_ts": 1672531300000,
      "eventId": 42
    }
  },
  {
    "id": "987e6543-e21b-98d7-a321-123456789012",
    "createdAt": 1672531000000,
    "participantCount": 0,
    "expiresAt": 1672617400000,
    "last_state": {
      "paused": true,
      "time": 0,
      "provider": "",
      "episode": 0,
      "last_explicit_event_ts": 1672531000000,
      "last_state_update_ts": 1672531000000,
      "eventId": 0
    }
  }
]
```

**Response Fields**:

| Field              | Type             | Description                                                                                            |
| ------------------ | ---------------- | ------------------------------------------------------------------------------------------------------ |
| `id`               | string (UUID v4) | Room identifier                                                                                        |
| `createdAt`        | number           | Room creation timestamp in milliseconds (Unix epoch)                                                   |
| `participantCount` | number           | Number of currently connected clients in the room                                                      |
| `expiresAt`        | number           | Room expiration timestamp in milliseconds (Unix epoch). Rooms with `expiresAt < now` are filtered out. |
| `last_state`       | object           | Current playback state of the room (see below)                                                         |

**last_state Object**:

| Field                    | Type    | Description                                                      |
| ------------------------ | ------- | ---------------------------------------------------------------- |
| `paused`                 | boolean | Whether playback is currently paused                             |
| `time`                   | number  | Current playback position in seconds                             |
| `provider`               | string  | Content provider identifier (e.g., "netflix", "hulu")            |
| `episode`                | number  | Episode number or identifier                                     |
| `last_explicit_event_ts` | number  | Timestamp (ms) of the last explicit user event (play/pause/seek) |
| `last_state_update_ts`   | number  | Timestamp (ms) of the last state update                          |
| `eventId`                | number  | Last event ID for ordering and synchronization                   |

**Empty Response**:

If no active rooms exist, an empty array is returned:

```json
[]
```

#### Room Expiration

Rooms are automatically filtered out when:

- `expiresAt < Date.now()`

Expired rooms are not included in the response. The expiration timestamp is calculated as:

```
expiresAt = createdAt + (ttl * 1000)
```

Where `ttl` is the time-to-live in seconds specified during room creation (or the default from `ROOM_TTL_SECONDS` environment variable).

#### Sorting

Rooms are sorted by `createdAt` in descending order (newest first).

---

### GET /api/rooms/:roomId

Get detailed information about a specific room (admin endpoint).

#### Description

Returns comprehensive details about a room including its current state, connected clients, recent events, and metadata. This is an **admin API endpoint** - it returns JSON data and is separate from the public share endpoint (`GET /:roomId`) which uses HTTP Basic Auth and redirects.

**Security Note**: This endpoint has **no built-in authentication**. In production, secure it using a third-party authentication solution (e.g., Authentik, Authelia) via reverse proxy configuration.

#### Request

**Method**: `GET`  
**Path**: `/api/rooms/:roomId`  
**Query Parameters**: None

**Path Parameters**:

| Parameter | Type             | Required | Description               |
| --------- | ---------------- | -------- | ------------------------- |
| `roomId`  | string (UUID v4) | Yes      | Room identifier (UUID v4) |

**Example Request**:

```bash
curl http://localhost:8080/api/rooms/550e8400-e29b-41d4-a716-446655440000
```

#### Response

**Status Code**: `200 OK`

**Response Body**:

```json
{
  "roomId": "550e8400-e29b-41d4-a716-446655440000",
  "createdAt": 1672531200000,
  "expiresAt": 1672617600000,
  "targetUrl": "https://netflix.com/watch/12345",
  "state": {
    "paused": false,
    "time": 123.456,
    "provider": "netflix",
    "episode": 5,
    "eventId": 42,
    "last_explicit_event_ts": 1672531300000,
    "last_state_update_ts": 1672531300000
  },
  "connectedClients": [
    {
      "clientId": "123e4567-e89b-12d3-a456-426614174001",
      "lastSeen": 1672531350000
    },
    {
      "clientId": "123e4567-e89b-12d3-a456-426614174002",
      "lastSeen": 1672531340000,
      "tombstonedUntil": 1672531650000
    }
  ],
  "recentEvents": [
    {
      "type": "seek",
      "value": 120.5,
      "clientId": "123e4567-e89b-12d3-a456-426614174001",
      "ts": 1672531300000,
      "eventId": 42
    },
    {
      "type": "play",
      "clientId": "123e4567-e89b-12d3-a456-426614174001",
      "ts": 1672531295000,
      "eventId": 41
    }
  ]
}
```

**Response Fields**:

| Field              | Type             | Description                                            |
| ------------------ | ---------------- | ------------------------------------------------------ |
| `roomId`           | string (UUID v4) | Room identifier                                        |
| `createdAt`        | number           | Room creation timestamp in milliseconds (Unix epoch)   |
| `expiresAt`        | number           | Room expiration timestamp in milliseconds (Unix epoch) |
| `targetUrl`        | string (URI)     | Target video URL for the room (used by share endpoint) |
| `state`            | object           | Current playback state (see below)                     |
| `connectedClients` | array            | List of currently connected clients (see below)        |
| `recentEvents`     | array            | Recent event log entries (ring buffer, see below)      |

**state Object**:

| Field                    | Type    | Description                                                      |
| ------------------------ | ------- | ---------------------------------------------------------------- |
| `paused`                 | boolean | Whether playback is currently paused                             |
| `time`                   | number  | Current playback position in seconds                             |
| `provider`               | string  | Content provider identifier (e.g., "netflix", "hulu")            |
| `episode`                | number  | Episode number or identifier                                     |
| `eventId`                | number  | Last event ID for ordering and synchronization                   |
| `last_explicit_event_ts` | number  | Timestamp (ms) of the last explicit user event (play/pause/seek) |
| `last_state_update_ts`   | number  | Timestamp (ms) of the last state update                          |

**connectedClients Array**:

Each client object contains:

| Field             | Type   | Description                                                                                    |
| ----------------- | ------ | ---------------------------------------------------------------------------------------------- |
| `clientId`        | string | Unique client identifier (UUID v4)                                                             |
| `lastSeen`        | number | Timestamp (ms) when client was last seen                                                       |
| `tombstonedUntil` | number | Optional. Timestamp (ms) until which client can reconnect with same clientId (if disconnected) |

**recentEvents Array**:

Each event object contains:

| Field      | Type             | Description                                  |
| ---------- | ---------------- | -------------------------------------------- |
| `type`     | string           | Event type: "play", "pause", "seek"          |
| `value`    | number or string | Optional. Event value (e.g., seek position)  |
| `clientId` | string           | Optional. Client ID that triggered the event |
| `ts`       | number           | Timestamp (ms) when event occurred           |
| `eventId`  | number           | Event ID for ordering                        |

#### Error Responses

**400 Bad Request** - Invalid roomId format

```json
{
  "statusCode": 400,
  "error": "Bad Request",
  "message": "Invalid UUID format for roomId: invalid-uuid"
}
```

**404 Not Found** - Room doesn't exist or is expired

```json
{
  "statusCode": 404,
  "error": "Not Found",
  "message": "Room not found: 550e8400-e29b-41d4-a716-446655440000"
}
```

#### Security Notes

- **Password Hash**: The `passwordHash` field is **never** included in the response for security reasons
- **Sensitive Data**: Client IDs and room IDs are included but should be masked in logs if `ANON_LOGGING=true`
- **Expired Rooms**: Expired rooms return `404 Not Found` (not `401`) to prevent information disclosure

#### Notes

- This endpoint is separate from the public share endpoint (`GET /:roomId`)
- Expired rooms are automatically cleaned up in the background
- The event log is a ring buffer - only the most recent events are retained
- Tombstoned clients (disconnected but within reconnection window) appear in `connectedClients` with `tombstonedUntil` field

---

### DELETE /api/rooms/:roomId

Delete a room and close all WebSocket connections (admin endpoint).

#### Description

Permanently deletes a room from storage and closes all active WebSocket connections for that room. This is an **admin API endpoint** for room management. After deletion, the room cannot be accessed and all connected clients will be disconnected.

**Security Note**: This endpoint has **no built-in authentication**. In production, secure it using a third-party authentication solution (e.g., Authentik, Authelia) via reverse proxy configuration. **Warning**: Unauthorized access to this endpoint can delete rooms and disconnect all participants.

#### Request

**Method**: `DELETE`  
**Path**: `/api/rooms/:roomId`  
**Query Parameters**: None

**Path Parameters**:

| Parameter | Type             | Required | Description               |
| --------- | ---------------- | -------- | ------------------------- |
| `roomId`  | string (UUID v4) | Yes      | Room identifier (UUID v4) |

**Example Request**:

```bash
curl -X DELETE http://localhost:8080/api/rooms/550e8400-e29b-41d4-a716-446655440000
```

#### Response

**Status Code**: `204 No Content` (on successful deletion)

**Response Body**: Empty

#### Error Responses

**400 Bad Request** - Invalid roomId format

```json
{
  "statusCode": 400,
  "error": "Bad Request",
  "message": "Invalid UUID format for roomId: invalid-uuid"
}
```

**404 Not Found** - Room doesn't exist or is expired

```json
{
  "statusCode": 404,
  "error": "Not Found",
  "message": "Room not found: 550e8400-e29b-41d4-a716-446655440000"
}
```

#### Behavior

When a room is deleted:

1. **WebSocket Connections**: All active WebSocket connections for the room are immediately closed
2. **Storage**: Room is removed from in-memory storage
3. **Logging**: Deletion is logged with structured logging (roomId is masked)
4. **No Recovery**: Deleted rooms cannot be recovered - they must be recreated

#### Example Usage

```bash
# Delete a room
curl -X DELETE http://localhost:8080/api/rooms/550e8400-e29b-41d4-a716-446655440000

# Response: 204 No Content (empty body)

# Verify deletion - should return 404
curl http://localhost:8080/api/rooms/550e8400-e29b-41d4-a716-446655440000

# Response:
# {
#   "statusCode": 404,
#   "error": "Not Found",
#   "message": "Room not found: 550e8400-e29b-41d4-a716-446655440000"
# }
```

#### Notes

- Deletion is immediate and irreversible
- All connected clients are disconnected when the room is deleted
- Expired rooms return `404 Not Found` (same as non-existent rooms)
- Room deletion is logged for audit purposes

---

### GET /:roomId

Public share endpoint for participants to join rooms via HTTP Basic Authentication.

#### Description

This endpoint allows participants to access a room by visiting the share link. The endpoint uses **HTTP Basic Authentication** - when accessed without credentials, the browser automatically displays a login prompt. After successful authentication, participants are redirected to the room's `targetUrl` with WebSocket sync parameters appended as query parameters.

**Important**: This endpoint is separate from the admin API endpoint `GET /api/rooms/:roomId`. The share endpoint is public-facing and uses Basic Auth, while the admin endpoint returns JSON room details.

#### Request

**Method**: `GET`  
**Path**: `/:roomId` (no `/api` prefix)  
**Authentication**: HTTP Basic Authentication (username field is ignored, password is required)

**Path Parameters**:

| Parameter | Type             | Required | Description               |
| --------- | ---------------- | -------- | ------------------------- |
| `roomId`  | string (UUID v4) | Yes      | Room identifier (UUID v4) |

**Authentication Flow**:

1. **First Request (No Credentials)**: Client visits `GET /:roomId` without `Authorization` header
   - Server responds with `401 Unauthorized` and `WWW-Authenticate: Basic realm="Room {roomId}"` header
   - Browser automatically displays Basic Auth login prompt
   - User enters password (username can be left empty or any value)

2. **Second Request (With Credentials)**: Browser automatically retries with `Authorization: Basic {base64(username:password)}` header
   - Server validates password against room's passwordHash
   - On success: Redirects to `targetUrl` with sync parameters
   - On failure: Returns `401 Unauthorized` again

#### Response

**Status Code**: `302 Found` (redirect on successful authentication)

**Response Headers**:

- `Location`: Redirect URL with sync parameters (on success)
- `WWW-Authenticate`: `Basic realm="Room {roomId}"` (on 401 responses)

**Redirect URL Format**:

On successful authentication, the server redirects to:

```
{targetUrl}?sync_url=wss://{SYNC_HOSTNAME}/{roomId}&sync_password={password}
```

**Redirect URL Parameters**:

| Parameter       | Description                                                                                                                             |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `sync_url`      | WebSocket URL for connecting to the sync server. Format: `wss://{SYNC_HOSTNAME}/{roomId}`. Uses `SYNC_HOSTNAME` environment variable.   |
| `sync_password` | Room password (plaintext). Required for WebSocket authentication. **Note**: This is the same password entered in the Basic Auth prompt. |

**Example Redirect**:

If `targetUrl` is `https://netflix.com/watch/12345` and `SYNC_HOSTNAME` is `sync.example.com`:

```
https://netflix.com/watch/12345?sync_url=wss://sync.example.com/550e8400-e29b-41d4-a716-446655440000&sync_password=Xy9zA2bC3dE4fG5h
```

**Query Parameter Preservation**:

If the `targetUrl` already contains query parameters, they are preserved and sync parameters are appended:

```
https://example.com/video?episode=5&season=2&sync_url=wss://sync.example.com/{roomId}&sync_password={password}
```

#### Error Responses

**400 Bad Request** - Invalid roomId format

```json
{
  "statusCode": 400,
  "error": "Bad Request",
  "message": "Invalid UUID format for roomId: invalid-uuid"
}
```

**401 Unauthorized** - Authentication required or invalid password

**Without Authorization Header** (triggers browser prompt):

```
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Basic realm="Room 550e8400-e29b-41d4-a716-446655440000"

{
  "statusCode": 401,
  "error": "Unauthorized",
  "message": "Authentication required"
}
```

**With Invalid Password**:

```
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Basic realm="Room 550e8400-e29b-41d4-a716-446655440000"

{
  "statusCode": 401,
  "error": "Unauthorized",
  "message": "Invalid password"
}
```

**404 Not Found** - Room doesn't exist or is expired

```json
{
  "statusCode": 404,
  "error": "Not Found",
  "message": "Room not found: 550e8400-e29b-41d4-a716-446655440000"
}
```

#### Example Usage

**Using curl (Manual Basic Auth)**:

```bash
# First, get the room credentials
curl -X POST http://localhost:8080/api/rooms \
  -H "Content-Type: application/json" \
  -d '{
    "targetUrl": "https://netflix.com/watch/12345"
  }'

# Response:
# {
#   "roomId": "550e8400-e29b-41d4-a716-446655440000",
#   "password": "Xy9zA2bC3dE4fG5h",
#   "shareLink": "/550e8400-e29b-41d4-a716-446655440000"
# }

# Access share endpoint with Basic Auth (username can be empty)
curl -u ":Xy9zA2bC3dE4fG5h" \
  -L \
  http://localhost:8080/550e8400-e29b-41d4-a716-446655440000

# Server responds with 302 redirect to:
# https://netflix.com/watch/12345?sync_url=wss://sync.example.com/550e8400-e29b-41d4-a716-446655440000&sync_password=Xy9zA2bC3dE4fG5h
```

**Using curl (First request triggers prompt simulation)**:

```bash
# Without credentials - server returns 401
curl -v http://localhost:8080/550e8400-e29b-41d4-a716-446655440000

# Response:
# HTTP/1.1 401 Unauthorized
# WWW-Authenticate: Basic realm="Room 550e8400-e29b-41d4-a716-446655440000"
# ...
```

**Browser Flow**:

1. User visits share link: `https://share.example.com/550e8400-e29b-41d4-a716-446655440000`
2. Browser receives `401` with `WWW-Authenticate` header
3. Browser displays Basic Auth prompt (username field can be left empty)
4. User enters password: `Xy9zA2bC3dE4fG5h`
5. Browser automatically retries request with `Authorization: Basic {base64}` header
6. Server validates password and redirects to: `https://netflix.com/watch/12345?sync_url=wss://sync.example.com/550e8400-e29b-41d4-a716-446655440000&sync_password=Xy9zA2bC3dE4fG5h`
7. Browser extension detects `sync_url` and `sync_password` parameters, stores them, and connects to WebSocket

#### Security Considerations

- **Password Transmission**: Passwords are transmitted in the `Authorization` header (base64 encoded, not encrypted). Always use HTTPS in production.
- **Password in Redirect URL**: The password appears in the redirect URL as a query parameter (`sync_password`). This is intentional for browser extension detection, but:
  - URLs may be logged in browser history
  - URLs may be shared via referrer headers
  - Consider using HTTPS to protect URL parameters in transit
- **Username Field**: The username field in Basic Auth is ignored. Users can leave it empty or enter any value - only the password is validated.
- **Room Expiration**: Expired rooms return `404 Not Found` (not `401`) to prevent information disclosure about room existence.
- **Rate Limiting**: Failed authentication attempts are logged but not rate-limited. Consider implementing rate limiting in production.

#### Integration with Browser Extension

The share endpoint is designed to work with browser extensions that:

1. Monitor URL changes for `sync_url` and `sync_password` parameters
2. Extract these parameters from the URL
3. Strip them from the URL (to keep URLs clean)
4. Connect to the WebSocket server using the extracted credentials
5. Send a `JOIN` message with `password` to authenticate (roomId is extracted from the WebSocket URL path)

#### Notes

- The endpoint validates roomId format (must be UUID v4)
- Expired rooms are automatically cleaned up in the background
- The `WWW-Authenticate` realm includes the roomId for clarity
- Failed authentication attempts are logged with masked roomId for security
- Successful authentications are logged for audit purposes
- The endpoint is separate from the admin API (`/api/rooms/:roomId`) which returns JSON

---

## Environment Variables

The following environment variables affect room behavior:

| Variable           | Default      | Description                                                                                                                                                                                                                                                |
| ------------------ | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ROOM_TTL_SECONDS` | `86400`      | Default TTL for rooms in seconds (24 hours)                                                                                                                                                                                                                |
| `SHARE_HOSTNAME`   | -            | Hostname for share links. If set, share links will be full URLs: `https://{SHARE_HOSTNAME}/{roomId}`. If not set, share links are relative paths: `/{roomId}`.                                                                                             |
| `SYNC_HOSTNAME`    | -            | WebSocket hostname used for sync parameters in share endpoint redirects. Format: `wss://{SYNC_HOSTNAME}/{roomId}`. If not set, defaults to `wss://localhost/{roomId}` (for development). **Required in production** for proper WebSocket URL construction. |
| `SERVER_SECRET`    | **Required** | Secret key used for HMAC-SHA256 password hashing. Must be set.                                                                                                                                                                                             |

---

## Examples

### Create a Room with Custom TTL

```bash
curl -X POST http://localhost:8080/api/rooms \
  -H "Content-Type: application/json" \
  -d '{
    "ttl": 3600,
    "targetUrl": "https://netflix.com/watch/12345"
  }'
```

**Response**:

```json
{
  "roomId": "550e8400-e29b-41d4-a716-446655440000",
  "password": "Xy9zA2bC3dE4fG5h",
  "shareLink": "/550e8400-e29b-41d4-a716-446655440000"
}
```

### Create a Room with Default TTL

```bash
curl -X POST http://localhost:8080/api/rooms \
  -H "Content-Type: application/json" \
  -d '{
    "targetUrl": "https://miruro.to/watch/12345"
  }'
```

**Response**:

```json
{
  "roomId": "660e8400-e29b-41d4-a716-446655440001",
  "password": "Ab2Cd3Ef4Gh5Ij6K",
  "shareLink": "/660e8400-e29b-41d4-a716-446655440001"
}
```

### List All Active Rooms

```bash
curl http://localhost:8080/api/rooms
```

**Response**:

```json
[
  {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "createdAt": 1672531200000,
    "participantCount": 2,
    "expiresAt": 1672534800000,
    "last_state": {
      "paused": false,
      "time": 45.123,
      "provider": "netflix",
      "episode": 3,
      "last_explicit_event_ts": 1672531250000,
      "last_state_update_ts": 1672531250000,
      "eventId": 15
    }
  }
]
```

### Get Room Details

```bash
curl http://localhost:8080/api/rooms/550e8400-e29b-41d4-a716-446655440000
```

**Response**:

```json
{
  "roomId": "550e8400-e29b-41d4-a716-446655440000",
  "createdAt": 1672531200000,
  "expiresAt": 1672617600000,
  "targetUrl": "https://netflix.com/watch/12345",
  "state": {
    "paused": false,
    "time": 123.456,
    "provider": "netflix",
    "episode": 5,
    "eventId": 42,
    "last_explicit_event_ts": 1672531300000,
    "last_state_update_ts": 1672531300000
  },
  "connectedClients": [
    {
      "clientId": "123e4567-e89b-12d3-a456-426614174001",
      "lastSeen": 1672531350000
    }
  ],
  "recentEvents": [
    {
      "type": "seek",
      "value": 120.5,
      "clientId": "123e4567-e89b-12d3-a456-426614174001",
      "ts": 1672531300000,
      "eventId": 42
    }
  ]
}
```

### Delete a Room

```bash
curl -X DELETE http://localhost:8080/api/rooms/550e8400-e29b-41d4-a716-446655440000
```

**Response**: `204 No Content` (empty body)

### Access Share Endpoint (HTTP Basic Auth)

```bash
# First, create a room to get credentials
curl -X POST http://localhost:8080/api/rooms \
  -H "Content-Type: application/json" \
  -d '{
    "targetUrl": "https://netflix.com/watch/12345"
  }'

# Response:
# {
#   "roomId": "550e8400-e29b-41d4-a716-446655440000",
#   "password": "Xy9zA2bC3dE4fG5h",
#   "shareLink": "/550e8400-e29b-41d4-a716-446655440000"
# }

# Access share endpoint with Basic Auth (username can be empty)
curl -u ":Xy9zA2bC3dE4fG5h" \
  -L \
  -v \
  http://localhost:8080/550e8400-e29b-41d4-a716-446655440000

# Response: 302 Found
# Location: https://netflix.com/watch/12345?sync_url=wss://sync.example.com/550e8400-e29b-41d4-a716-446655440000&sync_password=Xy9zA2bC3dE4fG5h
```

---

## Error Handling

All endpoints return standard HTTP status codes:

| Status Code                 | Description                                                           |
| --------------------------- | --------------------------------------------------------------------- |
| `200 OK`                    | Request successful                                                    |
| `201 Created`               | Room created successfully                                             |
| `204 No Content`            | Request successful, no content to return (DELETE operations)          |
| `302 Found`                 | Redirect (share endpoint redirects to targetUrl with sync parameters) |
| `400 Bad Request`           | Invalid request body or parameters (e.g., invalid UUID format)        |
| `401 Unauthorized`          | Authentication required or invalid credentials (share endpoint)       |
| `404 Not Found`             | Resource not found (room doesn't exist or is expired)                 |
| `500 Internal Server Error` | Server error                                                          |

Error responses follow Fastify's default error format:

```json
{
  "statusCode": 400,
  "error": "Bad Request",
  "message": "body/ttl must be >= 1"
}
```

---

## Rate Limiting

Currently, no rate limiting is implemented for HTTP endpoints. Rate limiting may be added in future versions.

---

## Room Lifecycle

1. **Creation**: Room is created via `POST /api/rooms`
2. **Active**: Room exists and is accessible via `GET /api/rooms` until expiration
3. **Expiration**: Room automatically expires after TTL period
4. **Cleanup**: Expired rooms are filtered out from listings (no manual deletion required)

---

## Notes

- Rooms are stored in-memory and do not persist across server restarts
- Room passwords are only returned once during creation - store them securely
- Share links point to the public share endpoint (`GET /:roomId`) which uses HTTP Basic Authentication
- The `targetUrl` parameter is required and is used by the share endpoint to redirect participants to the target video URL
- All timestamps are in milliseconds (Unix epoch)
- Room state is initialized with default values and updated via WebSocket events
- `GET /api/rooms/:roomId` is an admin API endpoint, separate from the public share endpoint (`GET /:roomId`)
- The share endpoint (`GET /:roomId`) uses HTTP Basic Auth - browsers automatically show a login prompt
- Passwords in Basic Auth are base64 encoded (not encrypted) - always use HTTPS in production
- The `sync_password` parameter in redirect URLs is intentional for browser extension detection
