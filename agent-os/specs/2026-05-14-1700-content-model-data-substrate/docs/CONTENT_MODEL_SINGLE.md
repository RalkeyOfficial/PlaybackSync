# Content Model — Single Mode

`singleMode: true`, `freeformMode: false`. The playlist is locked: no additions, removals, or reorders. Builds on [CONTENT_MODEL_DATA.md](CONTENT_MODEL_DATA.md); wire details in [CONTENT_MODEL_PROTOCOL.md](CONTENT_MODEL_PROTOCOL.md).

## What single mode does

When `singleMode` is `true`:

- The playlist becomes immutable. `PLAYLIST_UPDATE` is rejected. `POST /api/v1/rooms/{uuid}/playlist/entries` is rejected. Per-entry `DELETE` is rejected.
- The cursor can still move between existing entries (rarely meaningful — single-mode rooms usually have one entry).
- JOIN steering still applies (see below).

The typical use is "watch one specific video, locked": the owner adds one entry at creation, enables `singleMode`, and the room can't drift from that target.

## Why it's opt-in, not the default

An earlier draft had a `kind` discriminator with separate "single" and "multi" types defaulting differently. The risk: an owner creates a "single" room, doesn't realize what it means, later wants to add episodes — they have to delete and recreate the room. The failure surface was "I can't do the thing I want, why is this room broken."

Making the *restrictive* behaviour opt-in flips this. The default path is always permissive. Owners who want a locked room check a box. Owners who didn't think about it get a room that does whatever they ask later.

- Cost of forgetting opt-in: "the playlist might grow when you didn't intend it" — easy to spot, easy to reverse.
- Cost of forgetting opt-out (the old design): confusing breakage requiring destructive recovery.

## JOIN behaviour

Same as default mode — steering, not disconnect. Single mode locks the *playlist*; it doesn't punish stale joiners.

| Joiner's video | Action |
|---|---|
| Matches the cursor | No steer. |
| Different entry in the playlist | Steer to cursor. |
| Not in the playlist at all | Steer to cursor (playlist can't grow to accommodate them). |
| `currentlyShowing` omitted | No steer. Joiner gets `ROOM_STATE` only. |

This is *better* than the old single-kind behaviour, which killed the connection on mismatch.

`catalogFragment` on JOIN is ignored in single mode (no merging into a locked playlist).

## Cursor changes

- `CURSOR_CHANGE_REQUEST` with `targetEntryId` pointing at an existing entry → accepted. Cursor moves; `CURSOR_CHANGE` broadcasts.
- `CURSOR_CHANGE_REQUEST` with a raw video reference (proposing a new entry) → rejected with `single_mode_locked`.
- `PLAYLIST_UPDATE` → rejected with `single_mode_locked`.

The dashboard hides "add video" controls when `singleMode` is on, so client-side rejections only happen for misbehaving clients.

## Toggling on a multi-entry playlist

Allowed; the dashboard warns:

> This will lock the playlist. Existing entries stay, but no new ones can be added.

After the toggle:

- Existing entries remain.
- The cursor can still move between them.
- All mutations are blocked until the toggle is flipped back.

This handles the "I started as a series room, finished curating, now I want to lock it" case.

## Toggling off

`POST /api/v1/rooms/{uuid}/settings` with `{ "singleMode": false }`. Room reverts to default mode. No data loss. The playlist becomes mutable again; `PLAYLIST_UPDATE` and curation calls succeed.

Single + freeform together is rejected at the API boundary (see [CONTENT_MODEL_DATA.md](CONTENT_MODEL_DATA.md#toggles)). Setting `singleMode: true` on a room that has `freeformMode: true` either:

- Requires the caller to flip freeform off in the same settings request, **or**
- Returns `toggle_conflict` if both would end up `true`.

## Bootstrap URL

For single-mode rooms, `bootstrapUrl` equals the sole entry's `pageUrl`. Set at creation.

## Scenario: one-shot YouTube video

> Alice wants to watch one Rick Astley video with two friends. She doesn't want anyone changing it or adding other videos.

**Room creation.** Alice pastes the YouTube URL, ticks "single mode" (with a help tooltip explaining the lock). The dashboard pre-fetches the video's title via oEmbed and submits:

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

Persisted:

```json
{
  "uuid": "abc",
  "singleMode": true,
  "freeformMode": false,
  "playlist": [
    { "entryId": "e_01", "position": 1, "videoId": "dQw4w9WgXcQ", "source": "curated", "label": "Rick Astley — Never Gonna Give You Up" }
  ],
  "cursorEntryId": "e_01"
}
```

**Friend joins on the right tab.** `currentlyShowing.videoId === cursor entry's videoId` → match. `ROOM_STATE` only.

**Friend joins on the wrong tab.** Server replies with `ROOM_STATE` pointing at the cursor; unicasts `CURSOR_CHANGE` to steer:

```json
{
  "type": "CURSOR_CHANGE",
  "cursor": { "entryId": "e_01", "videoId": "dQw4w9WgXcQ", "pageUrl": "…", "label": "Rick Astley — Never Gonna Give You Up" }
}
```

Extension navigates the tab.

**Someone tries to add a video.** `PLAYLIST_UPDATE` → `{ "type": "ERROR", "code": "single_mode_locked", "message": "playlist is locked while single mode is enabled" }`.

**Cursor change to a different video.** `CURSOR_CHANGE_REQUEST` with a raw target → same `single_mode_locked` rejection. Cursor changes between existing entries are allowed but no-op (only one entry).

**Owner toggles single mode off.** Alice realises she wants to add a sequel:

```
POST /api/v1/rooms/{uuid}/settings
{ "singleMode": false }
```

Room is now default mode. Alice adds entries via `PLAYLIST_UPDATE` or curation; the room becomes a series room. No data was lost; no destructive recovery was needed.
