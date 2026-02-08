# PlaybackSync – Rooms HTTP API

This document describes the HTTP API exposed by the PlaybackSync backend for creating, managing, and accessing synchronized playback rooms. It is intended for operators, backend integrators, and tooling (dashboards, extensions, automation).

The API is intentionally simple: room management is handled over HTTP, while real‑time synchronization happens over WebSockets.

---

## Overview

There are three categories of endpoints:

• **Admin API** – JSON REST endpoints for creating and managing rooms
• **Public Share Endpoint** – user‑facing entrypoint protected by HTTP Basic Auth
• **Operational Endpoints** – health checks and Prometheus metrics

Rooms are stored **in memory only**. All rooms are lost when the server restarts.

---

## Base Paths

• Admin API: `/admin/api/rooms/*`
• Public share endpoint: `/:roomId`
• Health check: `/healthz`
• Metrics: `/metrics`

---

## Authentication Model

### Admin API

The server does **not** implement authentication for admin endpoints.

In production, you **must** protect `/admin/api/rooms/*` at the reverse‑proxy layer (Traefik, Nginx, Caddy, etc.) using an external auth provider such as Authentik, Authelia, OAuth2‑Proxy, or Keycloak.

### Public Share Endpoint

The share endpoint (`GET /:roomId`) uses **HTTP Basic Authentication** built into the server.

• Username is ignored and may be empty
• Password must match the room password
• Browsers automatically show a login prompt

Always use HTTPS in production.

---

## Room Lifecycle

1. Room is created via `POST /admin/api/rooms`
2. Room remains active until TTL expiration or explicit deletion
3. Expired rooms are automatically removed
4. Deleted or expired rooms return `404 Not Found`

TTL is defined in seconds and converted internally to an expiration timestamp.

---

## Admin API Endpoints

### Create Room

**POST `/admin/api/rooms`**

Creates a new playback room.

Request body (JSON):

| Field | Type | Required | Description |
|------|------|----------|-------------|
| `targetUrl` | string | yes | Absolute URL to the video page that clients will be redirected to |
| `ttl` | number | no | Time-to-live in seconds (minimum: 1). Defaults to `ROOM_TTL_SECONDS` |

Response – `201 Created`:

| Field | Type | Description |
|------|------|-------------|
| `roomId` | string (UUID v4) | Unique room identifier |
| `password` | string | Randomly generated 16-character alphanumeric password (returned once) |
| `shareLink` | string | Public share URL or relative path |

The plaintext password is **never stored** and **never returned again**.

---

### List Rooms

**GET `/admin/api/rooms`**

Returns all currently active rooms. Expired rooms are filtered automatically.

Response – `200 OK`:

Array of room summaries:

| Field | Type | Description |
|------|------|-------------|
| `id` | string (UUID) | Room identifier |
| `createdAt` | number | Creation timestamp (ms) |
| `expiresAt` | number | Expiration timestamp (ms) |
| `participantCount` | number | Active WebSocket connections |
| `last_state` | object | Current playback state snapshot |

If no rooms exist, an empty array is returned.

---

### Get Room Details

**GET `/admin/api/rooms/:roomId`**

Returns detailed information about a single room.

Response – `200 OK`:

| Field | Type | Description |
|------|------|-------------|
| `roomId` | string | Room identifier |
| `createdAt` | number | Creation timestamp (ms) |
| `expiresAt` | number | Expiration timestamp (ms) |
| `targetUrl` | string | Original target URL |
| `state` | object | Authoritative playback state |
| `connectedClients` | array | Active and tombstoned clients |
| `recentEvents` | array | Ring buffer of recent events |

This endpoint is **administrative** and does not perform redirects.

---

### Delete Room

**DELETE `/admin/api/rooms/:roomId`**

Immediately destroys a room and disconnects all clients.

Response – `204 No Content`

Deletion is irreversible. Clients are forcibly disconnected.

---

## Public Share Endpoint

### Join Room

**GET `/:roomId`**

Public entrypoint used by participants.

Behavior:

1. Browser requests `/:roomId`
2. Server responds `401 Unauthorized` with `WWW‑Authenticate`
3. Browser shows Basic Auth prompt
4. On success, server redirects to `targetUrl`

Successful response:

• `302 Found`
• `Location` header pointing to `targetUrl` with sync parameters

Appended query parameters:

• `sync_url` – WebSocket URL (`wss://{SYNC_HOSTNAME}/{roomId}`)
• `sync_password` – room password (plaintext)

These parameters are intentionally exposed for browser‑extension detection.

If `targetUrl` already contains query parameters, they are preserved.

---

## Operational Endpoints

### Health Check

**GET `/healthz`**

Returns basic server health information.

Response – `200 OK`:

• `status` – always `"ok"`
• `timestamp` – current server time (ms)
• `uptime` – process uptime (seconds)

No authentication required.

---

### Metrics

**GET `/metrics`**

Exposes Prometheus‑formatted metrics.

Response:

• Content‑Type: `text/plain; version=0.0.4`
• Standard process metrics
• PlaybackSync room, connection, and event metrics

Restrict access in production if required.

---

## Environment Variables

• `ROOM_TTL_SECONDS` – default room TTL (seconds)
• `SHARE_HOSTNAME` – hostname used for share links
• `SYNC_HOSTNAME` – hostname used for WebSocket URLs (required in production)
• `SERVER_SECRET` – HMAC secret for password hashing (required)

---

## Error Handling

The API uses standard HTTP status codes:

• `200 OK`
• `201 Created`
• `204 No Content`
• `302 Found`
• `400 Bad Request`
• `401 Unauthorized`
• `404 Not Found`
• `500 Internal Server Error`

Error responses follow Fastify’s default format:

• `statusCode`
• `error`
• `message`

Expired rooms intentionally return `404` to avoid information disclosure.

---

## Security Notes

• Passwords are HMAC‑SHA256 hashed and never stored in plaintext
• Basic Auth passwords are base64‑encoded, not encrypted
• Always deploy behind HTTPS
• Failed authentication attempts are logged but not rate‑limited

---

## Limitations

• Rooms are in‑memory only
• No persistence across restarts
• No built‑in authentication for admin endpoints

These are intentional design tradeoffs for simplicity and predictability.

