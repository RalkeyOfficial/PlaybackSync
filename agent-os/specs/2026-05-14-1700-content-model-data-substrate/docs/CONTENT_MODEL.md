# Content Model

A logical design document for how PlaybackSync rooms represent the thing they're synchronizing — what's being watched, what's currently playing, and how that distinction maps onto real-world site shapes (single videos, anime episode lists, YouTube playlists, curated "let's play" sequences, and freeform movie nights).

This document is intentionally non-technical. No schemas, no protocol frames, no PHP. It describes the logical model so the design can be evaluated and stress-tested against real scenarios before any code is written.

## Problem

Today, a room's "content identity" is a single opaque fingerprint — three flat strings (`providerId`, `episodeId`, `pageUrl`) hashed together into one slot. This mashes two distinct concepts into one and can't tell the difference between fundamentally different room shapes:

- A YouTube room playing one specific video.
- An anime room with a series of episodes the backend has to track.
- A "movie night" room cycling through unrelated videos.

The same data structure is used for all three, which means the dashboard, the protocol, and the persistence story all need to special-case behaviour that they can't actually special-case — because nothing in the data distinguishes the cases.

## Core insight: playlist + cursor

A room has two things:

1. **Playlist** — what the room *can* play. An ordered list of video entries.
2. **Cursor** — what the room *is* playing right now. A reference to one entry in the playlist.

That's the only structural concept. Every room has this shape, regardless of how it's used. There is no separate "kind" of room — a one-video room is just a room whose playlist happens to have one entry.

The differences between real-world scenarios (anime, YouTube playlist, freeform movie night) come from *behaviour toggles*, not different data structures.

## Default behaviour ("series mode")

By default, a room behaves as a synchronized episode list:

- The playlist starts empty (or pre-curated by the owner at creation time) and grows as clients scrape pages or as the owner adds entries.
- The cursor moves between entries via a viewer's navigation or the owner's dashboard picker. The cursor can only point at an entry that already exists in the playlist.
- Joiners arriving on a different video than the cursor are **steered** to the cursor — the server tells them where the room actually is, and the extension navigates the tab. Joiners on a video that isn't in the playlist at all are also steered (their tab is just stale).

This is the unnamed default. It's what every room is unless an opt-in toggle says otherwise.

## Opt-in toggles

Two independent toggles, both off by default. Each modifies the default behaviour in a specific way.

### Single mode (playlist lock)

When **single mode** is enabled, the playlist becomes immutable. No additions, removals, or reorders. The cursor can still move between existing entries — but typically there's only one. This is how a "watch one specific video" room is expressed: the owner adds one entry at creation, enables single mode, and the room can't drift from that target.

**Why single mode is opt-in, not the default.** The previous draft of this model had a `kind` discriminator with separate "single" and "multi" types that defaulted differently. The risk: an owner creates a "single" room, doesn't realize what it means, later wants to add episodes — and now they have to delete and recreate the room. Worse, the failure surface was "I can't do the thing I want, why is this room broken." By making the *restrictive* behaviour opt-in, the default path is always permissive. Owners who explicitly want a locked room get one by checking a box. Owners who didn't think about it get a room that does whatever they ask later. The cost of forgetting opt-in is "the playlist might grow when you didn't intend it" — easy to spot, easy to reverse. The cost of forgetting opt-out (the old design) was confusing breakage requiring destructive recovery.

### Freeform mode (relaxed cursor)

When **freeform mode** is enabled, the cursor handling relaxes:

- Joiners arriving on a different video are *not* steered to the cursor. The room follows whoever just switched.
- Any client can move the cursor to a brand-new video that isn't in the playlist. The server auto-appends the new entry and broadcasts the cursor move.

This is for "movie night" rooms where the synchronized-episodes framing is overkill. People just want to watch whatever, together. The playlist becomes more of a "videos we've collectively watched" history than a planned catalog.

### Invalid combination

Single mode and freeform mode are mutually exclusive. Single mode says the playlist can't grow; freeform mode requires it to grow on demand. Enabling both is rejected at creation time and at the toggle endpoint.

## Use case mapping

| Scenario | Single mode | Freeform mode | Notes |
|---|---|---|---|
| One specific YouTube video | On | Off | Owner adds one entry, locks it |
| Anime series (scraped) | Off | Off | Default — extension fills the playlist |
| YouTube playlist | Off | Off | Default — extension scrapes the sidebar |
| YouTuber series, no playlist | Off | Off | Default — owner curates via dashboard |
| Random movie night | Off | On | Freeform |

Most rooms need no toggles at all. Single and freeform are deliberate deviations from the default.

## Why this model holds up

The shift from "two kinds, single and multi" to "one shape, two opt-in toggles" produces a smaller, cleaner model with the same expressiveness:

- **There is no creation-time choice that can't be reversed.** Both toggles can be flipped after the fact. (Flipping single mode on after the playlist has more than one entry should warn the owner — see logical seams.)
- **The default path is always permissive.** Forgetting to set a toggle never blocks legitimate use; at worst it allows behaviour the owner didn't intend, which is recoverable.
- **The protocol has one shape.** Same messages, same payloads, all rooms. Behaviour branches happen on toggle flags, not on a kind discriminator.
- **The schema has one shape.** Every room has a playlist (sometimes of size one) and a cursor. No `IF kind = ...` in the persistence layer.

## Playlist entries

Each playlist entry has:

- A pointer to a specific video (provider, video identifier, page URL).
- A label (scraped, fetched via something like oEmbed, or set by the owner).
- A position in the list (explicit, not implied by numbering).
- Optional series metadata (episode number, season number) when meaningful.
- A source tag — how the entry got added.

### Entry sources

- **Scraped** — added by an extension reporting what it sees on a series-aware page (anime site, YouTube playlist sidebar).
- **Curated** — added explicitly by the owner via the dashboard.
- **Auto-appended** — added by the server when a freeform-mode viewer jumped to a video that wasn't already in the playlist.

The source matters for merge behaviour (curated entries aren't overwritten by scrapes) and for the event log.

Playlists are per-room. They are not shared across rooms. Two friend-groups watching the same anime end up with two independent playlists. This duplicates scraping work, but it makes catalog ownership unambiguous: the room that has the playlist is the only one that can change it.

## Real-world scenarios

**Anime episode sync (Crunchyroll, etc.)**
- Default mode (no toggles).
- Playlist filled by scrapes as clients join the page.
- Cursor moves when a viewer navigates or when the owner picks from the dashboard.
- Stale-tab joiners are steered to the current episode.

**YouTube playlist sync**
- Default mode (no toggles).
- Playlist filled by scrapes — YouTube does model playlists.
- Same behaviour as anime.

**YouTuber's "let's play" across unrelated videos**
- Default mode (no toggles).
- Playlist filled by owner curation (YouTube doesn't formally group these videos).
- Owner pastes each video URL in order with labels.
- Otherwise identical to anime.

**One-shot YouTube video**
- Single mode enabled.
- Playlist has one entry, added at creation.
- Locked — no further changes until single mode is disabled or the room is deleted.

**Movie night / random video hangout**
- Freeform mode enabled.
- Playlist starts empty.
- Anyone can switch to a new video; server auto-appends and broadcasts.
- No mismatch enforcement.

## How JOIN works under this model

A joiner tells the server what their browser tab is currently showing. The server's response depends on the toggles:

- **Default mode**, joiner's video isn't the cursor → steer to the cursor.
- **Default mode**, joiner's video isn't even in the playlist → steer to the cursor.
- **Single mode**, joiner's video isn't the cursor → still steer (the playlist can't grow, so the joiner gets navigated to the only thing the room plays).
- **Freeform mode** → no steer. Joiner's tab is fine; the cursor follows whoever last switched.

There is no fatal mismatch path anymore. Steering is always at least as helpful and never less safe than disconnecting.

## How cursor changes happen

**Default and single mode:**
- A connected viewer's extension reports a navigation to a different entry. Server accepts if the entry exists in the playlist; broadcasts.
- The owner uses the dashboard picker.
- In single mode the playlist is locked, so changes only work if multiple entries already exist (rare, but possible if the owner toggled single mode on after building a playlist).

**Freeform mode:**
- Any viewer can switch to any video. Server auto-appends if the target isn't already in the playlist, then broadcasts.

The cursor change is persisted so reconnecting clients see the right entry immediately.

## Where things live (mental map)

- **Per room, persisted**: playlist, current cursor, single-mode flag, freeform-mode flag, room metadata (name, owner, password hash, expiry). Survives a backend restart.
- **Per room, ephemeral**: playback state (playing/paused, position), connected clients, live event log. In memory only; re-established on reconnect.
- **Shared across rooms**: nothing.

## Logical seams worth revisiting

1. **Catalog source conflicts.** Two clients scrape slightly different episode lists. Take the union. Metadata conflicts resolved most-recent-wins. Curated overrides flagged so re-scrapes don't blow them away.

2. **Catalog provenance and trust.** Playlist contents come from clients. A buggy or malicious extension can inject entries. Acceptable for a friend-group product; worth naming explicitly.

3. **Stale entries.** A site removed an episode or moved it to a new URL. Don't delete entries — mark them with a "last seen" timestamp and let the picker dim them.

4. **Toggling single mode on a multi-entry playlist.** Allow it, but warn the owner. The lock takes effect immediately; existing entries remain, the cursor can still move between them, no new entries can be added until single mode is turned off again.

5. **Toggling freeform mode mid-room.** Allow it freely. Going from default to freeform relaxes mismatch handling. Going back to default tightens it (next stale joiner gets steered).

6. **Auto-append safety in freeform mode.** Anyone can append by viewing a new video. Reasonable defaults: cap on playlist size, owner can clear, oldest auto-appended entries pruned first when the cap is reached.

7. **Empty playlists.** A default-mode room with no scraping yet and no owner curation: the first joiner's `currentlyShowing` seeds the playlist with one entry and sets the cursor.

8. **Cross-provider playlists.** A curated playlist could mix YouTube + Vimeo + anime + whatever. Logically supported, but probably weird UX. Default to one provider per playlist; allow mixing only via an explicit setting if anyone asks.

9. **The bootstrap URL for share links.** Set at room creation. For single-mode rooms, it's the one video's URL. For default-mode rooms, it's whatever the owner pasted (typically the series landing page). For freeform rooms, it's typically the current cursor URL or a "join page." Whether it auto-updates with the cursor (for freeform especially) is a UX choice — but the data model supports either.

## Summary

Every room is a **playlist with a cursor**. The default behaviour treats the playlist as an ordered sequence of episodes/videos, with the cursor moving between existing entries and mismatched joiners being steered to the cursor.

Two opt-in toggles modify the default:

- **Single mode** locks the playlist (used for one-shot videos or finalized series).
- **Freeform mode** relaxes cursor and mismatch handling (used for random-video rooms).

They are mutually exclusive. Both default off.

There is no separate "kind" discriminator. The room shape is uniform; differences come from toggles. The default path is always permissive, so an owner who doesn't touch the toggles gets a room that does whatever it's asked.
