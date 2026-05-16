# Content Model — Data & Persistence

The shared substrate for all room types. Read this first; the per-mode docs ([default](CONTENT_MODEL_DEFAULT.md), [single](CONTENT_MODEL_SINGLE.md), [freeform](CONTENT_MODEL_FREEFORM.md)) build on it. Wire-level details live in [CONTENT_MODEL_PROTOCOL.md](CONTENT_MODEL_PROTOCOL.md).

## Problem

Today, a room's "content identity" is a single opaque fingerprint — three flat strings (`providerId`, `episodeId`, `pageUrl`) hashed into one slot. This mashes two distinct concepts (the catalog of available videos vs. the one being played now) into one slot, and can't distinguish:

- A YouTube room playing one specific video.
- An anime room with a series of episodes the backend has to track.
- A "movie night" room cycling through unrelated videos.

The same data structure serves all three, so the dashboard, the protocol, and the persistence story all need to special-case behaviour that they can't actually special-case — nothing in the data distinguishes the cases.

## Core insight: playlist + cursor

A room has two things:

1. **Playlist** — what the room *can* play. An ordered list of video entries.
2. **Cursor** — what the room *is* playing right now. A reference to one entry in the playlist.

That's the only structural concept. Every room has this shape, regardless of how it's used. There is no `kind` discriminator. A one-video room is just a room whose playlist happens to have one entry. The differences between real-world scenarios come from *behaviour toggles*, not different data structures.

## Toggles

Two independent booleans, both default `false`, mutually exclusive (rejected at the API boundary if both are `true` — see [CONTENT_MODEL_PROTOCOL.md](CONTENT_MODEL_PROTOCOL.md#error-frames) for the `toggle_conflict` code):

| Toggle | When `true` | Spec |
|---|---|---|
| `singleMode` | Playlist is locked (no additions/removals/reorders). | [CONTENT_MODEL_SINGLE.md](CONTENT_MODEL_SINGLE.md) |
| `freeformMode` | Cursor handling relaxes (no steering, auto-append on jump). | [CONTENT_MODEL_FREEFORM.md](CONTENT_MODEL_FREEFORM.md) |

Both `false` is the [default mode](CONTENT_MODEL_DEFAULT.md).

## Room shape

```json
{
  "uuid": "9c4a…",
  "name": "Frieren marathon",
  "singleMode": false,
  "freeformMode": false,
  "playlist": [ /* see Playlist entry below */ ],
  "cursorEntryId": "e_02",
  "bootstrapUrl": "https://www.crunchyroll.com/series/…",
  "createdAt": 1747200000,
  "expiresAt": 1747800000
}
```

`cursorEntryId` is `null` when the playlist is empty (e.g. a curated room before the first entry is added, or a freeform room nobody has joined yet).

## Playlist entry shape

```json
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
}
```

Fields:

- `entryId` — server-assigned, opaque, stable for the entry's lifetime.
- `position` — explicit ordering; not implied by `episodeNumber`. Reorders update positions.
- `providerId` + `videoId` — natural key for merge; see merge rules below.
- `pageUrl` — what `CURSOR_CHANGE` ships to clients for tab navigation.
- `label` — human-readable; scraped, owner-set, or fetched via oEmbed.
- `episodeNumber` / `seasonNumber` — optional series metadata. For YouTube playlists, `episodeNumber` carries playlist position and `seasonNumber` is omitted.
- `source` — see below.
- `addedBy`, `addedAt` — provenance.
- `lastSeenAt` — refreshed by every scrape that reports this `(providerId, videoId)`; used to mark stale entries.

### Entry sources

- `"scraped"` — extension on a series-aware page contributed it (anime site sidebar, YouTube playlist sidebar).
- `"curated"` — owner added it explicitly via the dashboard.
- `"auto_appended"` — server added it when a freeform-mode viewer jumped to a video that wasn't already in the playlist.

Source matters for merge behaviour, auto-prune eligibility, and the event log.

## Merge rules

Server merges incoming entries by `(providerId, videoId)`:

- New `(providerId, videoId)` → insert with the declared `source`, assign `entryId` and `position`.
- Existing entry → merge metadata fields per source priority:
  - `curated` overrides everything. Scrapes of a curated entry update **only** `lastSeenAt`, never `label` / `episodeNumber` / `seasonNumber`.
  - For non-curated entries, most-recent scraped value wins.
- `lastSeenAt` is refreshed on every report regardless of source.

Manual "convert to curated" promotion: a freeform room's owner can take an `auto_appended` entry, give it a custom label, and the server flips `source` to `curated`. From then on it's protected from auto-prune and label overwrite.

## Stale entries

A site removed an episode → the next scrape doesn't include it → server leaves the entry alone, just doesn't refresh `lastSeenAt`. The dashboard picker dims entries with old `lastSeenAt`. The cursor can still point at one (clients hitting a 404 surface this).

The server **never deletes scraped entries automatically.** Removal is owner-driven (dashboard) or, for freeform `auto_appended` entries, the [auto-prune policy](CONTENT_MODEL_FREEFORM.md#auto-prune).

## Catalog growth attacks

`PLAYLIST_UPDATE` accepts arbitrary client-supplied entries. Mitigation:

- Per-message entry count cap (e.g. 200 entries).
- Per-room total playlist size cap (e.g. 1000 entries) → `playlist_cap_exceeded` once hit.
- Rate-limit `PLAYLIST_UPDATE` per connection.

Acceptable threat model: friend-group product, occasional buggy/malicious extension. Not hardened against determined attackers.

## Catalog ownership

Playlists are per-room. They are not shared across rooms. Two friend-groups watching the same anime end up with two independent playlists. This duplicates scraping work, but makes catalog ownership unambiguous: the room that has the playlist is the only one that can change it.

## Persistence boundary

| Lives in | What |
|---|---|
| Database (per room) | `singleMode`, `freeformMode`, full playlist, `cursorEntryId`, room metadata (`name`, owner, password hash, expiry, `bootstrapUrl`) |
| Daemon memory (per room runtime) | playback state (playing/paused, `videoPos`, `eventId`), connected client list, in-flight event log ring buffer |
| Nowhere shared | catalog metadata across rooms — each room owns its own |

Key change from today: the playlist, cursor, and toggle flags live in the database. Daemon restarts no longer lose "what we were watching." Late joiners learn the current entry from persisted state even if no other client is connected.

Playback position is still ephemeral. Throttled writes (every 30s on heartbeat, say) for "resume where we left off" could be added later; not part of this design.

## Use case mapping

| Scenario | `singleMode` | `freeformMode` | Where to read |
|---|---|---|---|
| One specific YouTube video | `true` | `false` | [CONTENT_MODEL_SINGLE.md](CONTENT_MODEL_SINGLE.md) |
| Anime series (scraped) | `false` | `false` | [CONTENT_MODEL_DEFAULT.md](CONTENT_MODEL_DEFAULT.md) |
| YouTube playlist (scraped) | `false` | `false` | [CONTENT_MODEL_DEFAULT.md](CONTENT_MODEL_DEFAULT.md) |
| YouTuber series, no playlist (curated) | `false` | `false` | [CONTENT_MODEL_DEFAULT.md](CONTENT_MODEL_DEFAULT.md) |
| Random movie night | `false` | `true` | [CONTENT_MODEL_FREEFORM.md](CONTENT_MODEL_FREEFORM.md) |

Most rooms need no toggles. Single and freeform are deliberate deviations.

## Why this shape holds up

- **No creation-time choice that can't be reversed.** Both toggles can be flipped after the fact.
- **The default path is always permissive.** Forgetting to set a toggle never blocks legitimate use; at worst it allows behaviour the owner didn't intend, which is recoverable.
- **The protocol has one shape.** Same messages, same payloads, all rooms. Behaviour branches on toggle flags, not on a kind discriminator.
- **The schema has one shape.** Every room has a playlist (sometimes of size one) and a cursor. No `IF kind = …` in the persistence layer.
