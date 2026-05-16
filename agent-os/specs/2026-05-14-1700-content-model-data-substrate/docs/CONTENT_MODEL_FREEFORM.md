# Content Model — Freeform Mode

`singleMode: false`, `freeformMode: true`. Cursor handling relaxes; the room follows whoever just switched. Builds on [CONTENT_MODEL_DATA.md](CONTENT_MODEL_DATA.md); wire details in [CONTENT_MODEL_PROTOCOL.md](CONTENT_MODEL_PROTOCOL.md).

## What freeform mode does

When `freeformMode` is `true`:

- Joiners arriving on a different video are **not** steered to the cursor. The room follows whoever just switched.
- Any client can move the cursor to a brand-new video that isn't in the playlist. The server **auto-appends** the new entry (with `source: "auto_appended"`) and broadcasts the cursor move.
- The playlist becomes more "videos we've collectively watched" than a planned catalog.

This is for "movie night" rooms where the synchronized-episodes framing is overkill. People just want to watch whatever, together.

## JOIN behaviour

The server has two reasonable policies for joiners whose `currentlyShowing` doesn't match the cursor:

- **Polite follow (default):** the joiner is steered to the current cursor. "I just joined, I'll catch up."
- **Eager append:** the joiner's video is auto-appended and the cursor moves to it.

**Default to polite follow.** Eager append would make every join hijack the room, which is hostile. Expose eager append as a per-room sub-setting only if anyone asks.

| Joiner's video | Action (polite follow, the default) |
|---|---|
| Matches the cursor | No steer. |
| In the playlist but not the cursor | Steer to cursor. |
| Not in the playlist | Steer to cursor. (Eager append flips this: auto-append + move cursor.) |
| `currentlyShowing` omitted | No steer. Joiner gets `ROOM_STATE` only. |

`catalogFragment` on JOIN is allowed and merges normally per [the rules](CONTENT_MODEL_DATA.md#merge-rules).

## Cursor changes

Triggers:

- `CURSOR_CHANGE_REQUEST` with `targetEntryId` → accepted if the entry exists. Same as default mode.
- `CURSOR_CHANGE_REQUEST` with a raw video reference for an entry **already in the playlist** → resolved to the existing entry id; cursor moves.
- `CURSOR_CHANGE_REQUEST` with a raw video reference for a new video → server auto-appends with `source: "auto_appended"`, then moves the cursor to it. Broadcasts both `PLAYLIST_UPDATE` (the new entry) and `CURSOR_CHANGE`.

Any viewer — not just the owner — can drive auto-append by switching videos.

## Auto-prune

Freeform rooms can accumulate many entries. The room enforces a cap (configurable, default e.g. 100):

- When the playlist exceeds the cap, drop the **oldest `auto_appended` entries first** (lowest `addedAt`).
- Never auto-drop `curated` entries.
- Never auto-drop the entry the cursor currently points at.

If only curated entries (plus the cursored entry) remain at the cap, the room stops accepting auto-appends until the owner clears entries.

## Multiple sources contributing to the same entry

Erin's freeform room auto-appended `vid_1`. She likes it, gives it a custom label via the dashboard. The dashboard offers "convert to curated":

- `source` flips from `auto_appended` to `curated`.
- Custom label is saved.
- Entry is now protected from auto-prune and label overwrite.

Merge rules still apply: future scrapes of `vid_1` (unlikely on YouTube but possible) update `lastSeenAt` only.

## Empty room

If everyone disconnects, the cursor stays where it was. The next joiner under polite follow gets steered to it; the cursor doesn't reset.

## Toggling mid-session

- **Default → freeform:** allowed freely. Mismatch handling relaxes immediately. Joiners on different tabs aren't steered any more; whoever switches first wins.
- **Freeform → default:** allowed freely. Tightens immediately. The *next* joiner on a stale tab gets steered to the current cursor. Existing `auto_appended` entries are kept (they're still real entries) but no more get added.
- **Freeform + single together:** rejected with `toggle_conflict` (see [CONTENT_MODEL_DATA.md](CONTENT_MODEL_DATA.md#toggles)).

## Bootstrap URL

Two reasonable choices, both supported by the data model:

- The current cursor's `pageUrl` (so share links land where the room currently is). Requires `bootstrapUrl` to auto-update on cursor change.
- A generic "join page" URL on the app itself (always lands on the dashboard; the extension takes over from there).

UX choice; not a data-model question.

## Scenario: random YouTube videos

> Erin and friends want to watch random stuff together. No series, no plan, just "here's a funny video."

**Room creation.** Erin ticks "freeform mode" in the dashboard. No bootstrap URL needed — the dashboard might use a generic "join page" URL, or default to the first video added.

```json
{ "name": "Movie night", "singleMode": false, "freeformMode": true, "initialEntries": [], "expiresInHours": 24 }
```

Persisted: `{ "freeformMode": true, "playlist": [], "cursorEntryId": null }`.

**First viewer picks a video.** Erin opens a YouTube video; extension reports:

```json
{
  "type": "JOIN",
  "currentlyShowing": { "providerId": "youtube", "videoId": "vid_1", "pageUrl": "…" }
}
```

Server: freeform, playlist empty. Auto-append `vid_1` with `source: "auto_appended"`, set cursor to it, reply with `ROOM_STATE`:

```json
{
  "playlist": [
    { "entryId": "e_01", "position": 1, "videoId": "vid_1", "source": "auto_appended" }
  ],
  "cursorEntryId": "e_01"
}
```

**Friend switches to a different video.** Friend clicks a YouTube suggestion:

```json
{
  "type": "CURSOR_CHANGE_REQUEST",
  "target": { "providerId": "youtube", "videoId": "vid_2", "pageUrl": "…", "label": "Some other video" }
}
```

Server: freeform, target not in playlist → auto-append + move cursor. Broadcast `PLAYLIST_UPDATE` (the new entry) and `CURSOR_CHANGE`. Everyone's tab navigates to `vid_2`. Erin's extension follows along — the room is "follow the leader."

**Late joiner on yet another video.** Third friend joins via the share link, but their tab is already on `vid_3`:

```json
{ "type": "JOIN", "currentlyShowing": { "videoId": "vid_3", "pageUrl": "…" } }
```

Polite follow (the default) → steer to `vid_2` (the current cursor). Friend's tab navigates.

**Owner curates an entry.** Erin uses the dashboard to convert `vid_1` to curated and sets a permanent label. Now `vid_1` is protected from auto-prune.

**Auto-prune kicks in.** After 100+ videos, the oldest `auto_appended` entries are dropped. Erin's curated `vid_1` stays. The cursored entry (whatever's playing now) is never dropped.
