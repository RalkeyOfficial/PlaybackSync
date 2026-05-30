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
| `POST`   | `/rooms/{uuid}/settings` | Flip `singleMode` / `freeformMode`            | `200 OK`           | Logged in    |
| `POST`   | `/rooms/{uuid}/playlist/entries` | Add one curated playlist entry          | `200 OK`           | Logged in    |
| `DELETE` | `/rooms/{uuid}/playlist/entries/{entryId}` | Remove a playlist entry           | `204 No Content`   | Logged in    |
| `POST`   | `/rooms/{uuid}/cursor`  | Move the cursor to an existing entry          | `204 No Content`   | Logged in    |
| `GET`    | `/rooms/{uuid}/playlist` | Fetch the room's full playlist + version     | `200 OK`           | Logged in    |
| `POST`   | `/metadata/lookup`      | Resolve a pasted page URL to `(providerId, videoId, label)` for the create-room seed flow | `200 OK` | Logged in |
| `GET`    | `/ws/status`            | Whether the WebSocket sync service is usable (installed, configured, and the daemon is reachable) | `200 OK` | Logged in |
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

| Field            | Type              | Nullable | When present | Description                                                                                                                                                                                                                                                                                                |
|------------------|-------------------|----------|--------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `uuid`           | string (UUID v4)  | No       | Always       | Public room identifier. Used as the path parameter for every other endpoint.                                                                                                                                                                                                                               |
| `name`           | string \| `null`  | Yes      | Always       | Human-friendly nickname the owner picked at creation. `null` if the owner did not supply one.                                                                                                                                                                                                              |
| `bootstrapUrl`   | string (URL)      | No       | Always       | Absolute `http://` or `https://` URL the share link redirects new visitors to. Distinct from each playlist entry's per-video `pageUrl` (see `PlaylistEntry` below). Required at creation, never modified after.                                                                                            |
| `singleMode`     | boolean           | No       | Always       | When `true`, the playlist is locked — `PLAYLIST_UPDATE`-style mutations are rejected with `single_mode_locked`. Mutually exclusive with `freeformMode`. Defaults to `false`.                                                                                                                               |
| `freeformMode`   | boolean           | No       | Always       | When `true`, cursor handling relaxes: joiners are not steered to the cursor, and a viewer jumping to a video not yet in the playlist auto-appends it. Mutually exclusive with `singleMode`. Defaults to `false`.                                                                                           |
| `playlist`       | `PlaylistEntry[]` | No       | Always       | Ordered list of videos the room can play. See [PlaylistEntry](#the-playlistentry-object) below. May be empty.                                                                                                                                                                                              |
| `cursorEntryId`  | string \| `null`  | Yes      | Always       | `entryId` of the entry the room is currently playing, or `null` when the playlist is empty.                                                                                                                                                                                                                |
| `createdAt`      | integer (ms)      | No       | Always       | Unix timestamp in **milliseconds** at which the room was created.                                                                                                                                                                                                                                          |
| `expiresAt`      | integer (ms)      | No       | Always       | Unix timestamp in **milliseconds** at which the room becomes invalid. After this point the row is invisible to API callers and is physically deleted by the prune job within the next hour.                                                                                                               |
| `shareLink`      | string (URL)      | No       | Always       | Absolute URL of the public Basic-Auth join endpoint — see [Public share endpoint](#public-share-endpoint-ruuid). Clients should display and copy it; opening it in a browser triggers the password prompt.                                                                                                |
| `password`       | string            | No       | Create only  | The 16-character plaintext one-time password, returned exactly once at creation time. Only ever appears on the `201` response from `POST /rooms`. The list, show, and delete endpoints never include it.                                                                                                  |

## The PlaylistEntry object

Each entry in `room.playlist` represents one video the room can play. The API surface and the persisted JSON column hold the same field set.

| Field            | Type              | Nullable | Description                                                                                                                                                                                                                          |
|------------------|-------------------|----------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `entryId`        | string            | No       | Server-assigned, opaque, stable for the entry's lifetime. Shape: `e_` followed by 16 hex chars. Unique within the room; not globally unique.                                                                                         |
| `position`       | integer           | No       | 1-based ordering within the playlist. Server-managed; renumbered on insert and reorder. Clients should sort by this field when rendering.                                                                                            |
| `providerId`     | string            | No       | Provider slug — e.g. `"youtube"`, `"crunchyroll"`. Lowercased for merge comparisons.                                                                                                                                                  |
| `videoId`        | string            | No       | Provider-specific video identifier. The natural key for merges is `(providerId, videoId)`. Lowercased for merge comparisons.                                                                                                         |
| `pageUrl`        | string (URL)      | No       | The tab-navigation target for clients when this entry becomes the cursor. Distinct from `room.bootstrapUrl` — that URL is for share-link redirects.                                                                                  |
| `label`          | string \| `null`  | Yes      | Human-readable title. Scraped, owner-set, or fetched via oEmbed; `null` when the source provided none.                                                                                                                               |
| `episodeNumber`  | integer \| `null` | Yes      | Series-aware episode index. For YouTube playlists this carries the playlist position. `null` for unordered providers.                                                                                                                |
| `seasonNumber`   | integer \| `null` | Yes      | Optional season metadata. Omitted (`null`) for non-seasoned providers (e.g. YouTube).                                                                                                                                                 |
| `source`         | string            | No       | Provenance: `"scraped"` (extension contributed it), `"curated"` (owner added it), or `"auto_appended"` (server added it in freeform mode). Affects merge behaviour — curated entries are not overwritten by later scrapes.            |
| `addedBy`        | string            | No       | `clientId` (or `"owner"`) that introduced the entry. Provenance only.                                                                                                                                                                |
| `addedAt`        | integer (s)       | No       | Unix timestamp in **seconds** at insert time.                                                                                                                                                                                        |
| `lastSeenAt`     | integer (s)       | No       | Unix timestamp in **seconds**; refreshed every time a scrape reports this `(providerId, videoId)`. Dashboards may dim entries with old `lastSeenAt` as "stale".                                                                       |

### Error response shape

Failures use a uniform JSON shape: a single `error` field with a human-readable message, plus an optional `code` for the conditions where a machine-readable hint helps the client branch. The HTTP status code is the primary signal; the message is for surfacing to the user when it makes sense to do so. Validation errors in particular are designed to be safely showable verbatim — for example, `"bootstrapUrl must be a valid http(s) URL."` is exactly the string the frontend can display in a toast.

```json
{
  "error": "Room creation is restricted to administrators."
}
```

When a `code` is present it is one of:

| `code`                    | Status | Meaning                                                                                                          |
|---------------------------|--------|------------------------------------------------------------------------------------------------------------------|
| `toggle_conflict`         | 400    | The request asked for both `singleMode: true` and `freeformMode: true`. The two are mutually exclusive.          |
| `per_message_cap`         | 400    | `initialEntries` (or a `PLAYLIST_UPDATE` batch elsewhere) exceeds the per-call cap of **200** candidate entries. |
| `playlist_cap_exceeded`   | 400    | The mutation would push the playlist past the per-room cap of **1000** entries. Whole call rolls back.           |
| `freeform_cap_full`       | 400    | The mutation would push a freeform room past `freeform_auto_append_cap` (default **100**) and the auto-prune policy can't free room because only curated + cursored entries remain. Surfaces from `POST /rooms/{uuid}/playlist/entries` in freeform rooms (and from the WS `CURSOR_CHANGE_REQUEST` raw-video auto-append path — see [`ws-protocol.md`](../docs/ws-protocol.md)). The `POST /rooms/{uuid}/cursor` HTTP endpoint accepts entry IDs only, so it never triggers auto-append or this code. See [`configuration.md`](../docs/configuration.md#freeform_auto_append_cap). |

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
  "bootstrapUrl":   "https://example.com/watch/123",
  "name":           "Friday movie",
  "ttl":            21600,
  "singleMode":     false,
  "freeformMode":   false,
  "initialEntries": []
}
```

| Field            | Type                 | Required | Constraints                                                                                                                                                                                                                          | Default                               |
|------------------|----------------------|----------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|---------------------------------------|
| `bootstrapUrl`   | string               | Yes      | Must be a valid `http://` or `https://` URL.                                                                                                                                                                                         | —                                     |
| `name`           | string               | No       | Max 100 characters after trimming. Empty/whitespace is treated as omitted.                                                                                                                                                           | `null`                                |
| `ttl`            | integer              | No       | Time-to-live in **seconds**. Must satisfy `1 ≤ ttl ≤ 86400` (one day).                                                                                                                                                               | `default_ttl_seconds` IAppConfig key, 86400 if unset |
| `singleMode`     | boolean              | No       | Lock the playlist at creation. Mutually exclusive with `freeformMode`.                                                                                                                                                               | `false`                               |
| `freeformMode`   | boolean              | No       | Enable freeform cursor handling (no steering, auto-append on jump). Mutually exclusive with `singleMode`.                                                                                                                            | `false`                               |
| `initialEntries` | `PlaylistEntry`-like[] | No     | Curated entries to seed the playlist with. Each must include `providerId`, `videoId`, `pageUrl`; may include `label`, `episodeNumber`, `seasonNumber`. Server assigns `entryId`, `position`, `source: "curated"`, `addedAt`, `lastSeenAt`. Duplicate `(providerId, videoId)` is rejected. Max 1000. | `[]`                                  |

#### Success response

`HTTP 201 Created`. The body is the standard Room object plus the one-time `password` field:

```json
{
  "uuid":          "5a66524f-5ba1-4f3d-8897-7c5838c0bd80",
  "name":          "Friday movie",
  "bootstrapUrl":  "https://example.com/watch/123",
  "singleMode":    false,
  "freeformMode":  false,
  "playlist":      [],
  "cursorEntryId": null,
  "createdAt":     1778325445000,
  "expiresAt":     1778347045000,
  "shareLink":     "https://nextcloud.example/index.php/apps/playbacksync/r/5a66524f-...",
  "password":      "UIjND2muufTfrrel"
}
```

#### Failure modes

| Status | Trigger                                                                                                  | Example body                                                                       |
|--------|----------------------------------------------------------------------------------------------------------|------------------------------------------------------------------------------------|
| 400    | `bootstrapUrl` missing, malformed, or not http(s).                                                       | `{"error":"bootstrapUrl must be a valid http(s) URL."}`                            |
| 400    | `name` longer than 100 characters.                                                                       | `{"error":"name exceeds maximum length."}`                                         |
| 400    | `ttl` outside the `[1, 86400]` range.                                                                    | `{"error":"ttl must be between 1 and 86400 seconds."}`                             |
| 400    | Both `singleMode: true` and `freeformMode: true`.                                                        | `{"error":"singleMode and freeformMode are mutually exclusive.", "code":"toggle_conflict"}` |
| 400    | `initialEntries` contains duplicate `(providerId, videoId)` or is missing a required field.              | `{"error":"initialEntries contains duplicate (providerId, videoId)."}`             |
| 400    | `initialEntries` longer than 1000.                                                                       | `{"error":"initialEntries exceeds per-room cap of 1000", "code":"playlist_cap_exceeded"}` |
| 401    | No authenticated Nextcloud user on the request.                                                          | `{"error":"Authentication required."}`                                             |
| 403    | `restrict_to_admins` is enabled and the caller is not an admin.                                          | `{"error":"Room creation is restricted to administrators."}`                       |

#### Example

```bash
curl -u alice:alice \
  -H 'OCS-APIRequest: true' \
  -H 'Content-Type: application/json' \
  -X POST 'https://nextcloud.example/index.php/apps/playbacksync/api/v1/rooms' \
  -d '{"bootstrapUrl":"https://example.com/watch/123","name":"Friday movie","ttl":21600}'
```

To create a single-mode room with one curated entry locked in at creation:

```bash
curl -u alice:alice \
  -H 'OCS-APIRequest: true' \
  -H 'Content-Type: application/json' \
  -X POST 'https://nextcloud.example/index.php/apps/playbacksync/api/v1/rooms' \
  -d '{
    "bootstrapUrl": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "name":         "Ricks farewell",
    "singleMode":   true,
    "initialEntries": [
      {
        "providerId": "youtube",
        "videoId":    "dQw4w9WgXcQ",
        "pageUrl":    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        "label":      "Rick Astley — Never Gonna Give You Up"
      }
    ]
  }'
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
      "uuid":          "5a66524f-5ba1-4f3d-8897-7c5838c0bd80",
      "name":          "Friday movie",
      "bootstrapUrl":  "https://example.com/watch/123",
      "singleMode":    false,
      "freeformMode":  false,
      "playlist":      [],
      "cursorEntryId": null,
      "createdAt":     1778325445000,
      "expiresAt":     1778347045000,
      "shareLink":     "https://nextcloud.example/index.php/apps/playbacksync/r/5a66524f-..."
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
  "uuid":          "5a66524f-5ba1-4f3d-8897-7c5838c0bd80",
  "name":          "Friday movie",
  "bootstrapUrl":  "https://example.com/watch/123",
  "singleMode":    false,
  "freeformMode":  false,
  "playlist":      [],
  "cursorEntryId": null,
  "createdAt":     1778325445000,
  "expiresAt":     1778347045000,
  "shareLink":     "https://nextcloud.example/index.php/apps/playbacksync/r/5a66524f-..."
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

Permanently deletes the room. There is no soft-delete or undo; the row is gone immediately. After the DB delete, `RoomService` fires a best-effort `POST /admin/rooms/{uuid}/destroy` to the daemon's loopback admin endpoint — every connected client receives a final `{type:"ERROR", code:"ROOM_DELETED"}` frame, the socket is closed, and the in-memory runtime is dropped. The call is fire-and-forget: if the daemon is unreachable, the DB remains the source of truth and any orphaned runtime falls out via `Tick`'s TTL path. To disconnect a single participant without deleting the room, use the kick endpoint below.

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

### Update room settings (toggle modes)

```
POST /apps/playbacksync/api/v1/rooms/{uuid}/settings
```

Flip one or both mode toggles. Either field may be omitted (or `null`) to leave that toggle unchanged. The two are mutually exclusive — enabling both in one call (or enabling one when the other is already on, without also disabling it) is rejected with `toggle_conflict`.

#### Request body

```json
{ "singleMode": true, "freeformMode": false }
```

| Field          | Type             | Required | Constraints                                                                                  |
|----------------|------------------|----------|----------------------------------------------------------------------------------------------|
| `singleMode`   | boolean \| null  | No       | Lock the playlist when `true`. Mutually exclusive with `freeformMode`.                       |
| `freeformMode` | boolean \| null  | No       | Relax cursor handling when `true`. Mutually exclusive with `singleMode`.                     |

#### Success response

`HTTP 200 OK`. Body is the updated Room object (same shape as `GET /rooms/{uuid}` without `live`).

After the DB write the daemon is asked to re-hydrate its runtime cache via the loopback admin endpoint — connected clients pick up the new toggles on the next `JOIN` / `BUFFER_END` `ROOM_STATE` push.

#### Failure modes

| Status | Trigger                                            | Example body                                                                                |
|--------|----------------------------------------------------|---------------------------------------------------------------------------------------------|
| 400    | Both toggles would end up `true` after the update. | `{"error":"singleMode and freeformMode are mutually exclusive.", "code":"toggle_conflict"}` |
| 404    | Room not yours or doesn't exist.                   | `{"error":"Room not found."}`                                                               |

### Add a curated playlist entry

```
POST /apps/playbacksync/api/v1/rooms/{uuid}/playlist/entries
```

Append one entry to the playlist with `source: "curated"`. Same merge rules as `PLAYLIST_UPDATE` over the WebSocket (see [`ws-protocol.md`](ws-protocol.md)) — duplicate `(providerId, videoId)` short-circuits to a `lastSeenAt` refresh and the curated label is preserved.

#### Request body

```json
{
  "providerId":   "youtube",
  "videoId":      "abc111",
  "pageUrl":      "https://www.youtube.com/watch?v=abc111",
  "label":        "Hardcore Minecraft Ep 1",
  "episodeNumber": 1,
  "seasonNumber":  null
}
```

| Field           | Type             | Required | Notes                                                                                       |
|-----------------|------------------|----------|---------------------------------------------------------------------------------------------|
| `providerId`    | string           | Yes      | Provider slug (`youtube`, `crunchyroll`, …).                                                |
| `videoId`       | string           | Yes      | Provider's video identifier; forms half of the `(providerId, videoId)` natural key.         |
| `pageUrl`       | string           | Yes      | Tab-navigation target carried on `CURSOR_CHANGE` frames.                                    |
| `label`         | string \| null   | No       | Human label; the dashboard may auto-fill via oEmbed before sending.                         |
| `episodeNumber` | integer \| null  | No       | Series episode number.                                                                      |
| `seasonNumber`  | integer \| null  | No       | Series season number.                                                                       |

#### Success response

`HTTP 200 OK`. Body is the full playlist snapshot:

```json
{
  "entries": [
    {
      "entryId":   "e_a3f5b2c1d4e6f708",
      "position":  1,
      "providerId": "youtube",
      "videoId":    "abc111",
      "pageUrl":    "https://www.youtube.com/watch?v=abc111",
      "label":      "Hardcore Minecraft Ep 1",
      "episodeNumber": 1,
      "seasonNumber":  null,
      "source":     "curated",
      "addedBy":    "alice",
      "addedAt":    1778325445,
      "lastSeenAt": 1778325445
    }
  ],
  "cursorEntryId":   null,
  "playlistVersion": "v8c4d3b2a1f0e9d7b"
}
```

The daemon broadcasts a `PLAYLIST_UPDATE` frame to every connected client.

#### Failure modes

| Status | Trigger                                              | Example body                                                                                |
|--------|------------------------------------------------------|---------------------------------------------------------------------------------------------|
| 400    | Adding this entry would exceed the per-room cap.     | `{"error":"playlist would exceed per-room cap of 1000", "code":"playlist_cap_exceeded"}`    |
| 400    | Freeform room is saturated with curated entries (auto-prune can't free room). | `{"error":"freeform playlist is full of curated entries; clear some to continue", "code":"freeform_cap_full"}` |
| 409    | Room has `singleMode: true`.                         | `{"error":"playlist is locked while single mode is enabled", "code":"single_mode_locked"}`  |
| 404    | Room not yours or doesn't exist.                     | `{"error":"Room not found."}`                                                               |

### Remove a playlist entry

```
DELETE /apps/playbacksync/api/v1/rooms/{uuid}/playlist/entries/{entryId}
```

Remove the entry by `entryId`. Renumbers `position` to stay contiguous. Refused when the entry is the current cursor — advance the cursor first.

#### Success response

`HTTP 204 No Content`. Daemon broadcasts a `PLAYLIST_UPDATE` carrying the post-state.

#### Failure modes

| Status | Trigger                                                  | Example body                                                                                |
|--------|----------------------------------------------------------|---------------------------------------------------------------------------------------------|
| 409    | Room has `singleMode: true`.                             | `{"error":"playlist is locked while single mode is enabled", "code":"single_mode_locked"}`  |
| 409    | The entry is the current cursor.                         | `{"error":"cannot delete the entry currently referenced by the cursor", "code":"cursor_locked_entry"}` |
| 404    | Room not yours, entry doesn't exist, or room doesn't exist. | `{"error":"Room not found."}` / `{"error":"entry e_… not found"}`                        |

### Move the cursor

```
POST /apps/playbacksync/api/v1/rooms/{uuid}/cursor
```

Owner-driven cursor move from the dashboard picker. Same per-mode reaction matrix as the WebSocket `CURSOR_CHANGE_REQUEST` path: default + single accept existing `entryId`s; freeform also accepts them. Raw-video auto-append on this endpoint is not supported — for freeform's "jump to a new video" flow, the extension's WS `CURSOR_CHANGE_REQUEST` is the path.

#### Request body

```json
{ "targetEntryId": "e_05" }
```

#### Success response

`HTTP 204 No Content`. Daemon broadcasts `CURSOR_CHANGE` to every connected client; playback state resets to paused at position 0.

#### Failure modes

| Status | Trigger                                                  | Example body                                                                                |
|--------|----------------------------------------------------------|---------------------------------------------------------------------------------------------|
| 400    | `targetEntryId` doesn't match any entry in the playlist. | `{"error":"cursor target e_… is not in the playlist", "code":"not_in_playlist"}`            |
| 409    | Caller is trying something single-mode forbids.          | `{"error":"playlist is locked while single mode is enabled", "code":"single_mode_locked"}`  |
| 404    | Room not yours or doesn't exist.                         | `{"error":"Room not found."}`                                                               |

### Get the playlist

```
GET /apps/playbacksync/api/v1/rooms/{uuid}/playlist
```

Fetch the room's full playlist plus its `playlistVersion`. Useful when a client's cached `playlistVersion` is stale relative to what arrived on `ROOM_STATE` and it needs to reconcile.

#### Success response

`HTTP 200 OK`. Same shape as the response of `POST /playlist/entries`:

```json
{
  "entries": [ { "entryId": "e_01", "position": 1, "providerId": "...", "videoId": "...", ... } ],
  "cursorEntryId":   "e_01",
  "playlistVersion": "v8c4d3b2a1f0e9d7b"
}
```

`entries` is sorted by `position` ascending. `playlistVersion` is the same hash the WebSocket encoder emits, so clients can compare it byte-for-byte.

#### Failure modes

| Status | Trigger                          | Example body                  |
|--------|----------------------------------|-------------------------------|
| 404    | Room not yours or doesn't exist. | `{"error":"Room not found."}` |

### Resolve a video URL (metadata lookup)

A side-channel helper the create-room dialog calls when the owner pastes a URL into a single-mode form. Resolves the URL into the `(providerId, videoId, pageUrl)` triple the playlist substrate uses and — best effort — fetches a friendly title via the provider's oEmbed endpoint so the dialog can pre-fill the entry label. The endpoint doesn't touch any room; it only translates a URL.

```
POST /apps/playbacksync/api/v1/metadata/lookup
```

```json
{
  "pageUrl": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
}
```

#### Success response

`200 OK`

```json
{
  "providerId": "youtube",
  "videoId": "dQw4w9WgXcQ",
  "pageUrl": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  "label": "Rick Astley — Never Gonna Give You Up",
  "providerName": "YouTube",
  "thumbnailUrl": "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg"
}
```

`pageUrl` is the parser's normalised form — short-link (`youtu.be/<id>`) and embed (`youtube.com/embed/<id>`) inputs converge on the canonical `watch?v=<id>` page so every callsite that submits `initialEntries` records the same wire shape regardless of how the URL was typed. URL parsing covers YouTube (long / short / embed / shorts / live / music / mobile), Vimeo (numeric IDs, including `player.vimeo.com/video/<id>`), and a deterministic `generic` fallback (`videoId` is the first 16 hex chars of `sha1(pageUrl)`) for sites we don't recognise — so the dialog still has a stable natural key even when there's no first-class provider integration.

`label` is `null` whenever the oEmbed call failed (transport error, non-200, malformed body) or the URL belongs to the `generic` fallback. The endpoint never propagates an oEmbed failure as a 5xx — the dialog is expected to handle `label: null` by surfacing "Title not found, will use URL" and letting the owner type one by hand. `providerName` and `thumbnailUrl` come from the oEmbed payload as well and are `null` under the same conditions.

Responses are cached per URL for one hour in the configured distributed cache; subsequent calls for the same URL inside the window short-circuit the outbound oEmbed request.

#### Failure modes

| Status | Trigger                                                        | Example body                                                       |
|--------|----------------------------------------------------------------|--------------------------------------------------------------------|
| 400    | `pageUrl` is empty, not a valid http(s) URL, or has no host.   | `{"error":"pageUrl must be a valid http(s) URL", "code":"unsupported_url"}` |
| 401    | Caller is not logged in.                                       | `{"error":"Authentication required."}`                             |

#### Example

```bash
curl -u alice:alice \
  -H 'OCS-APIRequest: true' \
  -H 'Content-Type: application/json' \
  --data-binary '{"pageUrl":"https://www.youtube.com/watch?v=dQw4w9WgXcQ"}' \
  'https://nextcloud.example/index.php/apps/playbacksync/api/v1/metadata/lookup'
```

### WebSocket service status

Tells the caller whether the WebSocket sync service is *usable* on this Nextcloud instance — meaning installed, configured, and the daemon is currently reachable from PHP. Use it to decide whether to expose sync UI in the client and which help affordance to show when sync is not usable.

```
GET /apps/playbacksync/api/v1/ws/status
```

#### Success response

`200 OK`

```json
{ "available": true, "reason": null }
```

`available` is `true` only when all of the following hold:

- The daemon's Composer dependencies (Ratchet) are loadable in the PHP runtime — i.e., somebody ran `composer install` in the app directory.
- Both `ws_host` and `ws_port` `IAppConfig` keys are non-empty.
- The daemon answers a loopback `/healthz` probe (via the same `HealthClient` used by `/health`) with `status: "ok"`.

When `available` is `false`, `reason` distinguishes *why*, so the UI can branch on it:

| `reason`         | Meaning                                                                                                | Suggested UI               |
|------------------|--------------------------------------------------------------------------------------------------------|----------------------------|
| `not_installed`  | Composer deps are missing, or `ws_host` / `ws_port` are unset — the admin has not finished setup.      | Link to install instructions. |
| `not_running`    | The app is installed and configured, but the daemon's `/healthz` probe failed (unreachable, timed out, or replied with non-`ok` status). | Tell the user a sysadmin needs to start the daemon. An admin can restart a supervised daemon from PlaybackSync admin settings (**Daemon control → Restart daemon**); otherwise it's started from the host (`systemctl start playbacksync-ws` or `occ playbacksync:ws-serve`). |

When `available` is `true`, `reason` is always `null`.

Failure modes that go beyond `not_running` (timeout vs. connection refused vs. `degraded`) all collapse to `not_running` here — operators chase the detail through `/api/v1/health` or the daemon log.

#### Failure responses

```json
{ "available": false, "reason": "not_installed" }
```

```json
{ "available": false, "reason": "not_running" }
```

#### Failure modes

This endpoint has none beyond the global authentication check. It always returns `200`; the `available` / `reason` pair carries the outcome.

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

The link participants are given when an owner shares a room. This is the only path on the app that does not require a Nextcloud login — instead it gates on the room's password via HTTP Basic Auth and, on success, 302-redirects the visitor to the room's `bootstrapUrl` with two query parameters appended (`sync_url` and `sync_password`) that downstream consumers (a browser extension, an embedded player) use to join the synchronized session.

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

`HTTP 302 Found`. Body is intentionally empty; the `Location` header points at the room's `bootstrapUrl` with `sync_url` and `sync_password` merged into its query string. Existing query parameters on `bootstrapUrl` are preserved; the URL fragment, if any, is preserved after the merged query.

| Query param      | Value                                                                              |
|------------------|------------------------------------------------------------------------------------|
| `sync_url`       | `wss://<nextcloud-host>/apps/playbacksync/ws/{uuid}` (`ws://` for plain-HTTP setups). Derived from `IURLGenerator::getAbsoluteURL` — same host the share link was served from. |
| `sync_password`  | The plaintext password the visitor just submitted via Basic Auth. Forwarded so the downstream consumer can present it on the WebSocket `JOIN`. |

Example `Location` for a room whose `bootstrapUrl` is `https://video.example/watch?ep=2`:

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

## Forward-looking: future spec deltas

The endpoints above cover the playlist + cursor data substrate, the v2 wire-protocol surface (settings, playlist CRUD, cursor move, playlist read), and the dashboard surfaces for default mode, single mode, and freeform mode (see [`agent-os/specs/2026-05-14-2000-content-model-default-mode/`](../agent-os/specs/2026-05-14-2000-content-model-default-mode/), [`agent-os/specs/2026-05-16-1500-content-model-single-mode/`](../agent-os/specs/2026-05-16-1500-content-model-single-mode/), and [`agent-os/specs/2026-05-16-1830-content-model-freeform-mode/`](../agent-os/specs/2026-05-16-1830-content-model-freeform-mode/)). Freeform's auto-prune cap (`freeform_auto_append_cap`, default 100) and the `freeform_cap_full` error code surface from the existing endpoints — no new routes. Promote-to-curated ships as a flag on `PATCH /rooms/{uuid}/playlist/entries/{entryId}`. The Room and PlaylistEntry shapes above are stable — future endpoints add behaviour, they don't break field contracts.

The share endpoint is intentionally separate from the management API. It lives at a different path (`/r/{uuid}` rather than `/api/v1/rooms/{uuid}`), it doesn't require a Nextcloud login, and it's the only place where unauthenticated traffic interacts with PlaybackSync (alongside the public `/health` probe). Keeping it cordoned off makes it easy to reason about the public attack surface in isolation.

A future spec will add resume-where-we-left-off persistence (throttled writes of `playerState` / `videoPos` to the room row). That field will be optional on the response — omitted entirely on rooms that have never had any playback events — so existing API clients are unaffected by its addition.
