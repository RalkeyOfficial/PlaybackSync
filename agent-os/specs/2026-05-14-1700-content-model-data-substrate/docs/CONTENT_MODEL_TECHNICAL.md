# Content Model — Technical Reference

Companion to [CONTENT_MODEL.md](CONTENT_MODEL.md). That document describes the logical model; this one shows the concrete data shapes, the websocket protocol changes, and walks through each real-world scenario step by step.

This is not a final spec. JSON shapes are illustrative — the real protocol can rename fields or change types. The point is to make the model concrete enough to reason about.

## Contents

1. [Conceptual data shapes](#conceptual-data-shapes)
2. [Protocol messages](#protocol-messages)
3. [Persistence boundary](#persistence-boundary)
4. [Scenario walkthroughs](#scenario-walkthroughs)
   - [One-shot YouTube video (single mode)](#scenario-1-one-shot-youtube-video-single-mode)
   - [Anime series (scraped, default mode)](#scenario-2-anime-series-scraped-default-mode)
   - [YouTube playlist (scraped, default mode)](#scenario-3-youtube-playlist-scraped-default-mode)
   - [YouTuber series, no playlist (curated, default mode)](#scenario-4-youtuber-series-no-playlist-curated-default-mode)
   - [Random YouTube videos (freeform mode)](#scenario-5-random-youtube-videos-freeform-mode)
5. [Cross-cutting edge cases](#cross-cutting-edge-cases)

---

## Conceptual data shapes

These are illustrative JSON shapes for the logical entities. Field names are suggestions, not commitments.

### Room

Every room has the same shape. The two toggles default to `false`, and the playlist/cursor adapt to however the room is used.

```json
{
  "uuid": "9c4a…",
  "name": "Frieren marathon",
  "singleMode": false,
  "freeformMode": false,
  "playlist": [
    {
      "entryId": "e_01",
      "position": 1,
      "providerId": "crunchyroll",
      "videoId": "frieren-s01e01",
      "pageUrl": "https://www.crunchyroll.com/watch/GRDQK8E0R/the-journey-s-end",
      "label": "Episode 1 — The Journey's End",
      "episodeNumber": 1,
      "seasonNumber": 1,
      "source": "scraped",
      "addedBy": "client_a83b…",
      "addedAt": 1747201023,
      "lastSeenAt": 1747204500
    },
    {
      "entryId": "e_02",
      "position": 2,
      "providerId": "crunchyroll",
      "videoId": "frieren-s01e02",
      "pageUrl": "https://www.crunchyroll.com/watch/G62PEK5N8/it-didn-t-have-to-be-magic",
      "label": "Episode 2 — It Didn't Have to Be Magic",
      "episodeNumber": 2,
      "seasonNumber": 1,
      "source": "scraped",
      "addedBy": "client_a83b…",
      "addedAt": 1747201023,
      "lastSeenAt": 1747204500
    }
  ],
  "cursorEntryId": "e_02",
  "createdAt": 1747200000,
  "expiresAt": 1747800000
}
```

A one-shot video room is the same shape, with `singleMode: true` and a playlist of one. A movie-night room is the same shape, with `freeformMode: true` and an initially empty playlist. There is no `kind` field.

The combination `singleMode: true` + `freeformMode: true` is rejected at the API boundary.

### Playlist entry sources

- `"scraped"` — the extension on a series-aware page contributed it.
- `"curated"` — the owner added it explicitly via the dashboard.
- `"auto_appended"` — the server auto-added it when a freeform-mode viewer jumped to a video that wasn't already in the playlist.

The source field matters for re-scrape behaviour (curated entries are not overwritten by scrapes) and for the event log.

---

## Protocol messages

Today's `EPISODE_CHANGE_REQUEST` / `EPISODE_CHANGE` get renamed to `CURSOR_CHANGE_REQUEST` / `CURSOR_CHANGE`. A `PLAYLIST_UPDATE` message carries playlist additions. Today's `CONTENT_MISMATCH` semantics are folded into steering — see below.

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

The full playlist can be fetched out-of-band via an HTTP endpoint to keep socket frames small. `playlistVersion` lets clients detect staleness.

### `CURSOR_CHANGE_REQUEST` (client → server)

A connected client asks the room to move the cursor.

By entry id (typical for default and single mode):

```json
{
  "type": "CURSOR_CHANGE_REQUEST",
  "targetEntryId": "e_05"
}
```

By raw video reference (typical for freeform mode, or when proposing a new entry):

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

Server behaviour:

- **Single mode**, target is an existing entry → accepted (cursor can still move between locked entries).
- **Single mode**, target is a new video → rejected with `single_mode_locked`.
- **Default mode**, target by entry id → accepted if the entry exists.
- **Default mode**, target by raw video → rejected; sender must `PLAYLIST_UPDATE` first.
- **Freeform mode**, target by raw video not in playlist → server auto-appends with `source: "auto_appended"`, then moves cursor.
- **Freeform mode**, target by entry id → accepted (same as default).

### `CURSOR_CHANGE` (server → all clients)

Broadcast after a successful cursor change. Carries enough info for clients to navigate the tab.

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

`CURSOR_CHANGE` is also sent unicast to a joiner whose `currentlyShowing` didn't match the cursor — that's how "steering" works on the wire. Same message shape; different addressing.

### `PLAYLIST_UPDATE` (bidirectional)

Adds entries to a room's playlist. Can come from a client (scraping or owner curation) or be echoed from the server after a merge.

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

Server merges by `(providerId, videoId)`. Existing entries' metadata is not overwritten unless the new source is at least as authoritative (curated overrides scraped; scraped only updates `lastSeenAt` if a curated entry already exists). The server broadcasts the merged result back so all clients converge on the same view.

`PLAYLIST_UPDATE` is rejected in single-mode rooms with `single_mode_locked`.

---

## Persistence boundary

| Lives in | What |
|---|---|
| Database (per room) | `singleMode`, `freeformMode`, full playlist, `cursorEntryId`, room metadata (name, owner, password hash, expiry, bootstrap URL) |
| Daemon memory (per room runtime) | playback state (playing/paused, position, eventId), connected client list, in-flight event log ring buffer |
| Nowhere shared | catalog metadata across rooms — each room owns its own |

The key persistence change from today: the playlist, cursor, and toggle flags live in the database. Daemon restarts no longer lose "what we were watching." Late joiners learn the current entry from persisted state even if no other client is connected.

Playback position is still ephemeral. Throttled writes (e.g., every 30s on heartbeat) could be added later for "resume where we left off" but aren't part of this design.

---

## Scenario walkthroughs

Each scenario shows the steps from room creation to a typical user interaction, with the messages exchanged and the persisted state at each point.

### Scenario 1: One-shot YouTube video (single mode)

> Alice wants to watch one Rick Astley video with two friends. She doesn't want anyone changing it or adding other videos.

**Step 1 — Room creation (HTTP, dashboard)**

Alice pastes the YouTube URL, ticks "single mode" (with a help tooltip explaining the lock). The dashboard pre-fetches the video's title via oEmbed and submits:

```json
{
  "name": "Rick's farewell",
  "singleMode": true,
  "freeformMode": false,
  "bootstrapUrl": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  "initialEntries": [
    {
      "providerId": "youtube",
      "videoId": "dQw4w9WgXcQ",
      "pageUrl": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "label": "Rick Astley — Never Gonna Give You Up",
      "source": "curated"
    }
  ],
  "expiresInHours": 24
}
```

Persisted state:

```json
{
  "uuid": "abc",
  "singleMode": true,
  "freeformMode": false,
  "playlist": [
    { "entryId": "e_01", "position": 1, "videoId": "dQw4w9WgXcQ", "source": "curated", "label": "Rick Astley — Never Gonna Give You Up", … }
  ],
  "cursorEntryId": "e_01"
}
```

**Step 2 — First viewer joins**

Friend clicks the share link, lands on the YouTube watch page, extension connects:

```json
{
  "type": "JOIN",
  "roomUuid": "abc",
  "clientId": "c_001",
  "currentlyShowing": { "providerId": "youtube", "videoId": "dQw4w9WgXcQ", "pageUrl": "…" }
}
```

Server: `currentlyShowing.videoId === cursor entry's videoId` → match. Replies with `ROOM_STATE`. No further action.

**Step 3 — Second viewer joins on the wrong tab**

Friend's browser cached a different YouTube video:

```json
{
  "type": "JOIN",
  "currentlyShowing": { "providerId": "youtube", "videoId": "abc123", "pageUrl": "…" }
}
```

Server: tab is stale. Replies with `ROOM_STATE` pointing at the cursor, immediately sends `CURSOR_CHANGE` to steer the joiner:

```json
{
  "type": "CURSOR_CHANGE",
  "cursor": { "entryId": "e_01", "videoId": "dQw4w9WgXcQ", "pageUrl": "…", "label": "Rick Astley — Never Gonna Give You Up" }
}
```

Extension navigates the tab. Note that this is *better* than the old single-kind behaviour, which would have killed the connection. Single mode locks the playlist; it doesn't punish stale joiners.

**Step 4 — Someone tries to add a video**

An extension sends a `PLAYLIST_UPDATE`. Server rejects:

```json
{ "type": "ERROR", "code": "single_mode_locked", "message": "playlist is locked while single mode is enabled" }
```

The dashboard hides the "add video" controls when single mode is on, so this should only happen for misbehaving clients.

**Step 5 — Cursor changes**

Any `CURSOR_CHANGE_REQUEST` for a different video gets the same `single_mode_locked` rejection. Cursor changes between *existing* entries are allowed, but there's only one entry, so this is a no-op.

**Step 6 — Owner toggles single mode off**

Alice realises she wants to add a sequel. She unticks single mode in the dashboard:

```
POST /api/v1/rooms/{uuid}/settings
{ "singleMode": false }
```

The room now behaves as default mode. Alice can add a `PLAYLIST_UPDATE` from the dashboard, and the room becomes a series room. No data was lost; no destructive recovery was needed.

---

### Scenario 2: Anime series (scraped, default mode)

> Bob and friends want to watch Frieren together on Crunchyroll. The site shows the episode list in a sidebar.

**Step 1 — Room creation**

Bob pastes the series landing page URL, leaves both toggles off (default):

```json
{
  "name": "Frieren marathon",
  "singleMode": false,
  "freeformMode": false,
  "bootstrapUrl": "https://www.crunchyroll.com/series/GG5H5XQX4/frieren",
  "initialEntries": [],
  "expiresInHours": 48
}
```

Persisted state:

```json
{ "uuid": "9c4a", "singleMode": false, "freeformMode": false, "playlist": [], "cursorEntryId": null }
```

The playlist is empty. The dashboard picker shows "playlist will populate when a viewer joins."

**Step 2 — First viewer joins on episode 3**

Bob navigates to episode 3 of Frieren. Extension scrapes the sidebar episode list and connects:

```json
{
  "type": "JOIN",
  "clientId": "c_002",
  "currentlyShowing": {
    "providerId": "crunchyroll",
    "videoId": "frieren-s01e03",
    "pageUrl": "https://www.crunchyroll.com/watch/…/ep-3"
  },
  "catalogFragment": [
    { "providerId": "crunchyroll", "videoId": "frieren-s01e01", "pageUrl": "…", "label": "Episode 1", "episodeNumber": 1, "seasonNumber": 1 },
    { "providerId": "crunchyroll", "videoId": "frieren-s01e02", "pageUrl": "…", "label": "Episode 2", "episodeNumber": 2, "seasonNumber": 1 },
    { "providerId": "crunchyroll", "videoId": "frieren-s01e03", "pageUrl": "…", "label": "Episode 3", "episodeNumber": 3, "seasonNumber": 1 },
    { "providerId": "crunchyroll", "videoId": "frieren-s01e04", "pageUrl": "…", "label": "Episode 4", "episodeNumber": 4, "seasonNumber": 1 }
  ]
}
```

Server actions:
1. Playlist is empty; merge all four entries with `source: "scraped"`, assign entry ids and positions.
2. The room has no cursor yet; the joiner's `currentlyShowing` is in the playlist, so set the cursor to `frieren-s01e03`.
3. Reply with `ROOM_STATE`.

Persisted state after step 2:

```json
{
  "playlist": [
    { "entryId": "e_01", "position": 1, "videoId": "frieren-s01e01", … },
    { "entryId": "e_02", "position": 2, "videoId": "frieren-s01e02", … },
    { "entryId": "e_03", "position": 3, "videoId": "frieren-s01e03", … },
    { "entryId": "e_04", "position": 4, "videoId": "frieren-s01e04", … }
  ],
  "cursorEntryId": "e_03"
}
```

**Step 3 — Late joiner on a stale episode 1 tab**

Friend clicks share link, browser cached an episode 1 tab from yesterday:

```json
{
  "type": "JOIN",
  "currentlyShowing": { "providerId": "crunchyroll", "videoId": "frieren-s01e01", "pageUrl": "…" }
}
```

Server: video is in the playlist but isn't the cursor. Default mode → steer. Replies with `ROOM_STATE` pointing at the current cursor, immediately sends:

```json
{
  "type": "CURSOR_CHANGE",
  "cursor": { "entryId": "e_03", "videoId": "frieren-s01e03", "pageUrl": "…", "label": "Episode 3" }
}
```

Extension navigates the tab to episode 3. Sync resumes.

**Step 4 — Bob navigates to episode 4**

After episode 3 finishes, Bob clicks "next episode" on Crunchyroll. Extension reports:

```json
{ "type": "CURSOR_CHANGE_REQUEST", "targetEntryId": "e_04" }
```

Server checks: entry exists, request is valid. Updates cursor, broadcasts:

```json
{ "type": "CURSOR_CHANGE", "cursor": { "entryId": "e_04", … } }
```

All connected clients navigate to episode 4.

**Step 5 — Daemon restart**

Server process is restarted. All websocket connections drop. The persisted room state survives:

```json
{ "cursorEntryId": "e_04", "playlist": [ … ] }
```

When Bob reconnects, the JOIN handler hydrates the room from the database — cursor still on episode 4, full playlist intact. No re-negotiation needed.

---

### Scenario 3: YouTube playlist (scraped, default mode)

> Carol wants to watch a YouTube playlist with friends.

**Step 1 — Room creation**

Carol pastes the YouTube playlist URL, leaves toggles off:

```
https://www.youtube.com/playlist?list=PLBCF2DAC6FFB574DE
```

**Step 2 — First viewer joins**

Viewer clicks a video in the playlist; extension scrapes the playlist sidebar:

```json
{
  "type": "JOIN",
  "currentlyShowing": { "providerId": "youtube", "videoId": "vid_a", "pageUrl": "https://www.youtube.com/watch?v=vid_a&list=PLBCF…" },
  "catalogFragment": [
    { "providerId": "youtube", "videoId": "vid_a", "pageUrl": "…", "label": "Intro", "episodeNumber": 1 },
    { "providerId": "youtube", "videoId": "vid_b", "pageUrl": "…", "label": "Part 2", "episodeNumber": 2 },
    { "providerId": "youtube", "videoId": "vid_c", "pageUrl": "…", "label": "Part 3", "episodeNumber": 3 }
  ]
}
```

`episodeNumber` here just means "playlist position." YouTube doesn't have a season concept; `seasonNumber` is omitted.

Server merges and sets cursor. The rest plays out identically to the anime scenario — same protocol, same UX.

The only material difference from anime is that the `pageUrl` carries the `list=` query parameter, so navigation by the extension stays inside the playlist context. The server doesn't care.

---

### Scenario 4: YouTuber series, no playlist (curated, default mode)

> Dan wants to watch a YouTuber's "Hardcore Minecraft" series — 30 separate videos uploaded over a year with no playlist on YouTube.

**Step 1 — Room creation**

Dan leaves toggles off. There's no playlist URL to paste, but the dashboard offers "I'll add videos manually." Dan creates the room with an empty playlist:

```json
{ "name": "Hardcore series", "singleMode": false, "freeformMode": false, "initialEntries": [], "expiresInHours": 168 }
```

**Step 2 — Dan curates the playlist via dashboard**

Dan pastes the first video URL, hits "add." The dashboard sends:

```
POST /api/v1/rooms/{uuid}/playlist/entries
```
```json
{
  "providerId": "youtube",
  "videoId": "abc111",
  "pageUrl": "https://www.youtube.com/watch?v=abc111",
  "label": "Hardcore Minecraft Ep 1",
  "episodeNumber": 1,
  "source": "curated"
}
```

The server may fetch the YouTube oEmbed metadata to auto-fill the label. Dan repeats this for episodes 2 through 30, optionally in batch.

Persisted state after curation:

```json
{
  "playlist": [
    { "entryId": "e_01", "position": 1, "videoId": "abc111", "label": "Hardcore Minecraft Ep 1", "source": "curated", … },
    { "entryId": "e_02", "position": 2, "videoId": "abc222", "label": "Hardcore Minecraft Ep 2", "source": "curated", … },
    …
  ],
  "cursorEntryId": null
}
```

The cursor is null until the first viewer joins.

**Step 3 — First viewer joins**

Viewer navigates to episode 1 (Dan shared the link). Extension connects:

```json
{
  "type": "JOIN",
  "currentlyShowing": { "providerId": "youtube", "videoId": "abc111", "pageUrl": "…" }
}
```

No `catalogFragment` — YouTube doesn't expose this as a series, the extension has nothing to scrape. Server sees that the viewer's video matches `e_01` in the existing playlist, sets the cursor to `e_01`, replies with `ROOM_STATE`.

**Step 4 — Cursor movement**

When Dan clicks the next-episode picker in the dashboard:

```
POST /api/v1/rooms/{uuid}/cursor
```
```json
{ "targetEntryId": "e_02" }
```

Server broadcasts `CURSOR_CHANGE`, extensions navigate. From the protocol's perspective, identical to scenarios 2 and 3 — the only difference is how the playlist was filled (curated vs scraped).

**Step 5 — Adding a forgotten episode mid-watch**

Halfway through the series, Dan realises he missed an episode between 7 and 8. He goes to the dashboard, adds the entry with the right `episodeNumber` (or by setting an explicit position), and saves. The playlist reorders, broadcast goes to all clients, dashboards re-render.

---

### Scenario 5: Random YouTube videos (freeform mode)

> Erin and friends want to watch random stuff together. No series, no plan, just "here's a funny video."

**Step 1 — Room creation**

Erin ticks "freeform mode" in the dashboard. No bootstrap URL needed — the dashboard might use a generic "join page" URL, or default to the first video added.

```json
{ "name": "Movie night", "singleMode": false, "freeformMode": true, "initialEntries": [], "expiresInHours": 24 }
```

Persisted state:

```json
{ "singleMode": false, "freeformMode": true, "playlist": [], "cursorEntryId": null }
```

**Step 2 — First viewer picks a video**

Erin opens a YouTube video, extension reports:

```json
{
  "type": "JOIN",
  "currentlyShowing": { "providerId": "youtube", "videoId": "vid_1", "pageUrl": "…" }
}
```

Server: freeform mode, playlist is empty. Auto-appends `vid_1` and sets the cursor to it:

```json
{
  "playlist": [
    { "entryId": "e_01", "position": 1, "videoId": "vid_1", "source": "auto_appended", … }
  ],
  "cursorEntryId": "e_01"
}
```

Replies with `ROOM_STATE`.

**Step 3 — Friend switches to a different video**

Friend gets bored, clicks a YouTube suggested video. Their extension reports:

```json
{
  "type": "CURSOR_CHANGE_REQUEST",
  "target": { "providerId": "youtube", "videoId": "vid_2", "pageUrl": "…", "label": "Some other video" }
}
```

Server: freeform mode, target isn't in playlist → auto-append + move cursor:

```json
{
  "playlist": [
    { "entryId": "e_01", "videoId": "vid_1", "source": "auto_appended", … },
    { "entryId": "e_02", "videoId": "vid_2", "source": "auto_appended", "addedBy": "client_friend" }
  ],
  "cursorEntryId": "e_02"
}
```

Broadcasts `CURSOR_CHANGE`. Everyone's tab navigates to `vid_2`. Erin's extension follows along — the room is "follow the leader."

**Step 4 — Late joiner on yet another video**

A third friend joins via the share link, but their tab was already on `vid_3`:

```json
{ "type": "JOIN", "currentlyShowing": { "videoId": "vid_3", "pageUrl": "…" } }
```

Freeform mode → no steer. But the room can choose one of two reasonable policies, exposed as a sub-setting if anyone asks:

- **Polite follow:** the joiner gets steered to `vid_2` (the current cursor). "I just joined, I'll catch up."
- **Eager append:** the joiner's video is auto-appended and the cursor moves to it.

Default to polite follow — eager append would make every join hijack the room, which is hostile.

**Step 5 — Owner can still curate**

Erin can use the dashboard to add explicit entries, reorder, or remove entries. Curated entries get `source: "curated"` and aren't auto-pruned by any cleanup policy.

**Step 6 — Auto-prune**

Freeform rooms can accumulate many entries. A configured cap (say, 100 entries) drops the oldest `auto_appended` entries when the playlist grows beyond it. Curated entries are never auto-dropped.

---

## Cross-cutting edge cases

These apply across scenarios.

### Catalog merge conflicts

Two clients on a scraped series report the same `videoId` with different labels:

- Client A: `"Episode 12: TBA"` (scraped from a placeholder page).
- Client B: `"Episode 12: The Final Battle"` (scraped after the page was updated).

Merge policy:
- `(providerId, videoId)` is the natural key.
- For metadata fields (`label`, `episodeNumber`, etc.), most-recent scraped value wins.
- A curated value never gets overwritten by a scraped value (the owner edited deliberately).

`source` and `lastSeenAt` are updated on every report so re-scrapes refresh the "seen" timestamp without losing the curated override.

### Stale entries

The site removed an episode. The next scrape doesn't include it. The server doesn't delete it — it just stops touching `lastSeenAt`. The dashboard picker can show entries with old `lastSeenAt` as dimmed, and the cursor can still point at one (clients trying to navigate will hit a 404, which the extension can surface).

### Catalog growth attacks

A buggy or hostile extension could send a `PLAYLIST_UPDATE` with thousands of entries. Mitigation:
- Per-message entry count cap (e.g., 200 entries).
- Per-room total playlist size cap (e.g., 1000 entries).
- Rate-limit `PLAYLIST_UPDATE` per connection.

### Cursor pointing at a deleted entry

Owner deletes an entry that's currently the cursor. Server's two reasonable options:
- Block the delete with a clear error: "this is the current entry, advance the cursor first."
- Auto-advance the cursor to the next entry by position, or pause the room if none exists.

I'd go with blocking — predictable, owner stays in control. Bulk operations (clear all) are a separate explicit action.

In a single-mode room, deletion is disallowed entirely, so this case doesn't arise.

### Toggling single mode on a multi-entry playlist

Allowed, but the dashboard warns: "this will lock the playlist. Existing entries stay, but no new ones can be added." After the toggle, the cursor can still move between the existing entries; only mutations are blocked.

### Toggling freeform mode mid-session

Allowed freely. Going from default to freeform relaxes mismatch handling — joiners on different tabs aren't steered any more; whoever switches first wins. Going from freeform back to default tightens it; the *next* joiner on a stale tab gets steered to the current cursor.

### Toggling both modes on at once

Rejected at creation time and at the toggle endpoint. The combination is meaningless: single mode says the playlist can't grow; freeform mode requires it to grow.

### Auto-append in a freeform room with no one to follow

If Erin's the only client and she just disconnects, the cursor stays where it was. Next joiner gets steered to it (if default-mode joiner policy is chosen) or follows the leader (freeform default).

### Multiple sources contributing to the same entry

Erin starts a freeform room, auto-appends `vid_1`. Later she decides to curate it (set a custom label, lock it in). The dashboard offers "convert to curated" — `source` flips to `curated`, the label can be edited, and the entry is now protected from auto-prune. The merge rules from the conflict section apply: future scrapes can update `lastSeenAt` but not the label.

### `bootstrapUrl` vs entry `pageUrl`

The room's `bootstrapUrl` is where the public share link redirects new visitors who don't yet have a connection. Per-entry `pageUrl` is what `CURSOR_CHANGE` carries for tab navigation. They diverge:

- Single-mode room with one entry: `bootstrapUrl` = that entry's `pageUrl`.
- Default-mode scraped series: `bootstrapUrl` = series landing page; entry `pageUrl` = individual episode URL.
- Default-mode curated series: `bootstrapUrl` could be the first entry's `pageUrl`, or a "room dashboard" URL.
- Freeform room: `bootstrapUrl` could be the current cursor's `pageUrl`, or a generic "join page" URL.

The bootstrap URL is set at creation. Whether it auto-updates with the cursor (for freeform especially) is a UX choice — but the data model supports either.
