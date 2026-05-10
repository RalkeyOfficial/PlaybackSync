# PlaybackSync — WebSocket Protocol (v1)

This document is the wire-format contract for clients connecting to the
PlaybackSync sync daemon. The audience is anyone implementing a client
(browser extension, Vue frontend, scripted test harness): everything they
need to talk to the server should be here. For deployment details see
[`ws-sync-server.md`](ws-sync-server.md).

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
  "episodeId": "S01E01",
  "providerId": "netflix",
  "pageUrl": "https://example.com/watch/12345"
}
```

- `password` (string, required) — plaintext room password.
- `clientId` (string, optional, ≤ 64 chars) — for reconnects. Omit on the
  first connection.
- `lastEventId` (integer, optional) — the last `eventId` the client saw
  before its previous connection dropped. The server replays anything newer
  in `ROOM_STATE.recentEvents`.
- `episodeId`, `providerId`, `pageUrl` (string, optional, all-or-nothing,
  ≤ 1024 chars each) — content fingerprint. If the room already has an
  identity established, these three must hash to the same `contentKey` or
  the connection is rejected with `CONTENT_MISMATCH`.

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

Rate-limited per connection: 10 explicit events per second (default).
Excess events get `ERROR RATE_LIMITED` and the connection stays open.

### `EPISODE_CHANGE_REQUEST`

```json
{
  "type": "EPISODE_CHANGE_REQUEST",
  "episodeId": "S02E03",
  "providerId": "netflix",
  "pageUrl": "https://example.com/watch/67890",
  "clientTs": 1700000000000
}
```

A hard reset. Resets `videoPos` to 0, `playerState` to `paused`, and
publishes the new `ContentIdentity`. Same rate-limit bucket as `EVENT`.

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
  "playerState": "playing",
  "videoPos": 42.71,
  "lastEventId": 19,
  "serverTs": 1700000000000,
  "providerId": "netflix",
  "episodeId": "S01E01",
  "pageUrl": "https://example.com/watch/12345",
  "contentKey": "fc4...",
  "recentEvents": [
    { "type": "play",  "value": null, "clientId": "...", "ts": 1700000000000, "eventId": 18 },
    { "type": "seek",  "value": 30.0, "clientId": "...", "ts": 1700000000000, "eventId": 19 }
  ]
}
```

- `videoPos` is the server-extrapolated position right now — for a playing
  room the value is `lastSeekPos + (now - lastUpdate) / 1000`.
- `recentEvents` is present only when the client passed `lastEventId` in
  `JOIN` and there are events newer than that in the ring buffer.
- `contentKey` is `sha256(lower(providerId) + ':' + lower(episodeId) + ':' + pageUrl)`.

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

### `EPISODE_CHANGE`

Broadcast to every member of the room after `EPISODE_CHANGE_REQUEST`.

```json
{
  "type": "EPISODE_CHANGE",
  "eventId": 21,
  "providerId": "netflix",
  "episodeId": "S02E03",
  "pageUrl": "https://example.com/watch/67890",
  "contentKey": "9a7...",
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

`code` values used by v1:

| Code | Meaning | Connection closed? |
|---|---|---|
| `INVALID_JSON` | Frame wasn't valid JSON | no |
| `INVALID_MESSAGE` | JSON shape was wrong | no |
| `UNKNOWN_TYPE` | `type` not recognised | no |
| `JOIN_TIMEOUT` | No JOIN within 5 s | yes |
| `ROOM_NOT_FOUND` | URL UUID doesn't match a room | yes |
| `ROOM_EXPIRED` | Room is past its TTL | yes |
| `AUTH_FAILED` | Wrong password | yes |
| `CONTENT_MISMATCH` | JOIN content identity disagrees with the room | yes |
| `CLIENT_ID_IN_USE` | A live connection already holds this `clientId` | yes |
| `KICKED` | Room owner forcibly disconnected this client | yes |
| `NOT_JOINED` | Sent EVENT/HEARTBEAT/etc. without a prior JOIN | yes |
| `RATE_LIMITED` | Token bucket empty | no |
| `INTERNAL_ERROR` | Unexpected server-side failure | yes |

### `CONTENT_MISMATCH`

Sent before the closing `ERROR` when a JOIN's content identity disagrees
with the room's. Lets the client surface a friendly "you're on the wrong
episode" message before the socket closes.

```json
{
  "type": "CONTENT_MISMATCH",
  "expectedContentKey": "fc4...",
  "reportedContentKey": "abc...",
  "serverTs": 1700000000000
}
```

---

## Sequence: typical first connect

```
Client                                  Server
  |--WS upgrade GET /apps/.../ws/UUID--->|   (101 Switching Protocols)
  |<------------------------------------|
  |--JOIN{password}--------------------->|
  |<-ROOM_STATE{clientId, playerState…}--|   (save clientId)
  |--CLOCK_PING-------------------------->|
  |<-CLOCK_PONG--------------------------|
  |   (3–5 times, then sparingly)         |
  |                                       |
  |--HEARTBEAT every ~5 s---------------->|
  |   …                                   |
  |<-SYNC_ADJUST (only if drift)----------|
```

## Sequence: another client triggers a play

```
A          Server          B          (B is already JOINed)
|--EVENT play->|             |
|<-STATE-------|             |
|              |--STATE----->|
```

## Admin HTTP

In addition to the WebSocket port, the daemon binds a **loopback-only** HTTP endpoint that lets the Nextcloud rooms API surface live presence and playback state. This section documents the wire format. **Browser clients (Vue, browser extension) do not call this endpoint** — only the PHP request layer running on the same host does.

### Endpoint

```
GET http://<ws_admin_host>:<ws_admin_port>/admin/rooms/presence?uuids=<csv>
```

Defaults: `127.0.0.1:8766`. The `uuids` query parameter is a comma-separated list of room UUIDv4 values. UUIDs the daemon doesn't currently hold a runtime for are silently absent from the response.

### Authentication

Every request must carry an `X-PBSync-Admin` header:

```
X-PBSync-Admin: t=<unix-ms>,sig=<hex>
```

- `t` — current time in milliseconds since epoch. Requests outside ±30 s of the daemon's clock are rejected with 401.
- `sig` — `hmac_sha256(ws_admin_secret, "{method}\n{requestTarget}\n{t}")`. `requestTarget` is the path with query string exactly as it appears on the wire — tampering with `?uuids=…` invalidates the signature.

If `ws_admin_secret` is empty the daemon refuses to start the admin endpoint.

### Response (200)

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
      "contentIdentity": {
        "providerId": "netflix",
        "episodeId": "S01E03",
        "pageUrl": "https://www.example.com/watch/12345",
        "contentKey": "fc4…"
      },
      "lastActivityMs": 1700000005000
    }
  }
}
```

- `connectedCount` is the true total of currently-connected clients in the room. The `clients` array is capped at 50 entries; `connectedCount` may exceed `clients.length`.
- `videoPos` is the server-extrapolated position right now (same definition as `ROOM_STATE.videoPos`), not the last-stored value.
- `contentIdentity` is `null` until the first JOIN with content fields establishes one.
- `lastActivityMs` is the latest of (a) any client's `lastSeenMs` and (b) the most recent event's `ts`. `null` for a runtime that has never had a client.

### Error codes

| Status | Body | Meaning |
|---|---|---|
| `400` | `{"error":"missing_request"}` | The HTTP frame couldn't be parsed. |
| `401` | `{"error":"unauthorized"}` | Missing, malformed, expired, or wrong-signature `X-PBSync-Admin` header. |
| `404` | `{"error":"not_found"}` | Path other than `/admin/rooms/presence`. |
| `405` | `{"error":"method_not_allowed"}` | Verb other than `GET`. |
| `500` | `{"error":"internal_error"}` | Unexpected daemon-side failure (also logged). |

## Sequence: A drops, reconnects, replays missed events

```
A           Server
|<close>     | (server tombstones A for 30 s)
|            | (A misses events 19 and 20 broadcast in the meantime)
|--JOIN{clientId, lastEventId=18}->|
|<-ROOM_STATE{lastEventId:20, recentEvents:[19,20]}-|
```
