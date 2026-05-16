# PlaybackSync — WebSocket Protocol (v2)

This document is the wire-format contract for clients connecting to the
PlaybackSync sync daemon. The audience is anyone implementing a client
(browser extension, Vue frontend, scripted test harness): everything they
need to talk to the server should be here. For deployment details see
[`ws-sync-server.md`](ws-sync-server.md). For the conceptual model behind
playlist + cursor + toggles, read the content-model specs under
[`agent-os/specs/`](../agent-os/specs/) — the `content-model-data-substrate`,
`content-model-protocol`, and per-mode entries are the canonical record.

> **v2 (current).** The wire frames now reflect the playlist + cursor
> data substrate. `EPISODE_CHANGE_REQUEST` / `EPISODE_CHANGE` /
> `CONTENT_MISMATCH` have been retired; `CURSOR_CHANGE_REQUEST` /
> `CURSOR_CHANGE` / `PLAYLIST_UPDATE` take their place. Pre-launch
> rename, no compatibility shim — older clients won't work.

## Connecting

```
ws[s]://<nextcloud-host>/index.php/apps/playbacksync/ws/{roomUuid}
```

The `{roomUuid}` is the UUIDv4 returned by the `POST /api/v1/rooms` endpoint
when the room was created. The server reads it from the URL on `onOpen`
and refuses the upgrade with `ROOM_NOT_FOUND` if the segment is malformed
or doesn't match a known room.

After the WebSocket upgrade succeeds, the server waits up to 5 seconds for
the client's first `JOIN` message. A connection that doesn't authenticate
within that window is closed with `JOIN_TIMEOUT`.

## Envelope

Every message in both directions is a single JSON object whose `type` field
is the dispatch key. All other fields are message-specific.

```json
{ "type": "MESSAGE_TYPE", "...": "..." }
```

Times are integer milliseconds since the Unix epoch unless noted otherwise.
Position values (`videoPos`, `currentPos`, `value`, `targetPos`) are
floating-point seconds.

## Authentication and identity

The room password is verified on `JOIN` against the existing
`oc_playbacksync_rooms.password_hash` column — the same hash that was set
when the room was created. The plaintext password is the one the creator
got from the one-time creation dialog.

A new client without a `clientId` is assigned a fresh hex string by the
server and gets it back in the `ROOM_STATE` reply. **Save that value.** If
the client disconnects and reconnects within `ws_tombstone_ms` (default
30 s), passing the same `clientId` lets the server resume the session,
including replaying any events the client missed.

---

## Client → server messages

### `JOIN` (required first message)

```json
{
  "type": "JOIN",
  "password": "abc123XYZ...",
  "clientId": "optional-from-prior-session",
  "lastEventId": 17,
  "currentlyShowing": {
    "providerId": "crunchyroll",
    "videoId": "frieren-s01e03",
    "pageUrl": "https://www.crunchyroll.com/watch/..."
  },
  "catalogFragment": [
    {
      "providerId": "crunchyroll",
      "videoId": "frieren-s01e01",
      "pageUrl": "...",
      "label": "Episode 1",
      "episodeNumber": 1,
      "seasonNumber": 1
    }
  ]
}
```

- `password` (string, required) — plaintext room password.
- `clientId` (string, optional, ≤ 64 chars) — for reconnects. Omit on the
  first connection.
- `lastEventId` (integer, optional) — the last `eventId` the client saw
  before its previous connection dropped. The server replays anything newer
  in `ROOM_STATE.recentEvents`.
- `currentlyShowing` (object, optional) — `(providerId, videoId, pageUrl)`
  triple describing the video the client's tab is currently on. Used for
  **JOIN steering** (see below) and as the seed video for an empty
  playlist. Omitted when the client is on a generic "join page" rather
  than a real video page.
- `catalogFragment` (array, optional, ≤ 200 entries) — additional video
  entries the client scraped from the page (e.g. an episode sidebar). The
  server merges them into the playlist with `source: "scraped"` using the
  rules established in
  [`agent-os/specs/2026-05-14-1700-content-model-data-substrate/`](../agent-os/specs/2026-05-14-1700-content-model-data-substrate/).
  Silently ignored in single-mode rooms (the playlist is locked).

#### JOIN steering reaction matrix

After authenticating the joiner and merging any `catalogFragment`, the
server compares `currentlyShowing` against the room's cursor and decides
whether to unicast a `CURSOR_CHANGE` back to that connection so the
extension can navigate the tab to the right video. The new client always
receives `ROOM_STATE` first; steering, when it happens, follows
immediately.

| Mode | Joiner state | Server action |
|---|---|---|
| Default | `currentlyShowing` matches cursor | `ROOM_STATE` only |
| Default | in playlist but ≠ cursor | `ROOM_STATE` + unicast `CURSOR_CHANGE` |
| Default | not in playlist (playlist non-empty) | unicast `CURSOR_CHANGE` |
| Default | playlist empty, `currentlyShowing` present | seed playlist + set cursor + (no steer needed; cursor already matches) |
| Single | matches cursor | `ROOM_STATE` only |
| Single | else (any) | unicast `CURSOR_CHANGE` (`catalogFragment` ignored) |
| Freeform | matches cursor | `ROOM_STATE` only |
| Freeform | else, polite-follow (current behaviour) | unicast `CURSOR_CHANGE` |
| Freeform | playlist empty, `currentlyShowing` present | auto-append + set cursor |
| Any | `currentlyShowing` omitted | `ROOM_STATE` only — no steer target |

The freeform "eager append" alternative (whereby the joiner's video
becomes the new cursor instead of being steered) is deferred to the
freeform-mode UX spec.

### `EVENT`

```json
{ "type": "EVENT", "event": "play",  "clientTs": 1700000000000 }
{ "type": "EVENT", "event": "pause", "clientTs": 1700000000000 }
{ "type": "EVENT", "event": "seek",  "value": 120.5, "clientTs": 1700000000000 }
```

- `event` ∈ `play` / `pause` / `seek`.
- `value` (seconds) is required when `event === "seek"`, ignored otherwise.
- `clientTs` (ms) is the client's wall clock when it sent the message; used
  by the server only for logging and is **not** authoritative.

Rate-limited per connection: 10 explicit events per second by default
(`ws_rate_limit_events_per_sec`). Excess events get `ERROR RATE_LIMITED`
and the connection stays open. Shares its bucket with
`CURSOR_CHANGE_REQUEST`.

### `CURSOR_CHANGE_REQUEST`

Ask the room to move the cursor to a different entry. Two forms:

```json
{ "type": "CURSOR_CHANGE_REQUEST", "targetEntryId": "e_05", "clientTs": 1700000000000 }
```

```json
{
  "type": "CURSOR_CHANGE_REQUEST",
  "target": {
    "providerId": "youtube",
    "videoId": "newVidId",
    "pageUrl": "https://...",
    "label": "Some new video",
    "episodeNumber": null,
    "seasonNumber": null
  },
  "clientTs": 1700000000000
}
```

Exactly one of `targetEntryId` or `target` must be present.

Server behaviour by mode (the canonical per-mode reaction matrix lives
in [`agent-os/specs/2026-05-14-1830-content-model-protocol/`](../agent-os/specs/2026-05-14-1830-content-model-protocol/)):

| Mode | Target form | Reaction |
|---|---|---|
| Single | `targetEntryId` of an existing entry | Accept — cursor moves between locked entries. |
| Single | `target` (raw) | Reject `single_mode_locked`. |
| Default | `targetEntryId` | Accept if entry exists, else `not_in_playlist`. |
| Default | `target` whose `(providerId, videoId)` already exists | Resolve to existing entry id, accept. |
| Default | `target` not in playlist | Reject `not_in_playlist` — sender must `PLAYLIST_UPDATE` first. |
| Freeform | `targetEntryId` | Accept if entry exists. |
| Freeform | `target` whose `(providerId, videoId)` already exists | Resolve to existing entry id, accept. |
| Freeform | `target` not in playlist | Auto-append with `source: "auto_appended"`, then move cursor. Server broadcasts `PLAYLIST_UPDATE` first, then `CURSOR_CHANGE`. The append also runs the freeform prune (see below); a saturated room rejects with `freeform_cap_full`. |

On success the playback state resets (paused at position 0) — the new
cursor starts fresh. Same rate-limit bucket as `EVENT`.

### `PLAYLIST_UPDATE`

Client → server: contribute scraped entries to the playlist (typically
sent from a series-aware page where the extension can read the episode
list).

```json
{
  "type": "PLAYLIST_UPDATE",
  "entries": [
    {
      "providerId": "crunchyroll",
      "videoId": "frieren-s01e04",
      "pageUrl": "https://...",
      "label": "Episode 4",
      "episodeNumber": 4,
      "seasonNumber": 1,
      "source": "scraped"
    }
  ],
  "clientTs": 1700000000000
}
```

- `entries` — non-empty list; ≤ 200 entries per frame.
- Per-entry `source` is optional; defaults to `"scraped"` if omitted.
- Server merges by `(providerId, videoId)` per the merge rules.
- Rejected with `single_mode_locked` in single-mode rooms.
- Rejected with `playlist_cap_exceeded` if the merge would push the
  playlist past 1000 entries (per-room cap).
- In freeform rooms, the merge (and the auto-append path) also runs the
  freeform auto-prune: oldest `auto_appended` entries are dropped first
  until the playlist fits within `freeform_auto_append_cap` (default
  100; see [`configuration.md`](configuration.md#freeform_auto_append_cap)).
  Curated entries and the cursored entry are never auto-dropped. If
  pruning can't free enough room because only curated + cursored
  entries remain, the call is rejected with `freeform_cap_full` and
  the owner has to clear entries before more growth can land.

Rate-limited via a **separate** per-connection bucket
(`ws_rate_limit_playlist_per_sec`, default 2) so a scrape on JOIN
doesn't eat the playback-event budget.

After a successful merge the server broadcasts a `PLAYLIST_UPDATE`
frame back to every connection (including the sender) carrying the
full post-merge playlist so all clients converge.

### `HEARTBEAT`

```json
{ "type": "HEARTBEAT", "currentPos": 42.7, "playerState": "playing" }
```

- `currentPos` (seconds, float).
- `playerState` ∈ `playing` / `paused` / `buffering`.

Send every ~5 s. The server uses heartbeats both as liveness signal (a
client with no heartbeat for `ws_idle_close_ms` gets disconnected) and as
the input for drift detection — the server compares `currentPos` to its
extrapolated authoritative position and may reply with `SYNC_ADJUST`.

### `CLOCK_PING` / `CLOCK_PONG`

```json
{ "type": "CLOCK_PING", "clientSendTime": 1700000000000.123 }
```

The server replies immediately with `CLOCK_PONG`. The client uses NTP-style
math to estimate its clock offset and round-trip time:

```
RTT          = (T4 - T1) - (T3 - T2)
clockOffset  = ((T2 - T1) + (T3 - T4)) / 2
```

where `T1 = clientSendTime`, `T2 = serverRecvTime`, `T3 = serverSendTime`,
`T4 = clientRecvTime`. Take 3–5 samples on first connect; one ping every
30 seconds after that is plenty.

### `BUFFER_START` / `BUFFER_END`

```json
{ "type": "BUFFER_START", "videoPos": 42.7 }
{ "type": "BUFFER_END",   "videoPos": 42.7 }
```

While `isBuffering` is set, the server suppresses drift correction for that
client. On `BUFFER_END` the server sends a fresh per-client `ROOM_STATE` so
the client can resync to the current expected position before any
`SYNC_ADJUST` arrives.

---

## Server → client messages

### `ROOM_STATE`

Sent immediately after a successful `JOIN` and again after every
`BUFFER_END`. Carries everything a client needs to land in the right place.

```json
{
  "type": "ROOM_STATE",
  "clientId": "5c4df08c5b4a4e2d8f3aab0c0123abcd",
  "singleMode": false,
  "freeformMode": false,
  "cursor": {
    "entryId": "e_02",
    "providerId": "crunchyroll",
    "videoId": "frieren-s01e02",
    "pageUrl": "https://...",
    "label": "Episode 2"
  },
  "playlistVersion": "v8c4d3b2a1f0e9d7b",
  "playerState": "playing",
  "videoPos": 42.71,
  "lastEventId": 19,
  "serverTs": 1700000000000,
  "recentEvents": [
    { "type": "play", "value": null, "clientId": "...", "ts": 1700000000000, "eventId": 18 },
    { "type": "seek", "value": 30.0, "clientId": "...", "ts": 1700000000000, "eventId": 19 }
  ]
}
```

- `cursor` is `null` when the room's playlist is empty (e.g. an
  unscraped default-mode room before the first joiner, or a fresh
  freeform room).
- `videoPos` is the server-extrapolated position right now — for a playing
  room the value is `lastSeekPos + (now - lastUpdate) / 1000`.
- `playlistVersion` is a stable hash over the playlist's entries
  (`v` + 16 hex chars). Clients hold the previous version and compare
  it against subsequent `ROOM_STATE` / `PLAYLIST_UPDATE` frames to skip
  redundant reconciles. The full playlist is fetched out-of-band via
  `GET /api/v1/rooms/{uuid}/playlist` — see [`api.md`](api.md).
- `recentEvents` is present only when the client passed `lastEventId` in
  `JOIN` and there are events newer than that in the ring buffer.

### `STATE`

Broadcast to every member of the room (including the sender) after every
`EVENT`. This is the authoritative state at the moment the event was
processed.

```json
{
  "type": "STATE",
  "playerState": "paused",
  "videoPos": 120.5,
  "eventId": 20,
  "serverTs": 1700000000000
}
```

### `CURSOR_CHANGE`

Broadcast to every member of the room after a successful
`CURSOR_CHANGE_REQUEST` (from the extension) or `POST /cursor` (from the
dashboard). Also **unicast** to a freshly-joined client when JOIN steering
fires (same payload shape, different addressing).

```json
{
  "type": "CURSOR_CHANGE",
  "cursor": {
    "entryId": "e_05",
    "providerId": "crunchyroll",
    "videoId": "frieren-s01e05",
    "pageUrl": "https://...",
    "label": "Episode 5"
  },
  "eventId": 142,
  "serverTs": 1700000000000
}
```

On receipt, clients reset their player to paused at position 0 and
navigate the tab to `cursor.pageUrl`.

### `PLAYLIST_UPDATE` (server → client)

Broadcast after every successful merge (from a client `PLAYLIST_UPDATE`,
a freeform auto-append, or an HTTP dashboard call). Carries the full
post-merge playlist so clients converge without per-entry diffing.

```json
{
  "type": "PLAYLIST_UPDATE",
  "entries": [
    {
      "entryId": "e_01",
      "position": 1,
      "providerId": "crunchyroll",
      "videoId": "frieren-s01e01",
      "pageUrl": "https://...",
      "label": "Episode 1",
      "episodeNumber": 1,
      "seasonNumber": 1,
      "source": "scraped",
      "addedAt": 1700000000,
      "lastSeenAt": 1700000000
    }
  ],
  "playlistVersion": "v8c4d3b2a1f0e9d7b",
  "serverTs": 1700000000000
}
```

### `SYNC_ADJUST`

Per-client drift correction. Sent in response to `HEARTBEAT` when the
reported position is too far from the server's extrapolated time.

```json
{
  "type": "SYNC_ADJUST",
  "serverTime": 1700000000000,
  "targetPos": 42.71,
  "mode": "nudge-rate"
}
```

- `mode` ∈ `nudge-rate` / `seek`.
  - `nudge-rate`: drift between 200 ms and 500 ms — gradually adjust
    playback rate until the drift closes.
  - `seek`: drift ≥ 500 ms — seek directly to `targetPos`.

Suppressed entirely while the client is `buffering` and during the
3-second cooldown after every explicit event.

### `CLOCK_PONG`

```json
{
  "type": "CLOCK_PONG",
  "clientSendTime": 1700000000000.123,
  "serverRecvTime": 1700000000010,
  "serverSendTime": 1700000000011
}
```

### `ERROR`

```json
{ "type": "ERROR", "code": "AUTH_FAILED", "message": "Incorrect room password", "serverTs": 1700000000000 }
```

`code` values:

| Code | Meaning | Connection closed? |
|---|---|---|
| `INVALID_JSON` | Frame wasn't valid JSON | no |
| `INVALID_MESSAGE` | JSON shape was wrong | no |
| `UNKNOWN_TYPE` | `type` not recognised | no |
| `JOIN_TIMEOUT` | No JOIN within 5 s | yes |
| `ROOM_NOT_FOUND` | URL UUID doesn't match a room | yes |
| `ROOM_EXPIRED` | Room is past its TTL | yes |
| `AUTH_FAILED` | Wrong password | yes |
| `CLIENT_ID_IN_USE` | A live connection already holds this `clientId` | yes |
| `KICKED` | Room owner forcibly disconnected this client | yes |
| `NOT_JOINED` | Sent EVENT/HEARTBEAT/etc. without a prior JOIN | yes |
| `ALREADY_JOINED` | Sent a second JOIN on the same connection | no |
| `RATE_LIMITED` | Token bucket empty (events or playlist) | no |
| `single_mode_locked` | Mutation attempted on a single-mode room | no |
| `not_in_playlist` | `CURSOR_CHANGE_REQUEST` referenced a video not in the playlist (default mode) | no |
| `playlist_cap_exceeded` | `PLAYLIST_UPDATE` would push playlist past the 1000-entry per-room cap | no |
| `freeform_cap_full` | Freeform auto-prune could not bring the playlist back under `freeform_auto_append_cap` because only curated + cursored entries remain. Surfaced on `CURSOR_CHANGE_REQUEST` (auto-append path) and `PLAYLIST_UPDATE` in freeform rooms. | no |
| `INTERNAL_ERROR` | Unexpected server-side failure | yes |

(`toggle_conflict` and `cursor_locked_entry` only surface via the HTTP
API — see [`api.md`](api.md). They cannot be triggered through the WS
wire because the corresponding mutations aren't WS-exposed.)

---

## Sequence: typical first connect (default mode, anime room)

```
Client                                  Server
  |--WS upgrade GET /apps/.../ws/UUID--->|   (101 Switching Protocols)
  |<------------------------------------|
  |--JOIN{password, currentlyShowing, catalogFragment[ep 1-4]}-->|
  |   (server merges fragment, sets cursor=ep3 from currentlyShowing)
  |<-ROOM_STATE{clientId, cursor=ep3, playlistVersion, ...}--|   (save clientId)
  |   (no steer — currentlyShowing matched the seeded cursor)
  |--CLOCK_PING-------------------------->|
  |<-CLOCK_PONG--------------------------|
  |   (3–5 times, then sparingly)         |
  |                                       |
  |--HEARTBEAT every ~5 s---------------->|
  |   …                                   |
  |<-SYNC_ADJUST (only if drift)----------|
```

## Sequence: stale-tab joiner gets steered

```
Client                                  Server
  |--JOIN{password, currentlyShowing=ep1}-->|
  |   (cursor is on ep3 — mismatch)
  |<-ROOM_STATE{cursor=ep3, ...}-----------|
  |<-CURSOR_CHANGE{cursor=ep3}-------------|   (unicast, not broadcast)
  |   (extension navigates the tab to ep3)
```

## Sequence: another client triggers a play

```
A          Server          B          (B is already JOINed)
|--EVENT play->|             |
|<-STATE-------|             |
|              |--STATE----->|
```

## Sequence: freeform-mode auto-append on cursor change

```
A          Server          B
|--CURSOR_CHANGE_REQUEST{target: {videoId:vid_b,...}}->|
|   (server auto-appends vid_b with source=auto_appended)
|<-PLAYLIST_UPDATE{entries:[..., vid_b]}---|
|              |--PLAYLIST_UPDATE--->|
|<-CURSOR_CHANGE{cursor:vid_b}------|
|              |--CURSOR_CHANGE---->|
```

## Sequence: A drops, reconnects, replays missed events

```
A           Server
|<close>     | (server tombstones A for 30 s)
|            | (A misses events 19 and 20 broadcast in the meantime)
|--JOIN{clientId, lastEventId=18}->|
|<-ROOM_STATE{lastEventId:20, recentEvents:[19,20]}-|
```

## Admin HTTP

In addition to the WebSocket port, the daemon binds a **loopback-only** HTTP endpoint that lets the Nextcloud rooms API surface live presence, drive owner-initiated playback, and broadcast post-write WS frames after dashboard mutations. This section documents the wire format. **Browser clients (Vue, browser extension) do not call this endpoint** — only the PHP request layer running on the same host does.

### Endpoints

```
GET  /admin/rooms/presence?uuids=<csv>
POST /admin/rooms/{uuid}/playback
POST /admin/rooms/{uuid}/broadcast
POST /admin/rooms/{uuid}/clients/{clientId}/disconnect
GET  /admin/rooms/{uuid}/events/stream
GET  /admin/events/stream
POST /admin/events
GET  /healthz
```

Defaults: `127.0.0.1:8766`.

### Authentication

Every request (except `/healthz`) must carry an `X-PBSync-Admin` header:

```
X-PBSync-Admin: t=<unix-ms>,sig=<hex>
```

- `t` — current time in milliseconds since epoch. Requests outside ±30 s of the daemon's clock are rejected with 401.
- `sig` — `hmac_sha256(ws_admin_secret, "{method}\n{requestTarget}\n{t}")`. `requestTarget` is the path with query string exactly as it appears on the wire — tampering invalidates the signature.

If `ws_admin_secret` is empty the daemon refuses to start the admin endpoint.

### `GET /admin/rooms/presence`

```json
{
  "rooms": {
    "<roomUuid>": {
      "connectedCount": 3,
      "clients": [
        { "clientId": "5c4df08c…", "isBuffering": false, "lastSeenMs": 1700000005000 },
        { "clientId": "9a7e1bf2…", "isBuffering": true,  "lastSeenMs": 1700000004500 }
      ],
      "playerState": "playing",
      "videoPos": 42.71,
      "lastActivityMs": 1700000005000
    }
  }
}
```

- `connectedCount` is the true total of currently-connected clients in the room. The `clients` array is capped at 50 entries; `connectedCount` may exceed `clients.length`.
- `videoPos` is the server-extrapolated position right now.
- `lastActivityMs` is the latest of (a) any client's `lastSeenMs` and (b) the most recent event's `ts`. `null` for a runtime that has never had a client.

### `POST /admin/rooms/{uuid}/broadcast`

Triggered by the Nextcloud PHP layer after a DB write (playlist add/remove via dashboard, owner-driven cursor change, toggle flip) so the daemon re-hydrates its runtime cache and fans out the matching WS frame.

```json
{ "kind": "cursor_change", "userId": "alice" }
```

`kind` ∈ `cursor_change` / `playlist_update` / `room_state`. `userId` is the Nextcloud owner, forwarded to the event log envelope. The daemon's runtime is re-read from the DB; the appropriate broadcast goes to every connected client.

Returns `200 {"result":"broadcast"}` on success, or `200 {"result":"no_runtime"}` when no client is connected (next JOIN re-hydrates from DB anyway).

### `POST /admin/rooms/{uuid}/playback`, `POST .../clients/.../disconnect`, `GET .../events/stream`, `GET /admin/events/stream`, `POST /admin/events`, `GET /healthz`

Documented inline in the PHP-side service classes (`AdminPlaybackClient`, `AdminKickClient`, `AdminEventClient`, the SSE controllers). They predate v2 and are unchanged.

### Error codes

| Status | Body | Meaning |
|---|---|---|
| `400` | `{"error":"missing_request"}` / `{"error":"invalid_json"}` / `{"error":"invalid_action"}` / `{"error":"invalid_kind"}` | The HTTP frame couldn't be parsed or the payload was malformed. |
| `401` | `{"error":"unauthorized"}` | Missing, malformed, expired, or wrong-signature `X-PBSync-Admin` header. |
| `404` | `{"error":"not_found"}` / `{"error":"room_not_found"}` / `{"error":"client_not_found"}` | Path or resource not recognised. |
| `405` | `{"error":"method_not_allowed"}` | Wrong verb on a known path. |
| `500` | `{"error":"internal_error"}` | Unexpected daemon-side failure (also logged). |
