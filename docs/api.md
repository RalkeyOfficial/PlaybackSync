# HTTP API Reference

This document is the contract between the PHP backend and any client that wants to manage rooms — primarily our own Vue frontend, but also `curl` invocations during local debugging or anybody writing a third-party tool. The implementation is in [`lib/Controller/RoomController.php`](../lib/Controller/RoomController.php) and is small enough to read alongside this document; the goal here is to explain *what* each endpoint does and *why* the response looks the way it does, so you don't have to reverse-engineer the controller every time you forget.

All endpoints live under the prefix `/apps/playbacksync/api/v1/rooms`. The `v1` segment is the explicit version marker for the API — when (if) we ever introduce a backwards-incompatible change to the shape, it will be a `v2` and the `v1` routes will continue to work for as long as we want to support older clients. Every endpoint speaks JSON, both directions; nothing here uses the OCS XML envelope.

## Endpoints at a glance

| Method   | Path                    | Purpose                                  | Success status     | Auth         |
|----------|-------------------------|------------------------------------------|--------------------|--------------|
| `POST`   | `/rooms`                | Create a new room (returns one-time pwd) | `201 Created`      | Logged in[¹] |
| `GET`    | `/rooms`                | List the caller's active rooms           | `200 OK`           | Logged in    |
| `GET`    | `/rooms/{uuid}`         | Fetch one of the caller's rooms          | `200 OK`           | Logged in    |
| `DELETE` | `/rooms/{uuid}`         | Permanently delete one of caller's rooms | `204 No Content`   | Logged in    |
| `DELETE` | `/rooms/{uuid}/clients/{clientId}` | Forcibly disconnect one connected client | `204 No Content`   | Logged in    |
| `POST`   | `/rooms/{uuid}/playback` | Owner-initiated play/pause/seek/reset broadcast to every client | `204 No Content` | Logged in |
| `GET`    | `/ws/status`            | Whether the WebSocket sync service is installed and configured | `200 OK` | Logged in |
| `GET`    | `/health`               | WebSocket sync daemon liveness + light stats | `200 OK` | Public |
| `GET`    | `/r/{uuid}`[²]          | Public share link — Basic Auth gate, then 302 to target with sync params | `302 Found` | Public (Basic Auth password) |

[¹] Subject to the `restrict_to_admins` `IAppConfig` toggle — see [Authentication and authorization](#authentication-and-authorization).

[²] Lives outside the `/api/v1` prefix because it's not a JSON API call — it's a redirect target meant to be opened in a browser.

## Authentication and authorization

Every endpoint requires an authenticated Nextcloud user. The session cookie set by Nextcloud's web login satisfies this, and so does HTTP Basic authentication with a username and password (or an app password). Unauthenticated requests get an HTTP 401 response with a JSON body.

There is no per-endpoint role check — every method is annotated with `#[NoAdminRequired]`, meaning normal users may call them. The one place where the user's admin status matters is the `restrict_to_admins` `IAppConfig` toggle: when an admin has set that to `'true'`, the `POST /rooms` endpoint will return 403 for non-admin users. Listing, fetching, and deleting are not affected by this toggle — once you have created a room, the toggle does not retroactively prevent you from managing it.

Authorization for individual rooms is by *ownership*. The `oc_playbacksync_rooms` table records the Nextcloud user ID that created each room in the `owner_user_id` column, and the controller enforces that only the owner can see or mutate their rooms. A request from user A asking about user B's room responds with the same 404 as a request for a UUID that does not exist at all, because returning a distinct status would leak the existence of someone else's room.

## The Room object

Every successful response that includes a room (or rooms) uses the same field shape, with one variation: the `password` field appears *only* on the response from the create endpoint, and only on that one occasion in the room's lifetime. After that, the plaintext is unrecoverable; the database stores only an `argon2id` hash and there is no API surface that returns it.

| Field        | Type             | Nullable | When present | Description                                                                                                                                                                                                                                                                                                |
|--------------|------------------|----------|--------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `uuid`       | string (UUID v4) | No       | Always       | Public room identifier. Used as the path parameter for every other endpoint.                                                                                                                                                                                                                               |
| `name`       | string \| `null` | Yes      | Always       | Human-friendly nickname the owner picked at creation. `null` if the owner did not supply one.                                                                                                                                                                                                              |
| `targetUrl`  | string (URL)     | No       | Always       | Absolute `http://` or `https://` URL participants will eventually be redirected to. Required at creation, never modified after.                                                                                                                                                                            |
| `createdAt`  | integer (ms)     | No       | Always       | Unix timestamp in **milliseconds** at which the room was created.                                                                                                                                                                                                                                          |
| `expiresAt`  | integer (ms)     | No       | Always       | Unix timestamp in **milliseconds** at which the room becomes invalid. After this point the row is invisible to API callers and is physically deleted by the prune job within the next hour.                                                                                                               |
| `shareLink`  | string (URL)     | No       | Always       | Absolute URL of the public Basic-Auth join endpoint — see [Public share endpoint](#public-share-endpoint-ruuid). Clients should display and copy it; opening it in a browser triggers the password prompt.                                                                                                |
| `password`   | string           | No       | Create only  | The 16-character plaintext one-time password, returned exactly once at creation time. Only ever appears on the `201` response from `POST /rooms`. The list, show, and delete endpoints never include it.                                                                                                  |

### Error response shape

Failures use a uniform JSON shape: a single `error` field with a human-readable message. The HTTP status code is the primary signal; the message is for surfacing to the user when it makes sense to do so. Validation errors in particular are designed to be safely showable verbatim — for example, `"targetUrl must be a valid http(s) URL."` is exactly the string the frontend can display in a toast.

```json
{
  "error": "Room creation is restricted to administrators."
}
```

### Status codes used across the API

| Status code         | Meaning in this API                                                                                       |
|---------------------|-----------------------------------------------------------------------------------------------------------|
| `200 OK`            | Successful read (list or single room).                                                                    |
| `201 Created`       | Successful create. Body includes the one-time `password` field.                                           |
| `204 No Content`    | Successful delete. No body.                                                                               |
| `400 Bad Request`   | Validation failure — invalid URL, name too long, TTL out of range. The `error` message is user-safe.      |
| `401 Unauthorized`  | No authenticated Nextcloud user. Pass a session cookie or HTTP Basic credentials.                         |
| `403 Forbidden`     | `restrict_to_admins` is enabled and the caller is not an admin. Only ever raised by `POST /rooms`.        |
| `404 Not Found`     | Room not yours, expired, or genuinely unknown. The three are deliberately collapsed into the same error.  |

## Endpoints

### Create a room

```
POST /apps/playbacksync/api/v1/rooms
```

Creates a new room owned by the currently-authenticated user, generates a one-time password, and returns the room details with that password attached. This is the only request in the entire API where the plaintext password is ever exposed — the moment the `201` response leaves the server, the plaintext is gone forever.

#### Request body

```json
{
  "targetUrl": "https://example.com/watch/123",
  "name":      "Friday movie",
  "ttl":       21600
}
```

| Field        | Type    | Required | Constraints                                                                              | Default                               |
|--------------|---------|----------|------------------------------------------------------------------------------------------|---------------------------------------|
| `targetUrl`  | string  | Yes      | Must be a valid `http://` or `https://` URL.                                             | —                                     |
| `name`       | string  | No       | Max 100 characters after trimming. Empty/whitespace is treated as omitted.               | `null`                                |
| `ttl`        | integer | No       | Time-to-live in **seconds**. Must satisfy `1 ≤ ttl ≤ 86400` (one day).                    | `default_ttl_seconds` IAppConfig key, 86400 if unset |

#### Success response

`HTTP 201 Created`. The body is the standard Room object plus the one-time `password` field:

```json
{
  "uuid":      "5a66524f-5ba1-4f3d-8897-7c5838c0bd80",
  "name":      "Friday movie",
  "targetUrl": "https://example.com/watch/123",
  "createdAt": 1778325445000,
  "expiresAt": 1778347045000,
  "shareLink": "https://nextcloud.example/index.php/apps/playbacksync/r/5a66524f-...",
  "password":  "UIjND2muufTfrrel"
}
```

#### Failure modes

| Status | Trigger                                                                                                  | Example `error` message                                  |
|--------|----------------------------------------------------------------------------------------------------------|----------------------------------------------------------|
| 400    | `targetUrl` missing, malformed, or not http(s).                                                          | `targetUrl must be a valid http(s) URL.`                 |
| 400    | `name` longer than 100 characters.                                                                       | `name exceeds maximum length.`                           |
| 400    | `ttl` outside the `[1, 86400]` range.                                                                    | `ttl must be between 1 and 86400 seconds.`               |
| 401    | No authenticated Nextcloud user on the request.                                                          | `Authentication required.`                               |
| 403    | `restrict_to_admins` is enabled and the caller is not an admin.                                          | `Room creation is restricted to administrators.`         |

#### Example

```bash
curl -u alice:alice \
  -H 'OCS-APIRequest: true' \
  -H 'Content-Type: application/json' \
  -X POST 'https://nextcloud.example/index.php/apps/playbacksync/api/v1/rooms' \
  -d '{"targetUrl":"https://example.com/watch/123","name":"Friday movie","ttl":21600}'
```

### List your rooms

```
GET /apps/playbacksync/api/v1/rooms
```

Returns the active (non-expired) rooms owned by the currently-authenticated user, newest first. Other users' rooms are never returned — there is no way to enumerate rooms across owners through this endpoint, even for admins.

#### Success response

`HTTP 200 OK`. Body is a JSON object with a single `rooms` key containing an array of Room objects (without `password`). If the user has no active rooms, the array is empty rather than the response being a 404 — `{"rooms":[]}` is the canonical "empty" reply.

```json
{
  "rooms": [
    {
      "uuid":      "5a66524f-5ba1-4f3d-8897-7c5838c0bd80",
      "name":      "Friday movie",
      "targetUrl": "https://example.com/watch/123",
      "createdAt": 1778325445000,
      "expiresAt": 1778347045000,
      "shareLink": "https://nextcloud.example/index.php/apps/playbacksync/r/5a66524f-..."
    }
  ]
}
```

#### Failure modes

| Status | Trigger                                              |
|--------|------------------------------------------------------|
| 401    | No authenticated Nextcloud user on the request.      |

#### Example

```bash
curl -u alice:alice \
  -H 'OCS-APIRequest: true' \
  'https://nextcloud.example/index.php/apps/playbacksync/api/v1/rooms'
```

### Get a single room

```
GET /apps/playbacksync/api/v1/rooms/{uuid}
```

Returns the room with the given UUID, provided it exists, has not expired, and is owned by the caller. There is no version of this endpoint that exposes someone else's room.

#### Path parameters

| Parameter | Type             | Description                              |
|-----------|------------------|------------------------------------------|
| `uuid`    | string (UUID v4) | The `uuid` field of an existing room.    |

#### Success response

`HTTP 200 OK`. Body is a Room object (no `password` field).

```json
{
  "uuid":      "5a66524f-5ba1-4f3d-8897-7c5838c0bd80",
  "name":      "Friday movie",
  "targetUrl": "https://example.com/watch/123",
  "createdAt": 1778325445000,
  "expiresAt": 1778347045000,
  "shareLink": "https://nextcloud.example/index.php/apps/playbacksync/r/5a66524f-..."
}
```

#### Failure modes

| Status | Trigger                                                                                  |
|--------|------------------------------------------------------------------------------------------|
| 401    | No authenticated Nextcloud user on the request.                                          |
| 404    | UUID does not exist, room is past `expiresAt`, **or** room is owned by a different user. |

The 404 surface deliberately collapses three distinct cases into one. An attacker probing UUIDs cannot tell "this UUID is unused" from "this UUID belongs to a different user", which is the property we want.

#### Example

```bash
curl -u alice:alice \
  -H 'OCS-APIRequest: true' \
  'https://nextcloud.example/index.php/apps/playbacksync/api/v1/rooms/5a66524f-5ba1-4f3d-8897-7c5838c0bd80'
```

### Delete a room

```
DELETE /apps/playbacksync/api/v1/rooms/{uuid}
```

Permanently deletes the room. There is no soft-delete or undo; the row is gone immediately. The WebSocket sync server is not signalled by this call — connected clients will fail their next heartbeat (because the room is gone) and reconnect attempts will get `ROOM_NOT_FOUND`. To disconnect a single participant without deleting the room, use the kick endpoint below.

#### Path parameters

| Parameter | Type             | Description                              |
|-----------|------------------|------------------------------------------|
| `uuid`    | string (UUID v4) | The `uuid` field of an existing room.    |

#### Success response

`HTTP 204 No Content`. The body is empty.

#### Failure modes

| Status | Trigger                                                                                  |
|--------|------------------------------------------------------------------------------------------|
| 401    | No authenticated Nextcloud user on the request.                                          |
| 404    | UUID does not exist, room is past `expiresAt`, or room is owned by a different user.     |

Calling delete twice on the same UUID returns `204` the first time and `404` the second time. That is intended — the second call legitimately can't find the room — and is fine for idempotency-tolerant clients that just want "make sure this is gone".

#### Example

```bash
curl -u alice:alice \
  -H 'OCS-APIRequest: true' \
  -X DELETE \
  'https://nextcloud.example/index.php/apps/playbacksync/api/v1/rooms/5a66524f-5ba1-4f3d-8897-7c5838c0bd80'
```

### Disconnect a connected client

```
DELETE /apps/playbacksync/api/v1/rooms/{uuid}/clients/{clientId}
```

Forcibly disconnects one connected client from one of the caller's rooms. The WebSocket sync server sends the targeted client a final `{type:"ERROR", code:"KICKED"}` frame, closes the socket, and refuses any reconnect attempt that uses the same `clientId` for `ws_kick_block_ms` (default 30 seconds). The caller's other clients see the kicked participant disappear from `live.clients` on the next refresh.

The block is in-memory and cleared on daemon restart; it's there to prevent immediate re-flap, not to be a persistent ban — a determined client can rejoin with a fresh `clientId`.

#### Path parameters

| Parameter   | Type             | Description                                                                            |
|-------------|------------------|----------------------------------------------------------------------------------------|
| `uuid`      | string (UUID v4) | The `uuid` field of an existing room owned by the caller.                              |
| `clientId`  | hex string       | The opaque per-connection identifier surfaced under `live.clients[].clientId`.          |

#### Success response

`HTTP 204 No Content`. The body is empty.

#### Failure modes

| Status | Trigger                                                                                            |
|--------|----------------------------------------------------------------------------------------------------|
| 401    | No authenticated Nextcloud user on the request.                                                    |
| 404    | Room UUID unknown / not owned / expired, **or** the `clientId` is not currently connected.         |
| 502    | The PHP side could not reach the WebSocket sync daemon (daemon down, admin secret misconfigured).  |

The 404 surface is deliberately collapsed: the caller doesn't get to distinguish "room belongs to someone else" from "room exists but client just disconnected". This mirrors the privacy property already documented for `GET /rooms/{uuid}`.

#### Example

```bash
curl -u alice:alice \
  -H 'OCS-APIRequest: true' \
  -X DELETE \
  'https://nextcloud.example/index.php/apps/playbacksync/api/v1/rooms/5a66524f-5ba1-4f3d-8897-7c5838c0bd80/clients/3f9b1a2c4d5e6f70'
```

### Send a playback command

```
POST /apps/playbacksync/api/v1/rooms/{uuid}/playback
```

Lets the room owner drive playback for every connected client from outside the WebSocket protocol — typically from the dashboard's room detail modal. The PHP side relays the command to the daemon's loopback admin channel, which mutates the room's authoritative `PlaybackState`, appends to the event log (so reconnecting clients replay the change), and broadcasts a `STATE` frame to every active connection in the room. The behaviour is identical to what happens when a connected client sends a peer-to-peer `EVENT` frame, except the originator here is the dashboard rather than a participant.

Because the daemon's runtime only exists once at least one client has joined, sending a command to an idle room responds with `409 Conflict` and an `error: "room_not_live"` body — there's nothing in memory to mutate yet. The dashboard surfaces this as "no clients are connected to this room yet"; create a connection first, then issue the command.

#### Path parameters

| Parameter | Type             | Description                                               |
|-----------|------------------|-----------------------------------------------------------|
| `uuid`    | string (UUID v4) | The `uuid` field of an existing room owned by the caller. |

#### Request body

JSON object:

| Field      | Type      | Required               | Description                                                                                       |
|------------|-----------|------------------------|---------------------------------------------------------------------------------------------------|
| `action`   | string    | yes                    | One of `play`, `pause`, `seek`, `reset`. `reset` is a convenience for "pause then seek to 0".     |
| `videoPos` | number ≥0 | yes when `action=seek` | Target playback position in seconds. Ignored for non-`seek` actions.                              |

#### Success response

`HTTP 204 No Content`. The body is empty. The state change is visible to every connected client immediately (the broadcast happens before the response returns) and to the dashboard on its next room refresh.

#### Failure modes

| Status | Body                          | Trigger                                                                                                     |
|--------|-------------------------------|-------------------------------------------------------------------------------------------------------------|
| 400    | `{"error":"invalid_action"}`  | `action` is missing or not one of the four allowed values.                                                  |
| 400    | `{"error":"invalid_position"}` | `action: "seek"` without a non-negative numeric `videoPos`.                                                 |
| 401    | `{"error":"…"}`               | No authenticated Nextcloud user on the request.                                                             |
| 404    | `{"error":"Room not found."}` | Room UUID unknown / not owned / expired. Collapses with cross-user access, same as every other room route.  |
| 409    | `{"error":"room_not_live"}`   | The daemon has no live runtime for the room — no client has joined yet, so there's no state to drive.       |
| 502    | `{"error":"…"}`               | The PHP side could not reach the WebSocket sync daemon (daemon down, admin secret misconfigured).           |

#### Examples

Play / pause:

```bash
curl -u alice:alice \
  -H 'OCS-APIRequest: true' \
  -H 'Content-Type: application/json' \
  -X POST \
  -d '{"action":"play"}' \
  'https://nextcloud.example/index.php/apps/playbacksync/api/v1/rooms/5a66524f-5ba1-4f3d-8897-7c5838c0bd80/playback'
```

Seek to 2 minutes 47 seconds:

```bash
curl -u alice:alice \
  -H 'OCS-APIRequest: true' \
  -H 'Content-Type: application/json' \
  -X POST \
  -d '{"action":"seek","videoPos":167}' \
  'https://nextcloud.example/index.php/apps/playbacksync/api/v1/rooms/5a66524f-5ba1-4f3d-8897-7c5838c0bd80/playback'
```

### WebSocket service status

Tells the caller whether the WebSocket sync service is installed and configured on this Nextcloud instance. Use it to decide whether to expose sync UI in the client; the WS connection itself will surface any *liveness* issue when the client tries to open the socket.

```
GET /apps/playbacksync/api/v1/ws/status
```

#### Success response

`200 OK`

```json
{ "available": true }
```

`available` is `true` only if both:

- The daemon's Composer dependencies (Ratchet) are loadable in the PHP runtime — i.e., somebody ran `composer install` in the app directory.
- Both `ws_host` and `ws_port` `IAppConfig` keys are non-empty.

The check is intentionally local-only — it does not reach across the network to probe the daemon process, because in containerised setups the PHP container often can't reach the daemon's bind address regardless of whether the daemon is running. Treat `available: true` as "the admin has set up sync"; treat WS connection failures at the client as "sync is configured but currently unreachable".

#### Failure modes

This endpoint has none beyond the global authentication check. It always returns `200`.

#### Example

```bash
curl -u alice:alice \
  -H 'OCS-APIRequest: true' \
  'https://nextcloud.example/index.php/apps/playbacksync/api/v1/ws/status'
```

### Public share endpoint (`/r/{uuid}`)

```
GET /apps/playbacksync/r/{uuid}
```

The link participants are given when an owner shares a room. This is the only path on the app that does not require a Nextcloud login — instead it gates on the room's password via HTTP Basic Auth and, on success, 302-redirects the visitor to the room's `targetUrl` with two query parameters appended (`sync_url` and `sync_password`) that downstream consumers (a browser extension, an embedded player) use to join the synchronized session.

The route lives outside `/api/v1/` because it isn't a JSON API call — it's a redirect target meant to be opened in a browser. The contract intentionally mirrors the original Fastify implementation in `OLD_CODE/server/src/routes/share.ts` so existing extension code continues to work unchanged.

#### Path parameters

| Parameter | Type             | Description                              |
|-----------|------------------|------------------------------------------|
| `uuid`    | string (UUID v4) | The `uuid` field of an existing room.    |

#### Authentication

HTTP Basic Auth. The username is **ignored** (browsers strip user info from URLs anyway); only the password matters and is compared against the room's argon2id hash. On a missing or malformed `Authorization` header, the response is `401 Unauthorized` with `WWW-Authenticate: Basic realm="Room {uuid}"`, which triggers the browser's native password prompt.

#### Brute-force protection

Failed password attempts are registered with Nextcloud's `IThrottler` under the action name `playbacksync_share` and are subject to anonymous rate limiting (`#[AnonRateLimit(limit: 60, period: 60)]`). Repeated wrong-password attempts from the same IP get progressively delayed. *Missing* or malformed `Authorization` headers do not register as attempts — only verified-but-wrong passwords feed the throttler, so the very first hit (which by design has no credentials) isn't penalized.

#### Success response

`HTTP 302 Found`. Body is intentionally empty; the `Location` header points at the room's `targetUrl` with `sync_url` and `sync_password` merged into its query string. Existing query parameters on `targetUrl` are preserved; the URL fragment, if any, is preserved after the merged query.

| Query param      | Value                                                                              |
|------------------|------------------------------------------------------------------------------------|
| `sync_url`       | `wss://<nextcloud-host>/apps/playbacksync/ws/{uuid}` (`ws://` for plain-HTTP setups). Derived from `IURLGenerator::getAbsoluteURL` — same host the share link was served from. |
| `sync_password`  | The plaintext password the visitor just submitted via Basic Auth. Forwarded so the downstream consumer can present it on the WebSocket `JOIN`. |

Example `Location` for a room whose `targetUrl` is `https://video.example/watch?ep=2`:

```
https://video.example/watch?ep=2&sync_url=wss%3A%2F%2Fcloud.example%2Fapps%2Fplaybacksync%2Fws%2F5a66524f-...&sync_password=UIjND2muufTfrrel
```

#### Failure modes

| Status | Trigger                                                                                              | Body                          | `WWW-Authenticate` | Throttled? |
|--------|------------------------------------------------------------------------------------------------------|-------------------------------|--------------------|------------|
| 404    | UUID does not exist **or** room is past `expiresAt`. Collapsed deliberately — no leak.               | `{"error":"not_found"}`       | not set            | no         |
| 401    | No `Authorization` header, header isn't `Basic`, or base64/`:` parsing fails.                        | `{"error":"unauthorized"}`    | `Basic realm="…"`  | no         |
| 401    | Password verification failed against `Room::passwordHash`.                                            | `{"error":"unauthorized"}`    | `Basic realm="…"`  | yes (`playbacksync_share`) |

#### Example

```bash
# Without a password — expect 401 + WWW-Authenticate
curl -i 'https://nextcloud.example/index.php/apps/playbacksync/r/5a66524f-5ba1-4f3d-8897-7c5838c0bd80'

# With the password — expect 302 with Location populated
curl -i -u :UIjND2muufTfrrel \
  'https://nextcloud.example/index.php/apps/playbacksync/r/5a66524f-5ba1-4f3d-8897-7c5838c0bd80'
```

### WebSocket sync daemon healthcheck

```
GET /apps/playbacksync/api/v1/health
```

Public liveness probe for the WebSocket sync daemon. Designed for external monitors (k8s probes, status pages, uptime checks) that need a stable URL on the Nextcloud webroot. The daemon's actual health endpoint is loopback-only on `ws_admin_port`; this route loopback-calls it and surfaces the result through the normal Nextcloud HTTP surface.

This route is `#[PublicPage]` — no Nextcloud login required. The response carries no sensitive data (no UUIDs, no client IDs, no IPs, no secrets) — only aggregate counts and timings. The response body is intentionally compact enough to be polled aggressively without measurable cost.

#### Success response

`HTTP 200 OK`. **Always 200**, even when the daemon is unreachable — load balancers and humans alike misread a 5xx from a healthcheck. The `status` field is the primary signal.

When the daemon is reachable and healthy:

```json
{
  "status": "ok",
  "daemon": {
    "reachable": true,
    "latency_ms": 3,
    "body": {
      "status": "ok",
      "daemon_version": "0.3.0",
      "uptime_seconds": 12345,
      "timestamp_ms": 1715339000000,
      "rooms":   { "active": 4 },
      "clients": { "connected": 11 },
      "tick":    { "running": true, "last_tick_ms_ago": 982 }
    }
  }
}
```

When the daemon cannot be reached (process down, `ws_admin_secret` unset so the admin port isn't bound, loopback host/port misconfigured):

```json
{
  "status": "degraded",
  "daemon": {
    "reachable": false,
    "error": "request_failed"
  }
}
```

`error` is a short machine-readable token: `request_failed` (transport error / timeout), `http_<status>` (daemon answered with non-200), or `invalid_json` (daemon body wasn't JSON). Operators wanting a richer diagnosis should look in the Nextcloud log for the matching `HealthClient` warning.

| Field                          | Type                       | Description                                                                                       |
|--------------------------------|----------------------------|---------------------------------------------------------------------------------------------------|
| `status`                       | `"ok"` \| `"degraded"`     | Top-level signal. `"ok"` only when the daemon was reachable AND its own `status` was `"ok"`.      |
| `daemon.reachable`             | boolean                    | Whether the loopback HTTP call to the daemon succeeded.                                           |
| `daemon.latency_ms`            | integer                    | (reachable only) Round-trip latency of the loopback probe.                                        |
| `daemon.error`                 | string                     | (unreachable only) `request_failed`, `http_<status>`, or `invalid_json`.                          |
| `daemon.body.daemon_version`   | string                     | App version of the daemon process.                                                                |
| `daemon.body.uptime_seconds`   | integer                    | Wall-clock seconds since the daemon process started serving.                                      |
| `daemon.body.timestamp_ms`     | integer (ms)               | Daemon's current wall clock at the moment of the response.                                        |
| `daemon.body.rooms.active`     | integer                    | Rooms with at least one connection or recent activity tracked in memory.                          |
| `daemon.body.clients.connected`| integer                    | Sum of `clientCount()` across all in-memory rooms.                                                |
| `daemon.body.tick.running`     | boolean                    | Whether the housekeeping loop has run within the last 5 seconds.                                  |
| `daemon.body.tick.last_tick_ms_ago` | integer \| `null`     | Milliseconds since the last tick. `null` before the loop's first run.                             |

#### Failure modes

This endpoint has none. It is `#[PublicPage]`, so authentication can't fail; daemon issues collapse to `status: "degraded"` with a `200`. The only way to get a non-200 here is a bug in PHP itself.

#### Example

```bash
curl -s 'https://nextcloud.example/index.php/apps/playbacksync/api/v1/health'
```

## A note on `OCS-APIRequest`

You'll notice every example above passes `-H 'OCS-APIRequest: true'`. This is technically not required for our endpoints (we are not OCS endpoints), but Nextcloud's CSRF middleware treats the presence of that header as a signal that the request is coming from a programmatic client rather than a browser form, which is exactly the situation `curl` invocations are in. Including it is a habit that prevents intermittent CSRF failures on GET-after-state-change scenarios. The frontend's axios calls don't need it because `@nextcloud/axios` automatically injects the CSRF token cookie value.

## Forward-looking: what changes in Phase 2

When the WebSocket sync server lands, the API surface grows in two additive ways. Neither change breaks the `v1` contract documented above — that's exactly why the prefix is `v1` and not just `api`.

| Change                     | Today                                                | Phase 2                                                                                                       |
|----------------------------|------------------------------------------------------|---------------------------------------------------------------------------------------------------------------|
| `lastState` field          | Absent — column does not exist                        | Present on rooms that have had playback activity. Carries paused flag, current time, provider, episode.       |

The share endpoint is intentionally separate from the management API. It lives at a different path (`/r/{uuid}` rather than `/api/v1/rooms/{uuid}`), it doesn't require a Nextcloud login, and it's the only place where unauthenticated traffic interacts with PlaybackSync (alongside the public `/health` probe). Keeping it cordoned off makes it easy to reason about the public attack surface in isolation.

The `lastState` field will be optional on the response — omitted entirely on rooms that have never had any playback events — so existing API clients are unaffected by its addition. The MVP omits the database column for the same reason: there is no source for the data yet, and adding the column now would just be an empty `NULL`.
