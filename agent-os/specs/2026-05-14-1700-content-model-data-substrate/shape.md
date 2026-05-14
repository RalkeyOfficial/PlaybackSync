# Content Model Data Substrate — Shaping Notes

## Scope

Replace today's single-fingerprint content identity (`providerId` + `episodeId` + `pageUrl` hashed into one `contentKey`, daemon-memory only) with the **playlist + cursor + toggles** persistence model defined in [CONTENT_MODEL_DATA.md](../../../CONTENT_MODEL_DATA.md).

This spec covers the **data substrate only**:

- DB schema (drop and recreate `playbacksync_rooms`)
- `Room` entity + `PlaylistEntry` value object
- `RoomMapper` lock helper
- `PlaylistService` — merge rules, cursor mutation, caps, source-priority logic, transactional writes
- `RoomService` updates for toggles, `bootstrapUrl`, `initialEntries`
- Daemon hydration on JOIN (replace `ContentIdentity` with `playlist` + `cursorEntryId` on `RoomRuntime`)
- Frontend type rewrite (`Room`, drop `ContentIdentity`, add `PlaylistEntry`)

Explicitly NOT covered: wire-protocol message renames (CONTENT_MODEL_PROTOCOL), per-mode behaviour and UX (CONTENT_MODEL_DEFAULT / SINGLE / FREEFORM), dashboard playlist UI, HTTP endpoints for playlist CRUD.

## Decisions

### Data shape

- **Playlist as JSON column on `playbacksync_rooms`**, not a separate normalized table. User-confirmed choice over the normalized-table recommendation.
  - Tradeoff: every `lastSeenAt` refresh rewrites the whole blob; no per-entry indexing; cursor referential integrity must be enforced in service code.
  - Upside: one row read per JOIN, one row write per mutation, no JOIN needed for hydration, simpler Mapper surface.
  - Mitigations: 1000-entry per-room cap; concurrent writes serialized by `SELECT … FOR UPDATE`; daemon caches the deserialized list so repeated reads don't deserialize.
  - **Future spec** can promote to a separate `playbacksync_playlist_entries` table if scale demands. `shape.md` captures the rationale so that migration has context.

- **Cursor as `cursor_entry_id` string column**, referencing an `entryId` inside the JSON. Nullable when the playlist is empty.

- **Toggles as two boolean columns** (`single_mode`, `freeform_mode`). CHECK-constraint for mutual exclusion isn't portable across DBs, so enforcement lives in `RoomService` / `PlaylistService`.

- **`bootstrap_url` replaces `target_url`** — terminology aligns with CONTENT_MODEL_DATA and distinguishes the share-link redirect target from per-entry `pageUrl`. Pre-launch project means no migration needed.

- **`position` is a server-managed integer field** inside each JSON entry. Full renumber on reorder is acceptable at the 1000-entry cap.

- **`entryId` format:** `e_` + 16 hex chars (8 random bytes). Unique per room, opaque to clients.

### Migration strategy

- **Drop and recreate.** Pre-launch project — no real users, no data to preserve. `Version0002…` migration drops `playbacksync_rooms` and creates it fresh with the new schema. We don't bother layering ALTER TABLE statements on top of Version0001.

### Caps

- 200 candidate entries per `merge()` call → `per_message_cap`.
- 1000 entries per room → `playlist_cap_exceeded`; whole call rolls back.
- Connection-level rate-limiting is the protocol spec's job (this spec has no protocol surface).

### Merge rules

- Natural key: `(providerId, videoId)` per room.
- `curated` source is sticky: scrapes refresh `lastSeenAt` only; metadata is preserved.
- For non-curated entries, most-recent scraped value wins on `label` / `episodeNumber` / `seasonNumber`.
- `promoteToCurated()` flips an existing entry's source and protects it from future overwrites.
- Stale entries are never auto-deleted by the merge path. The freeform spec defines the auto-prune policy for `auto_appended` entries.

### Daemon boundary

- DB is the source of truth for playlist + cursor + toggles + room metadata.
- Daemon `RoomRuntime` keeps an in-memory cache, refreshed on JOIN and after every service-layer write.
- Playback state (`playerState`, `videoPos`) stays ephemeral. Resume-where-we-left-off persistence is deferred.

### Frontend type rewrite

- `Room.targetUrl` → `Room.bootstrapUrl`.
- New: `Room.singleMode`, `Room.freeformMode`, `Room.playlist: PlaylistEntry[]`, `Room.cursorEntryId: string | null`.
- `RoomLiveState.contentIdentity` removed entirely. Live state shrinks to playback + connected clients.
- No new Pinia actions in this spec — protocol/UX specs add them. Just enough renaming to keep the existing dashboard compiling.

## Context

- **Visuals:** None — data-layer spec, no UI changes.
- **References:** [CONTENT_MODEL.md](../../../CONTENT_MODEL.md) (logical overview), [CONTENT_MODEL_DATA.md](../../../CONTENT_MODEL_DATA.md) (the authoritative source for this spec), [CONTENT_MODEL_TECHNICAL.md](../../../CONTENT_MODEL_TECHNICAL.md) (illustrative JSON shapes and scenario walkthroughs), [room-creation spec](../2026-05-09-1430-room-creation-management/plan.md) (architectural template for migration / Entity / Mapper / Service patterns).
- **Product alignment:** Aligns with [mission.md](../../product/mission.md) (decentralized watch-party for self-hosted Nextcloud groups) and [roadmap.md](../../product/roadmap.md) Phase 1 (room management + WebSocket sync). Per [tech-stack.md](../../product/tech-stack.md) the room state previously lived "in memory only"; this spec is the explicit shift to DB-backed catalog and cursor.

## Standards applied

- `backend/php-conventions` — `declare(strict_types=1)`, only `OCP\` imports, real PHPDoc with descriptions, no SPDX headers. Used in every new/modified PHP file.

## Q&A context (from shaping session)

1. **Scope** — full data substrate (not a partial slice).
2. **Migration** — drop existing, no migration (pre-launch).
3. **Playlist storage** — JSON column on rooms (chosen against the normalized-table recommendation; rationale and tradeoffs captured above).
4. **Bootstrap URL** — rename `target_url` → `bootstrap_url`.
5. **Ordering** — integer `position`, server-managed.
6. **Visuals** — none.
