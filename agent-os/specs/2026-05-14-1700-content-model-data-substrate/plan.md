# PlaybackSync — Content Model Data Substrate

## Context

Today, a room's content identity is a single opaque fingerprint — three flat strings (`providerId`, `episodeId`, `pageUrl`) hashed into one `contentKey`, held only in daemon memory ([lib/WebSocket/ContentIdentity.php](../../../lib/WebSocket/ContentIdentity.php)). The persisted `playbacksync_rooms` table carries identity, ownership, and TTL — but no catalog, no cursor, no per-room mode. This conflates "what the room *can* play" with "what it *is* playing" and forces every dashboard/protocol/persistence question into one slot it can't actually serve.

[CONTENT_MODEL_DATA.md](../../../CONTENT_MODEL_DATA.md) defines the replacement: every room is a **playlist with a cursor**, plus two independent boolean toggles (`singleMode`, `freeformMode`) controlling mutation and steering behaviour. The data substrate is shared across all room types — wire-protocol and per-mode UX live in sibling specs ([PROTOCOL](../../../CONTENT_MODEL_PROTOCOL.md), [DEFAULT](../../../CONTENT_MODEL_DEFAULT.md), [SINGLE](../../../CONTENT_MODEL_SINGLE.md), [FREEFORM](../../../CONTENT_MODEL_FREEFORM.md)) and are explicitly **out of scope** for this spec.

This spec covers the persistence layer only: the new DB shape, the Entity/Mapper, the server-side merge rules, stale-entry tracking, the catalog growth caps, the persistence boundary between DB and daemon runtime, and the frontend type updates to consume the new room shape. The project is pre-launch — we drop the existing schema and rebuild without a migration path.

Outcome: a daemon restart no longer loses "what we were watching." Late joiners learn the current entry from persisted state even if no other client is connected. The catalog merge logic has one home (the service layer) and one natural key (`(providerId, videoId)`).

---

## Decisions

- **Persistence shape:** Playlist stored as a **JSON column** on `playbacksync_rooms`, not a separate normalized table. Cursor is a string field (`cursor_entry_id`) referencing an `entryId` inside the JSON blob — referential integrity is enforced at the service layer, not the DB. Tradeoff: every `lastSeenAt` refresh rewrites the full blob; mitigated by the 1000-entry cap, infrequent scrape cadence, and the daemon batching writes. Documented in `shape.md` so a future normalization spec has the context.
- **Migration strategy:** **Drop and recreate.** Pre-launch project, no real users. We don't add columns to `Version0001…`; instead we add a `Version0002…` migration that drops `playbacksync_rooms` and recreates it with the new shape.
- **Column rename:** Existing `target_url` becomes `bootstrap_url` (matches CONTENT_MODEL_DATA terminology, distinguishes the share-link redirect target from per-entry `pageUrl`).
- **Position:** Integer `position` field inside each playlist entry; server renumbers on insert/reorder. `ORDER BY position` within JSON serialization. The 1000-entry cap makes full renumber on reorder acceptable.
- **Merge atomicity:** All playlist mutations go through a single `PlaylistService` method that wraps a `SELECT … FOR UPDATE` + write in one DB transaction, preventing two concurrent `PLAYLIST_UPDATE` writers from clobbering each other on the JSON blob.
- **Toggle mutual exclusion:** Enforced at the service boundary (creation + toggle endpoint). Returns a domain exception that maps to `toggle_conflict` in the protocol layer — that mapping is the protocol spec's problem.
- **`entryId` format:** Server-assigned, opaque, stable. Use `e_` + 16 hex chars (e.g. `e_a3f5b2…`). Unique per room, not globally.
- **`bootstrap_url` auto-update for freeform:** Out of scope here — purely a UX choice, captured in CONTENT_MODEL.md §9. The data model supports either; this spec stores whatever the dashboard/owner sends.
- **Playback position persistence:** Still ephemeral. Throttled writes for "resume where we left off" are a future spec.
- **Frontend type rewrite:** [src/types/room.ts](../../../src/types/room.ts) loses `contentIdentity`/`ContentIdentity` and gains `Room.playlist`, `Room.cursorEntryId`, `Room.singleMode`, `Room.freeformMode`, plus a new `PlaylistEntry` type. The Pinia store gets new actions in a later spec; this one only ships the type and a server-side hydration path so the existing dashboard keeps loading without crashing.

---

## Critical files

### To create

**Backend (PHP):**
- `lib/Migration/Version0002Date20260514XXXX.php` — drop `playbacksync_rooms`, recreate with new columns. Pattern mirrors [Version0001Date20260509120000.php](../../../lib/Migration/Version0001Date20260509120000.php).
- `lib/Db/PlaylistEntry.php` — **value object** (not an Entity), constructed from / serialized to the JSON blob. Holds `entryId`, `position`, `providerId`, `videoId`, `pageUrl`, `label`, `episodeNumber`, `seasonNumber`, `source` (enum: `scraped`|`curated`|`auto_appended`), `addedBy`, `addedAt`, `lastSeenAt`.
- `lib/Service/PlaylistService.php` — domain logic: merge, append, reorder, remove, refresh `lastSeenAt`, promote `auto_appended` → `curated`. Transactional via `IDBConnection::beginTransaction()`.
- `lib/Service/Exceptions/PlaylistLockedException.php` — thrown when `singleMode=true` and a mutation is attempted (maps to `single_mode_locked` at the wire layer).
- `lib/Service/Exceptions/ToggleConflictException.php` — thrown on `singleMode=true && freeformMode=true`.
- `lib/Service/Exceptions/PlaylistCapExceededException.php` — thrown when adding entries would exceed the 1000-entry cap (maps to `playlist_cap_exceeded`).
- `lib/Service/Exceptions/CursorEntryNotFoundException.php` — thrown when a cursor change references an unknown `entryId`.

**Frontend (TypeScript):**
- *(none — existing files modified, see below)*

### To modify

**Backend (PHP):**
- [lib/Db/Room.php](../../../lib/Db/Room.php) — drop `targetUrl`, add `bootstrapUrl` (renamed), `singleMode` (bool), `freeformMode` (bool), `playlist` (string holding JSON; deserialize via accessor), `cursorEntryId` (string, nullable). PHPDoc method hints updated.
- [lib/Db/RoomMapper.php](../../../lib/Db/RoomMapper.php) — no schema-level changes needed; the JSON column is opaque to the mapper. Add a helper `lockRoomForUpdate(string $uuid): Room` that wraps a `SELECT … FOR UPDATE` for use by `PlaylistService`.
- [lib/Service/RoomService.php](../../../lib/Service/RoomService.php) — `createRoom()` accepts `singleMode`, `freeformMode`, optional `initialEntries[]`, `bootstrapUrl`. Calls `assertTogglesNotConflicting()`. Initial entries (curated) seeded via `PlaylistService` inside the same transaction.
- [lib/WebSocket/RoomRegistry.php](../../../lib/WebSocket/RoomRegistry.php) and [lib/WebSocket/RoomRuntime.php](../../../lib/WebSocket/RoomRuntime.php) — hydrate playlist + cursor from DB on JOIN; expose them on `RoomRuntime` for handlers to read.
- [lib/WebSocket/ContentIdentity.php](../../../lib/WebSocket/ContentIdentity.php) — **delete.** Replaced by `PlaylistEntry` + cursor reference. Any handler referencing `ContentIdentity` needs updating (search call sites in Step 2).
- [lib/WebSocket/Handler/JoinHandler.php](../../../lib/WebSocket/Handler/JoinHandler.php) and [EpisodeChangeHandler.php](../../../lib/WebSocket/Handler/EpisodeChangeHandler.php) — adapter shims only. Renaming `EPISODE_CHANGE` → `CURSOR_CHANGE` and adding `PLAYLIST_UPDATE` is the protocol spec's job; here, just make sure the handlers compile against the new `RoomRuntime` shape (drop `ContentIdentity` references). Steering / merge logic itself stays in the protocol spec.
- [appinfo/info.xml](../../../appinfo/info.xml) — bump app version.

**Frontend (Vue 3 + Pinia + TypeScript):**
- [src/types/room.ts](../../../src/types/room.ts) — replace `ContentIdentity` with `PlaylistEntry`; add `Room.playlist: PlaylistEntry[]`, `Room.cursorEntryId: string | null`, `Room.singleMode: boolean`, `Room.freeformMode: boolean`, `Room.bootstrapUrl` (renamed from `targetUrl`). `RoomLiveState.contentIdentity` is removed; live state shrinks to `connectedCount`, `clients`, `playerState`, `videoPos`, `lastActivityMs`.
- [src/stores/rooms.ts](../../../src/stores/rooms.ts) — rename `targetUrl` → `bootstrapUrl` in any payload-building code; no new actions yet (dashboard interactions land in protocol/UX specs).
- [src/services/roomsApi.ts](../../../src/services/roomsApi.ts) — same rename; ensure the create payload type matches the new backend shape.
- Any Vue component referencing `targetUrl` or `contentIdentity` — rename / drop. Grep `src/` in Step 2 to enumerate.

---

## DB schema (`oc_playbacksync_rooms`, recreated)

| Column | Type | Notes |
|---|---|---|
| `id` | BIGINT autoinc PK | |
| `uuid` | string(36), unique | external identifier |
| `owner_user_id` | string(64), indexed | Nextcloud uid |
| `name` | string(100), nullable | |
| `bootstrap_url` | text, notnull | renamed from `target_url` |
| `password_hash` | string(255) | |
| `single_mode` | boolean, default false | |
| `freeform_mode` | boolean, default false | |
| `playlist` | clob (longtext), notnull, default `'[]'` | JSON-serialized `PlaylistEntry[]` |
| `cursor_entry_id` | string(64), nullable | `entryId` of current playlist entry, or null if playlist empty |
| `created_at` | BIGINT | |
| `expires_at` | BIGINT, indexed | |

Indexes (unchanged from Version0001): `uuid` unique; `owner_user_id`; `expires_at`. No index on `playlist` contents — queries against it are O(playlist size) in PHP after a single-row read, and the per-room cap is 1000 entries.

CHECK constraint not portable across all supported DBs; toggle mutual exclusion enforced in the service layer.

---

## Playlist entry shape (JSON-serialized inside `playlist` column)

```json
{
  "entryId": "e_a3f5b2c1d4e6f708",
  "position": 1,
  "providerId": "crunchyroll",
  "videoId": "frieren-s01e01",
  "pageUrl": "https://www.crunchyroll.com/watch/…",
  "label": "Episode 1 — The Journey's End",
  "episodeNumber": 1,
  "seasonNumber": 1,
  "source": "scraped",
  "addedBy": "client_a83b…",
  "addedAt": 1747201023,
  "lastSeenAt": 1747204500
}
```

Optional fields (`episodeNumber`, `seasonNumber`, `label`) may be `null`. `source` is one of `scraped`, `curated`, `auto_appended`. `addedAt` and `lastSeenAt` are unix seconds (consistent with `created_at` / `expires_at`).

---

## Merge rules (server-side, inside `PlaylistService::merge`)

1. Natural key: `(providerId, videoId)` scoped to the room.
2. **New key** → insert with caller-declared `source`, server-assigned `entryId`, server-assigned `position` (append).
3. **Existing key**:
   - If existing `source === "curated"` → only `lastSeenAt` is refreshed. `label`, `episodeNumber`, `seasonNumber` are **not** overwritten.
   - Else → most-recent scraped value wins on `label`, `episodeNumber`, `seasonNumber`. `lastSeenAt` refreshed.
4. `lastSeenAt` is refreshed on every report regardless of source.
5. Promotion: `PlaylistService::promoteToCurated(uuid, entryId, ?label)` flips `source` to `curated` and optionally overwrites `label`. Future scrapes of that entry only touch `lastSeenAt` per rule 3.
6. Stale entries are **never** auto-deleted by the merge path. They simply stop having their `lastSeenAt` refreshed. Removal is owner-driven (dashboard) or, for freeform `auto_appended` entries, by an auto-prune policy that belongs to the FREEFORM spec.

---

## Catalog growth caps

Enforced inside `PlaylistService` on every mutation that grows the playlist:

- Per-message cap: a single merge call receiving > 200 candidate entries returns `PlaylistCapExceededException` with code `per_message_cap`.
- Per-room cap: a merge that would push the playlist past 1000 entries returns `PlaylistCapExceededException` with code `playlist_cap_exceeded`. The whole call rolls back — partial inserts up to the cap are *not* a feature; callers must trim before retry.
- Rate-limiting `PLAYLIST_UPDATE` per connection is the protocol spec's job.

---

## Persistence boundary

| Lives in | What |
|---|---|
| DB (`playbacksync_rooms`) | `single_mode`, `freeform_mode`, `playlist` JSON, `cursor_entry_id`, room metadata (`name`, `owner_user_id`, `password_hash`, `expires_at`, `bootstrap_url`) |
| Daemon memory (`RoomRuntime`) | playback state (`playerState`, `videoPos`, `eventId`), connected client list, in-flight event log ring buffer. Plus an in-memory **cache** of the persisted playlist + cursor, refreshed on JOIN and after every successful service-layer write. |
| Nowhere shared | catalog metadata across rooms — each room owns its own |

Daemon restarts hydrate playlist + cursor from DB on next JOIN. Playback state remains ephemeral.

---

## Reused patterns / utilities

- **Entity + Mapper:** existing [Room.php](../../../lib/Db/Room.php) / [RoomMapper.php](../../../lib/Db/RoomMapper.php) pattern continues; we add an accessor for the JSON column (deserialize on read, serialize on write) so callers see `PlaylistEntry[]`.
- **Migration:** mirrors [Version0001Date20260509120000.php](../../../lib/Migration/Version0001Date20260509120000.php). Uses `$schema->dropTable('playbacksync_rooms')` + `createTable(…)`.
- **Transactional service:** existing [RoomService.php](../../../lib/Service/RoomService.php) already injects `IDBConnection` patterns from the room-creation spec; reuse the same approach for `PlaylistService`.
- **Domain exceptions:** mirror existing `lib/Service/Exceptions/` structure (RoomNotFound, RoomAccessDenied, CreateRestricted).
- **Cryptographically random `entryId`:** `bin2hex(random_bytes(8))` → 16 hex chars, prefixed `e_`.

---

## Standards applied

- **backend/php-conventions** — `declare(strict_types=1)`, `OCP\` imports only, real PHPDoc with descriptions, no SPDX headers.
- (Frontend changes are tiny — type renames and prop renames — so vue-conventions applies but is mostly trivial.)

---

## Tasks

### Task 1 — Save spec documentation

Create `agent-os/specs/2026-05-14-1700-content-model-data-substrate/` with:
- `plan.md` — copy of this plan
- `shape.md` — scope, decisions (especially the JSON-column tradeoff and pre-launch drop-and-recreate choice), Q&A context from this session
- `standards.md` — full content of `agent-os/standards/backend/php-conventions.md`
- `references.md` — pointers to [CONTENT_MODEL.md](../../../CONTENT_MODEL.md), [CONTENT_MODEL_DATA.md](../../../CONTENT_MODEL_DATA.md), [CONTENT_MODEL_TECHNICAL.md](../../../CONTENT_MODEL_TECHNICAL.md), and the room-creation spec ([agent-os/specs/2026-05-09-1430-room-creation-management/plan.md](../2026-05-09-1430-room-creation-management/plan.md)) as the architectural template
- `visuals/` — empty (data-layer spec, no UI)

### Task 2 — Audit `ContentIdentity` call sites

Grep `lib/WebSocket/` and `src/` for `ContentIdentity`, `contentIdentity`, `contentKey`, `targetUrl`. Produce a working list of files to update in Tasks 5–7. Verify nothing in the dashboard depends on `contentIdentity` for rendering — if it does, plan the shim.

### Task 3 — Migration

Create `lib/Migration/Version0002Date20260514XXXX.php`:
1. If `playbacksync_rooms` exists, `dropTable('playbacksync_rooms')`.
2. Recreate with the new schema (all columns from the table above).
3. Re-add the three indexes (`uuid` unique, `owner_user_id`, `expires_at`).
4. Set `playlist` default to `'[]'`, `cursor_entry_id` default to null, both toggles default to `false`.

### Task 4 — Entity, value object, mapper

1. Rewrite `lib/Db/Room.php`:
   - Drop `targetUrl` property; add `bootstrapUrl`, `singleMode`, `freeformMode`, `cursorEntryId`.
   - Add a private `playlist` string field (raw JSON) + accessors `getPlaylistEntries(): PlaylistEntry[]` / `setPlaylistEntries(array $entries)` that serialize via `json_encode` / `json_decode`.
   - Update `addType()` calls.
   - Update PHPDoc method hints.
2. Create `lib/Db/PlaylistEntry.php`:
   - Plain value object with constructor + getters; `fromArray(array): self` and `toArray(): array` for JSON round-trip.
   - Constants for `SOURCE_SCRAPED`, `SOURCE_CURATED`, `SOURCE_AUTO_APPENDED`.
3. Modify `lib/Db/RoomMapper.php`: add `lockRoomForUpdate(string $uuid): Room` using `SELECT … FOR UPDATE` semantics.

### Task 5 — `PlaylistService`

Create `lib/Service/PlaylistService.php` with methods (all transactional via `IDBConnection->beginTransaction()` + `commit`/`rollBack`):
- `merge(string $roomUuid, array $candidates, string $defaultSource): PlaylistEntry[]` — per the merge rules above. Throws `PlaylistLockedException` if `singleMode`, `PlaylistCapExceededException` on cap violations. Returns the merged set so the caller can broadcast.
- `autoAppend(string $roomUuid, array $entryShape, string $clientId): PlaylistEntry` — only for freeform; throws `PlaylistLockedException` otherwise. (Called from the cursor-change path in the protocol spec.)
- `setCursor(string $roomUuid, string $entryId): void` — verifies entry exists, updates `cursor_entry_id`. Throws `CursorEntryNotFoundException`.
- `removeEntry(string $roomUuid, string $entryId): void` — disallowed if `singleMode`, disallowed if entry is current cursor (caller advances first).
- `reorderEntries(string $roomUuid, string[] $entryIdsInOrder): void` — disallowed if `singleMode`; renumbers `position` 1..N.
- `promoteToCurated(string $roomUuid, string $entryId, ?string $label): void`.
- `refreshLastSeenAt(string $roomUuid, array $entryRefs, int $now): void` — bulk update of `lastSeenAt` only, used when scrape reports an already-curated entry.

### Task 6 — `RoomService` updates

- `createRoom(...)` accepts `singleMode`, `freeformMode`, `bootstrapUrl`, optional `initialEntries[]`. Asserts `!(singleMode && freeformMode)` → `ToggleConflictException`. Seeds initial entries (curated source) via `PlaylistService::merge()` in the same transaction.
- `setToggles(string $roomUuid, ?bool $single, ?bool $freeform): void` — re-asserts mutual exclusion; persists.
- Update the existing `targetUrl` references to `bootstrapUrl`.

### Task 7 — Daemon hydration

1. Delete [lib/WebSocket/ContentIdentity.php](../../../lib/WebSocket/ContentIdentity.php).
2. Update [RoomRegistry.php](../../../lib/WebSocket/RoomRegistry.php) so the hydration path that runs on first JOIN reads `playlist` + `cursor_entry_id` from the Room entity and attaches them to `RoomRuntime`.
3. Update [RoomRuntime.php](../../../lib/WebSocket/RoomRuntime.php): replace `contentIdentity` field with `playlist: PlaylistEntry[]` and `cursorEntryId: ?string`. Add `refreshPlaylistFromDb(...)` for callers that just wrote to DB.
4. Adapt [JoinHandler.php](../../../lib/WebSocket/Handler/JoinHandler.php) and [EpisodeChangeHandler.php](../../../lib/WebSocket/Handler/EpisodeChangeHandler.php) to compile against the new `RoomRuntime` shape. Wire-protocol changes (rename, payload shape, steering decisions) are explicitly NOT in this spec — leave existing message names in place, ship a non-functional shim if needed. The protocol spec replaces them later.

### Task 8 — Frontend type updates

1. Rewrite [src/types/room.ts](../../../src/types/room.ts):
   - Drop `ContentIdentity` interface and `RoomLiveState.contentIdentity`.
   - Add `PlaylistEntry` interface mirroring the JSON shape above.
   - Rename `Room.targetUrl` → `Room.bootstrapUrl`. Add `playlist`, `cursorEntryId`, `singleMode`, `freeformMode`.
2. Update [src/stores/rooms.ts](../../../src/stores/rooms.ts) and [src/services/roomsApi.ts](../../../src/services/roomsApi.ts) — rename, ensure compilation.
3. Grep `src/` for any component using `contentIdentity` or `targetUrl`; rename / remove.
4. No new dashboard UI in this spec — the existing room-list and live-state widgets continue to work after the type rename. The playlist/cursor display is a UX-spec deliverable.

### Task 9 — Manual end-to-end verification

Run inside the Nextcloud Docker workspace:

1. `npm run build` inside the app dir — frontend compiles after the type rename.
2. `docker exec -u www-data master-nextcloud-1 sh -c "cd /var/www/html/apps-extra/playbacksync && phpunit"` — existing tests pass (per the project's PHP testing memory).
3. `occ app:disable playbacksync && occ app:enable playbacksync` — Version0002 migration runs without error; verify with `occ db:execute "DESCRIBE oc_playbacksync_rooms"` (or vendor-specific equivalent) that all new columns and the rename are present.
4. **Create a room** via the existing dashboard with the (newly added) defaults — both toggles `false`, empty playlist, null cursor. Verify the row contains `playlist = '[]'` and `cursor_entry_id IS NULL`.
5. **Toggle conflict** — programmatically (`occ playbacksync:debug:set-toggles <uuid> --single --freeform`, or via a temporary CLI) — confirm `ToggleConflictException` raised, room unchanged.
6. **Seeded curated entries** — create a room with one `initialEntries[]` curated entry. Verify the JSON blob shape, `cursor_entry_id` is null (no auto-cursor on creation), `addedAt` and `lastSeenAt` set.
7. **Merge — new + existing keys** — programmatically call `PlaylistService::merge` with one fresh `(provider, video)` and one already-present curated `(provider, video)` with a different label. Confirm: new key inserted with assigned position; curated entry's `label` unchanged; both `lastSeenAt` refreshed.
8. **Caps** — call `merge` with 201 candidates → `per_message_cap`. Insert until just under 1000, then call with enough to overflow → `playlist_cap_exceeded`; verify the entire call rolled back.
9. **Cursor set** — set the cursor to a valid `entryId`, then to an invalid one (`CursorEntryNotFoundException`).
10. **Daemon restart hydration** — kill and restart `start-ws-server`; confirm a new JOIN sees the persisted playlist and cursor (log/debug output).

---

## Out of scope (explicitly deferred)

- Wire protocol changes (`EPISODE_CHANGE` → `CURSOR_CHANGE`, `PLAYLIST_UPDATE`, `ROOM_STATE`, steering decisions). Lives in CONTENT_MODEL_PROTOCOL spec.
- Per-mode behaviour (default-mode steering, freeform auto-prune cadence, single-mode controller surface). Lives in CONTENT_MODEL_DEFAULT / SINGLE / FREEFORM specs.
- Dashboard playlist UI, picker, reorder controls, "convert to curated" button.
- HTTP endpoints for playlist CRUD from the dashboard (e.g. `POST /rooms/{uuid}/playlist/entries`). Service exists; controllers come with the UX specs.
- Throttled writes of `playerState` / `videoPos` for resume-where-we-left-off.
- Tests for `PlaylistService` (no PHPUnit suite for the WebSocket layer yet; introduce alongside the protocol spec).
