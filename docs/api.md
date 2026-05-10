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
| `GET`    | `/ws/status`            | Whether the WebSocket sync service is installed and configured | `200 OK` | Logged in |

[¹] Subject to the `restrict_to_admins` `IAppConfig` toggle — see [Authentication and authorization](#authentication-and-authorization).

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
| `shareLink`  | string (URL)     | No       | Always       | Absolute URL that *will* resolve to the public Basic-Auth join endpoint in Phase 2. In the MVP it is a forward-looking placeholder; clients should display and copy it, but it does not yet resolve to anything.                                                                                          |
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

## A note on `OCS-APIRequest`

You'll notice every example above passes `-H 'OCS-APIRequest: true'`. This is technically not required for our endpoints (we are not OCS endpoints), but Nextcloud's CSRF middleware treats the presence of that header as a signal that the request is coming from a programmatic client rather than a browser form, which is exactly the situation `curl` invocations are in. Including it is a habit that prevents intermittent CSRF failures on GET-after-state-change scenarios. The frontend's axios calls don't need it because `@nextcloud/axios` automatically injects the CSRF token cookie value.

## Forward-looking: what changes in Phase 2

When the WebSocket sync server lands, the API surface grows in two additive ways. Neither change breaks the `v1` contract documented above — that's exactly why the prefix is `v1` and not just `api`.

| Change                     | Today (MVP)                                          | Phase 2                                                                                                       |
|----------------------------|------------------------------------------------------|---------------------------------------------------------------------------------------------------------------|
| `shareLink` resolves       | No (placeholder URL, returns 404 if visited)         | Yes (`GET /apps/playbacksync/r/{uuid}` gates on Basic Auth against the room password, then redirects)         |
| Public unauthenticated path| None                                                 | Exactly one: the share endpoint above. All other endpoints stay Nextcloud-login-gated.                        |
| `lastState` field          | Absent — column does not exist                        | Present on rooms that have had playback activity. Carries paused flag, current time, provider, episode.       |
| WebSocket connection URL   | N/A                                                  | Appended to the redirect target as a query parameter so the browser extension can pick it up                  |

The share endpoint is intentionally separate from the management API. It lives at a different path (`/r/{uuid}` rather than `/api/v1/rooms/{uuid}`), it doesn't require a Nextcloud login, and it's the only place where unauthenticated traffic interacts with PlaybackSync. Keeping it cordoned off makes it easy to reason about the public attack surface in isolation.

The `lastState` field will be optional on the response — omitted entirely on rooms that have never had any playback events — so existing API clients are unaffected by its addition. The MVP omits the database column for the same reason: there is no source for the data yet, and adding the column now would just be an empty `NULL`.
