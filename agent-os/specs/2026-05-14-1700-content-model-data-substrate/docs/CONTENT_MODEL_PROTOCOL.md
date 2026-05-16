# Content Model — Protocol

Wire-level details for the data model in [CONTENT_MODEL_DATA.md](CONTENT_MODEL_DATA.md). JSON field names are illustrative — the real protocol can rename or change types. The point is to make the contract concrete enough to spec.

Behaviour rules per toggle live in [CONTENT_MODEL_DEFAULT.md](CONTENT_MODEL_DEFAULT.md) / [CONTENT_MODEL_SINGLE.md](CONTENT_MODEL_SINGLE.md) / [CONTENT_MODEL_FREEFORM.md](CONTENT_MODEL_FREEFORM.md). This doc is *what goes on the wire.*

## Websocket messages

### `JOIN` (client → server)

Sent when a client connects to a room.

```json
{
  "type": "JOIN",
  "roomUuid": "9c4a…",
  "password": "…",
  "clientId": "client_a83b…",
  "currentlyShowing": {
    "providerId": "crunchyroll",
    "videoId": "frieren-s01e03",
    "pageUrl": "https://www.crunchyroll.com/watch/…"
  },
  "catalogFragment": [
    {
      "providerId": "crunchyroll",
      "videoId": "frieren-s01e01",
      "pageUrl": "…",
      "label": "Episode 1 — The Journey's End",
      "episodeNumber": 1,
      "seasonNumber": 1
    }
  ]
}
```

- `currentlyShowing` is optional. Without it, the room won't try to steer the joiner.
- `catalogFragment` is optional. Used to seed or extend the playlist with what the extension scraped from the page. Ignored if the room is in single mode.

### `ROOM_STATE` (server → client, response to JOIN)

Tells the joiner what state the room is in and what's currently playing.

```json
{
  "type": "ROOM_STATE",
  "singleMode": false,
  "freeformMode": false,
  "cursor": {
    "entryId": "e_02",
    "videoId": "frieren-s01e02",
    "pageUrl": "…",
    "label": "Episode 2 — It Didn't Have to Be Magic"
  },
  "playlistVersion": "v42",
  "playerState": "playing",
  "videoPos": 412.5
}
```

The full playlist is fetched out-of-band via HTTP (see below) to keep socket frames small. `playlistVersion` lets clients detect staleness.

### `CURSOR_CHANGE_REQUEST` (client → server)

A connected client asks the room to move the cursor.

**By entry id** (typical for default and single mode):

```json
{
  "type": "CURSOR_CHANGE_REQUEST",
  "targetEntryId": "e_05"
}
```

**By raw video reference** (typical for freeform mode, or when proposing a new entry):

```json
{
  "type": "CURSOR_CHANGE_REQUEST",
  "target": {
    "providerId": "youtube",
    "videoId": "newVidId",
    "pageUrl": "…",
    "label": "Some new video"
  }
}
```

Server reaction matrix:

| Mode | Target | Reaction |
|---|---|---|
| Single | existing entry id | Accept; cursor moves. |
| Single | new video (raw) | Reject `single_mode_locked`. |
| Default | existing entry id | Accept; cursor moves. |
| Default | raw video, already in playlist | Resolve to entry id; cursor moves. |
| Default | raw video, not in playlist | Reject `not_in_playlist`. Sender must `PLAYLIST_UPDATE` first. |
| Freeform | existing entry id | Accept; cursor moves. |
| Freeform | raw video, already in playlist | Resolve to entry id; cursor moves. |
| Freeform | raw video, not in playlist | Auto-append (`source: "auto_appended"`); cursor moves; broadcast `PLAYLIST_UPDATE` then `CURSOR_CHANGE`. |

### `CURSOR_CHANGE` (server → clients)

Broadcast after a successful cursor change. Also used as a **unicast** frame to steer a freshly-joined client whose `currentlyShowing` didn't match the cursor — same message, different addressing.

```json
{
  "type": "CURSOR_CHANGE",
  "cursor": {
    "entryId": "e_05",
    "videoId": "frieren-s01e05",
    "pageUrl": "…",
    "label": "Episode 5"
  },
  "eventId": 142,
  "ts": 1747204812
}
```

### `PLAYLIST_UPDATE` (bidirectional)

Adds entries to a room's playlist. From client (scraping or owner curation) or echoed by the server after a merge so all clients converge.

```json
{
  "type": "PLAYLIST_UPDATE",
  "entries": [
    {
      "providerId": "crunchyroll",
      "videoId": "frieren-s01e04",
      "pageUrl": "…",
      "label": "Episode 4",
      "episodeNumber": 4,
      "seasonNumber": 1,
      "source": "scraped"
    }
  ]
}
```

Server merges by `(providerId, videoId)` per the [merge rules](CONTENT_MODEL_DATA.md#merge-rules) and broadcasts the merged result.

Rejected with `single_mode_locked` in single-mode rooms.

Caps per [the growth-attack section](CONTENT_MODEL_DATA.md#catalog-growth-attacks):

- ≤ 200 entries per message.
- ≤ 1000 entries per room total → `playlist_cap_exceeded` once hit.
- Per-connection rate limit on `PLAYLIST_UPDATE` frames.

### Error frames

```json
{ "type": "ERROR", "code": "single_mode_locked", "message": "…" }
```

Codes used by the content model:

| Code | Meaning |
|---|---|
| `single_mode_locked` | A mutation was attempted on a `singleMode: true` room. |
| `not_in_playlist` | `CURSOR_CHANGE_REQUEST` referenced a video not in the (default-mode) playlist. |
| `cursor_locked_entry` | Tried to delete the entry the cursor currently points at. |
| `toggle_conflict` | Settings update tried to enable both `singleMode` and `freeformMode`. |
| `playlist_cap_exceeded` | `PLAYLIST_UPDATE` would push the room past the per-room entry cap. |

## HTTP endpoints

The dashboard and the daemon both call these. Paths are illustrative.

### `POST /api/v1/rooms`

Create a room.

```json
{
  "name": "Frieren marathon",
  "singleMode": false,
  "freeformMode": false,
  "bootstrapUrl": "https://www.crunchyroll.com/series/…",
  "initialEntries": [ /* optional */ ],
  "expiresInHours": 48
}
```

`singleMode: true` + `freeformMode: true` is rejected at this boundary with `toggle_conflict`.

`initialEntries` are inserted with their declared `source` (typically `"curated"`).

### `POST /api/v1/rooms/{uuid}/settings`

Toggle `singleMode` / `freeformMode` or update mutable metadata. Same `toggle_conflict` rule.

### `POST /api/v1/rooms/{uuid}/playlist/entries`

Owner-only. Add a curated entry (or batch). Rejected with `single_mode_locked` if the room is single-mode.

### `DELETE /api/v1/rooms/{uuid}/playlist/entries/{entryId}`

Owner-only. Rejected if `entryId` is the current cursor (`cursor_locked_entry`). Rejected entirely in single-mode rooms (`single_mode_locked`).

### `POST /api/v1/rooms/{uuid}/cursor`

Owner-only. Move the cursor from the dashboard picker:

```json
{ "targetEntryId": "e_05" }
```

Same reaction matrix as `CURSOR_CHANGE_REQUEST` over websocket.

### `GET /api/v1/rooms/{uuid}/playlist`

Fetch the full playlist (referenced by `playlistVersion` in `ROOM_STATE`).

## Migration notes

Old protocol → new protocol mapping for implementers:

- `EPISODE_CHANGE_REQUEST` → `CURSOR_CHANGE_REQUEST`.
- `EPISODE_CHANGE` → `CURSOR_CHANGE`.
- `CONTENT_MISMATCH` → no longer exists; folded into `CURSOR_CHANGE` (unicast for steering).
- The three-string content fingerprint (`providerId`, `episodeId`, `pageUrl`) → replaced by per-entry `(providerId, videoId, pageUrl)` plus an `entryId` once the entry is in the playlist.
