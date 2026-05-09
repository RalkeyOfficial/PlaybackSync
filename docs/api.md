# HTTP API Reference

This document is the contract between the PHP backend and any client that wants to manage rooms — primarily our own Vue frontend, but also `curl` invocations during local debugging or anybody writing a third-party tool. The implementation is in [`lib/Controller/RoomController.php`](../lib/Controller/RoomController.php) and is small enough to read alongside this document; the goal here is to explain *what* each endpoint does and *why* the response looks the way it does, so you don't have to reverse-engineer the controller every time you forget.

All endpoints live under the prefix `/apps/playbacksync/api/v1/rooms`. The `v1` segment is the explicit version marker for the API — when (if) we ever introduce a backwards-incompatible change to the shape, it will be a `v2` and the `v1` routes will continue to work for as long as we want to support older clients. Every endpoint speaks JSON, both directions; nothing here uses the OCS XML envelope.

## Authentication and authorization

Every endpoint requires an authenticated Nextcloud user. The session cookie set by Nextcloud's web login satisfies this, and so does HTTP Basic authentication with a username and password (or an app password). Unauthenticated requests get an HTTP 401 response with a JSON body.

There is no per-endpoint role check — every method is annotated with `#[NoAdminRequired]`, meaning normal users may call them. The one place where the user's admin status matters is the `restrict_to_admins` `IAppConfig` toggle: when an admin has set that to `'true'`, the `POST /rooms` endpoint will return 403 for non-admin users. Listing, fetching, and deleting are not affected by this toggle — once you have created a room, the toggle does not retroactively prevent you from managing it.

Authorization for individual rooms is by *ownership*. The `oc_playbacksync_rooms` table records the Nextcloud user ID that created each room in the `owner_user_id` column, and the controller enforces that only the owner can see or mutate their rooms. A request from user A asking about user B's room responds with the same 404 as a request for a UUID that does not exist at all, because returning a distinct status would leak the existence of someone else's room.

## Common response shape

A room as returned by the API has six fields plus the optional one-time password. The fields are:

- `uuid` — the public room identifier as a UUIDv4 string. This is what every other endpoint takes as a path parameter.
- `name` — the optional human-friendly nickname the owner gave the room, or `null` if they didn't.
- `targetUrl` — the URL participants will eventually be redirected to when they join. Required at creation, never modified after.
- `createdAt` — unix milliseconds when the row was inserted.
- `expiresAt` — unix milliseconds at which the room becomes invalid. After this point, the row may still physically exist (it's pruned hourly) but the listing endpoint filters it out and the show endpoint returns 404 for it.
- `shareLink` — an absolute URL that, in a future phase, will resolve to a public Basic-Auth-gated entry point for participants. In the MVP it is a placeholder URL that does not yet resolve to anything; clients should still surface it (so users get used to copying it) but should not assume it works yet.
- `password` *(only on the create response)* — the plaintext one-time password. Returned exactly once. Never recoverable. The hash is what's stored in the database; the plaintext is fundamentally lost the moment the response leaves the controller.

Errors come back as a JSON object with a single `error` field containing a human-readable message. The HTTP status code is the primary signal; the message is for surfacing to the user when it makes sense to do so. Validation errors in particular are designed to be safely showable verbatim ("targetUrl must be a valid http(s) URL.").

## Endpoints

### Create a room

```
POST /apps/playbacksync/api/v1/rooms
```

Creates a new room owned by the currently-authenticated user, generates a one-time password, and returns the room details with that password attached. This is the only request in the entire API where the plaintext password is ever exposed.

The body is a JSON object with one required field and two optional ones. `targetUrl` is the absolute URL participants will be redirected to and must be a valid `http://` or `https://` URL — anything else gets a 400. `name` is an optional human-friendly nickname up to 100 characters; if present it must be non-empty after trimming, otherwise it's treated as absent. `ttl` is an optional time-to-live in seconds and must be between 1 and 86400 (one day) inclusive; if absent, the configured default (24 hours unless an admin changed it) is used.

```bash
curl -u alice:alice \
  -H 'OCS-APIRequest: true' \
  -H 'Content-Type: application/json' \
  -X POST 'https://nextcloud.example/index.php/apps/playbacksync/api/v1/rooms' \
  -d '{"targetUrl":"https://example.com/watch/123","name":"Friday movie","ttl":21600}'
```

A successful response is HTTP 201 with the full room representation including the plaintext password:

```json
{
  "uuid": "5a66524f-5ba1-4f3d-8897-7c5838c0bd80",
  "name": "Friday movie",
  "targetUrl": "https://example.com/watch/123",
  "createdAt": 1778325445000,
  "expiresAt": 1778347045000,
  "shareLink": "https://nextcloud.example/index.php/apps/playbacksync/r/5a66524f-...",
  "password": "UIjND2muufTfrrel"
}
```

Possible failures: 400 for invalid input (bad URL, name too long, TTL out of range), 401 for unauthenticated, 403 if `restrict_to_admins` is enabled and the caller is not an admin.

### List your rooms

```
GET /apps/playbacksync/api/v1/rooms
```

Returns the active (non-expired) rooms owned by the currently-authenticated user, newest first. Other users' rooms are never returned — there is no way to enumerate rooms across owners through this endpoint, even for admins.

```bash
curl -u alice:alice \
  -H 'OCS-APIRequest: true' \
  'https://nextcloud.example/index.php/apps/playbacksync/api/v1/rooms'
```

A successful response is HTTP 200 with a JSON object containing a `rooms` array. Each entry is a room object *without* the `password` field, since plaintext passwords are not stored and so cannot be returned later.

```json
{
  "rooms": [
    {
      "uuid": "5a66524f-5ba1-4f3d-8897-7c5838c0bd80",
      "name": "Friday movie",
      "targetUrl": "https://example.com/watch/123",
      "createdAt": 1778325445000,
      "expiresAt": 1778347045000,
      "shareLink": "https://nextcloud.example/index.php/apps/playbacksync/r/5a66524f-..."
    }
  ]
}
```

If the user has no active rooms, the array is empty — the response is `{"rooms":[]}` with status 200. Possible failures: 401 for unauthenticated.

### Get a single room

```
GET /apps/playbacksync/api/v1/rooms/{uuid}
```

Returns the room with the given UUID, provided it exists, has not expired, and is owned by the caller. There is no version of this endpoint that exposes someone else's room.

```bash
curl -u alice:alice \
  -H 'OCS-APIRequest: true' \
  'https://nextcloud.example/index.php/apps/playbacksync/api/v1/rooms/5a66524f-5ba1-4f3d-8897-7c5838c0bd80'
```

A successful response is HTTP 200 with the same shape as one entry from the list endpoint. Possible failures: 401 for unauthenticated, 404 in any of the three "not yours" cases (does not exist, expired, owned by someone else). The 404 surface is deliberately unified: an attacker probing UUIDs cannot distinguish between "this UUID is unused" and "this UUID belongs to a different user".

### Delete a room

```
DELETE /apps/playbacksync/api/v1/rooms/{uuid}
```

Permanently deletes the room. There is no soft-delete or undo; the row is gone immediately. In a future phase where a WebSocket sync server is involved, this will also forcibly disconnect any active participants.

```bash
curl -u alice:alice \
  -H 'OCS-APIRequest: true' \
  -X DELETE \
  'https://nextcloud.example/index.php/apps/playbacksync/api/v1/rooms/5a66524f-5ba1-4f3d-8897-7c5838c0bd80'
```

A successful response is HTTP 204 with no body. Possible failures: 401 for unauthenticated, 404 in the same "not yours" cases as the show endpoint. Calling delete twice on the same UUID returns 200 the first time and 404 the second time, which is fine for idempotency-tolerant clients.

## A note on `OCS-APIRequest`

You'll notice every example above passes `-H 'OCS-APIRequest: true'`. This is technically not required for our endpoints (we are not OCS endpoints), but Nextcloud's CSRF middleware treats the presence of that header as a signal that the request is coming from a programmatic client rather than a browser form, which is exactly the situation `curl` invocations are in. Including it is a habit that prevents intermittent CSRF failures on GET-after-state-change scenarios. The frontend's axios calls don't need it because `@nextcloud/axios` automatically injects the CSRF token cookie value.

## Forward-looking: what changes in Phase 2

When the WebSocket sync server lands, two things will be added:

A new public endpoint at `GET /apps/playbacksync/r/{uuid}` will gate access via HTTP Basic Auth against the room password and redirect successful joiners to the room's `targetUrl` with the WebSocket connection URL appended as a query parameter. That endpoint will be entirely separate from the management API documented here; it lives at a different path, doesn't require Nextcloud login, and is the only place where unauthenticated traffic interacts with PlaybackSync.

The existing room representation will gain a `lastState` field carrying the cached playback state (paused/playing flag, current time, provider, episode). That field will be optional and omitted on rooms that have never had any playback events, so existing API clients are unaffected by its addition. The MVP omits the column entirely to avoid storing a field that has no source.

Neither change breaks the v1 contract documented here. They are additive — new endpoints and new fields — which is why the prefix is `v1` and not just `api`.
