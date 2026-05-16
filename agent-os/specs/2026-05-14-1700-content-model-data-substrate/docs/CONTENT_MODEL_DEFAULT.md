# Content Model — Default Mode

`singleMode: false`, `freeformMode: false`. The unnamed default; every room behaves this way unless an opt-in toggle says otherwise. Builds on [CONTENT_MODEL_DATA.md](CONTENT_MODEL_DATA.md); wire details in [CONTENT_MODEL_PROTOCOL.md](CONTENT_MODEL_PROTOCOL.md).

## What "default" means

A synchronized episode list:

- The playlist starts empty (or pre-curated by the owner at creation time) and grows as clients scrape pages or as the owner adds entries via the dashboard.
- The cursor moves between entries via a viewer's navigation or the owner's dashboard picker. **The cursor can only point at an entry that already exists in the playlist.**
- Joiners on a different video than the cursor are **steered**: the server tells them where the room actually is, and the extension navigates the tab.

This single mode-of-operation covers anime series, YouTube playlists, and owner-curated video sequences — they only differ in how the playlist gets filled.

## JOIN behaviour

The joiner reports `currentlyShowing` (the video their tab is on). Server reacts:

| Joiner's video | Action |
|---|---|
| Matches the cursor | No steer. Reply with `ROOM_STATE`. |
| In the playlist but not the cursor | Steer. Reply with `ROOM_STATE` pointing at the cursor and unicast `CURSOR_CHANGE` to navigate the tab. |
| Not in the playlist | Steer. Same as above — joiner's tab is just stale. |
| `currentlyShowing` omitted | No steer. Joiner gets `ROOM_STATE`; navigation is on them. |

There is no "fatal mismatch." Steering is always at least as helpful and never less safe than disconnecting.

If `catalogFragment` is included on JOIN, it merges into the playlist per the [merge rules](CONTENT_MODEL_DATA.md#merge-rules). The merged result is broadcast as `PLAYLIST_UPDATE` so other clients converge.

## Empty playlist on JOIN

A default-mode room with no scraped or curated entries: the first joiner's `currentlyShowing` seeds the playlist with one entry and sets the cursor. The seed entry's `source` follows where it came from — `"scraped"` if it was in `catalogFragment`, otherwise treat as a server-side seed (record `addedBy` as the joining client).

Implementation note: this is a special case of the normal merge — the first entry inserted while `cursorEntryId == null` becomes the cursor automatically.

## Cursor changes

Triggers:

- A connected viewer's extension reports a navigation: `CURSOR_CHANGE_REQUEST` with `targetEntryId`. Server accepts if the entry exists, broadcasts `CURSOR_CHANGE`.
- The owner uses the dashboard picker: `POST /api/v1/rooms/{uuid}/cursor` with `{ "targetEntryId": "e_05" }`. Same effect.
- `CURSOR_CHANGE_REQUEST` by raw video reference for an entry already in the playlist → resolve to entry id and move.
- `CURSOR_CHANGE_REQUEST` by raw video reference for a video **not** in the playlist → reject with `not_in_playlist`. The sender must `PLAYLIST_UPDATE` first, then request the cursor move. (Freeform mode does the auto-append shortcut — default mode does not.)

The cursor change is persisted so reconnecting clients see the right entry immediately.

## Cursor pointing at a deleted entry

Owner tries to delete the entry that's currently the cursor. The server **blocks the delete** with `cursor_locked_entry`: "this is the current entry, advance the cursor first." Predictable; owner stays in control.

Bulk "clear all" is a separate explicit action with its own confirmation; not the same code path as single-entry delete.

## Bootstrap URL

`bootstrapUrl` is where the public share link redirects new visitors who don't yet have a connection. For default-mode rooms, typical choices:

- Series landing page (scraped scenarios — Crunchyroll series page, YouTube playlist page).
- First entry's `pageUrl` (curated scenarios — YouTuber series with no native playlist).
- A "room dashboard" URL on the app itself (if routing through the app first is preferred).

Set at creation. Does not auto-update with the cursor.

## Logical seams

- **Toggling `singleMode: true` later.** Allowed; see [CONTENT_MODEL_SINGLE.md](CONTENT_MODEL_SINGLE.md#toggling-on-a-multi-entry-playlist).
- **Toggling `freeformMode: true` later.** Allowed; see [CONTENT_MODEL_FREEFORM.md](CONTENT_MODEL_FREEFORM.md#toggling-mid-session).
- **Cross-provider playlists.** A curated playlist could mix YouTube + Vimeo + anime. Logically supported, probably weird UX. Default to one provider per playlist; allow mixing only via an explicit setting if anyone asks.

## Scenarios

### Anime series (scraped)

> Bob and friends want to watch Frieren together on Crunchyroll. The site shows the episode list in a sidebar.

**Room creation.** Bob pastes the series landing page URL, leaves both toggles off:

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

Persisted: `{ "playlist": [], "cursorEntryId": null }`. Dashboard picker shows "playlist will populate when a viewer joins."

**First viewer joins on episode 3.** Bob navigates to episode 3; extension scrapes the sidebar and connects:

```json
{
  "type": "JOIN",
  "currentlyShowing": { "providerId": "crunchyroll", "videoId": "frieren-s01e03", "pageUrl": "…" },
  "catalogFragment": [
    { "providerId": "crunchyroll", "videoId": "frieren-s01e01", "label": "Episode 1", "episodeNumber": 1, "seasonNumber": 1, "pageUrl": "…" },
    { "providerId": "crunchyroll", "videoId": "frieren-s01e02", "label": "Episode 2", "episodeNumber": 2, "seasonNumber": 1, "pageUrl": "…" },
    { "providerId": "crunchyroll", "videoId": "frieren-s01e03", "label": "Episode 3", "episodeNumber": 3, "seasonNumber": 1, "pageUrl": "…" },
    { "providerId": "crunchyroll", "videoId": "frieren-s01e04", "label": "Episode 4", "episodeNumber": 4, "seasonNumber": 1, "pageUrl": "…" }
  ]
}
```

Server: merge all four with `source: "scraped"`; assign entry ids and positions; cursor was `null` so set it to `e_03` (the entry matching `currentlyShowing`); reply with `ROOM_STATE`.

**Late joiner on a stale episode 1 tab.** Server: `frieren-s01e01` is in the playlist but isn't the cursor → steer. Reply with `ROOM_STATE` pointing at `e_03`, unicast `CURSOR_CHANGE`. Extension navigates the tab.

**Bob navigates to episode 4.** Extension sends `CURSOR_CHANGE_REQUEST` with `targetEntryId: "e_04"`. Server updates cursor, broadcasts `CURSOR_CHANGE`. All clients navigate.

**Daemon restart.** Persisted state survives: `cursorEntryId: "e_04"`, full playlist intact. Reconnecting clients hydrate from the database; no re-negotiation needed.

### YouTube playlist (scraped)

> Carol wants to watch a YouTube playlist with friends.

Identical to anime, with three differences:

- `bootstrapUrl` is the playlist URL (`https://www.youtube.com/playlist?list=…`).
- Entry `pageUrl` carries the `list=` query parameter so extension navigation stays inside the playlist context. The server doesn't care; it just ships whatever was scraped.
- `episodeNumber` carries playlist position. `seasonNumber` is omitted.

### YouTuber series, no playlist (curated)

> Dan wants to watch a YouTuber's "Hardcore Minecraft" series — 30 separate videos uploaded over a year with no playlist on YouTube.

**Room creation.** Empty playlist; both toggles off.

**Curation.** Dan pastes each video URL into the dashboard, which calls `POST /api/v1/rooms/{uuid}/playlist/entries` with `source: "curated"`. The server may fetch oEmbed metadata to auto-fill labels. Batched submission supported.

**First viewer joins on episode 1.** No `catalogFragment` — YouTube doesn't expose the series, the extension has nothing to scrape. Server sees `currentlyShowing` matches the existing `e_01`, sets the cursor to `e_01`, replies with `ROOM_STATE`.

**Cursor movement.** Dan uses the dashboard picker: `POST /api/v1/rooms/{uuid}/cursor` with `{ "targetEntryId": "e_02" }`. Server broadcasts `CURSOR_CHANGE`; extensions navigate.

**Adding a forgotten episode mid-watch.** Dan adds an entry between 7 and 8 with the right `episodeNumber` (or an explicit `position`); playlist reorders, `PLAYLIST_UPDATE` broadcasts, dashboards re-render.

The only protocol-level difference from the scraped scenarios is how the playlist got filled.
