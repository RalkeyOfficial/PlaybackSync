# Rooms API Documentation

This document describes the Room Management API endpoints for PlaybackSync. These endpoints allow you to create and manage synchronized playback rooms.

## Base URL

All endpoints are prefixed with `/api/rooms`.

## Authentication

**Note**: The API endpoints themselves do not require authentication. However, authentication should be handled by an external reverse proxy (e.g., Authelia) in production environments. The server does not implement user authentication.

## Endpoints

### POST /api/rooms

Create a new synchronized playback room.

#### Description

Creates a new room with a unique UUID v4 identifier and a randomly generated password. The room will automatically expire after the specified TTL (Time To Live) period. The password is hashed using HMAC-SHA256 and never stored in plaintext. The plaintext password is only returned once in the creation response.

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

| Field       | Type             | Description                                                                                                                                                                                                                                                                                                                                     |
| ----------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `roomId`    | string (UUID v4) | Unique room identifier. Use this to reference the room in other API calls and WebSocket connections.                                                                                                                                                                                                                                            |
| `password`  | string           | Randomly generated password (16 alphanumeric characters). **This is the only time the plaintext password is returned.** Store it securely. Required for clients to join the room via WebSocket.                                                                                                                                                 |
| `shareLink` | string           | Share link for the room pointing to the public share endpoint (`/:roomId`). Format depends on `SHARE_HOSTNAME` environment variable: <ul><li>If `SHARE_HOSTNAME` is set: `https://{SHARE_HOSTNAME}/{roomId}`</li><li>If not set: `/{roomId}`</li></ul> **Note**: The public share endpoint (`GET /:roomId`) is planned but not yet implemented. |

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

## Environment Variables

The following environment variables affect room behavior:

| Variable           | Default      | Description                                                                                                                                                     |
| ------------------ | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ROOM_TTL_SECONDS` | `86400`      | Default TTL for rooms in seconds (24 hours)                                                                                                                     |
| `SHARE_HOSTNAME`   | -            | Hostname for share links. If set, share links will be full URLs: `https://{SHARE_HOSTNAME}/{roomId}`. If not set, share links are relative paths: `/{roomId}`.  |
| `SYNC_HOSTNAME`    | -            | WebSocket hostname used for sync parameters in share endpoint redirects. Format: `wss://{SYNC_HOSTNAME}/{roomId}`. Required when share endpoint is implemented. |
| `SERVER_SECRET`    | **Required** | Secret key used for HMAC-SHA256 password hashing. Must be set.                                                                                                  |

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

---

## Error Handling

All endpoints return standard HTTP status codes:

| Status Code                 | Description                               |
| --------------------------- | ----------------------------------------- |
| `200 OK`                    | Request successful                        |
| `201 Created`               | Room created successfully                 |
| `400 Bad Request`           | Invalid request body or parameters        |
| `404 Not Found`             | Resource not found (for future endpoints) |
| `500 Internal Server Error` | Server error                              |

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
- Share links point to the public share endpoint (`/:roomId`) which is planned but not yet implemented
- The `targetUrl` parameter is required and is used by the share endpoint to redirect participants to the target video URL
- All timestamps are in milliseconds (Unix epoch)
- Room state is initialized with default values and updated via WebSocket events
- `GET /api/rooms/:roomId` is an admin API endpoint, separate from the public share endpoint (`/:roomId`)

---

## Future Endpoints (Planned)

The following endpoints are planned but not yet implemented:

- `GET /:roomId` - Public share endpoint with password form that redirects to targetUrl with sync parameters
- `DELETE /api/rooms/:roomId` - Delete a room and close all connections

See the implementation plan for details.
