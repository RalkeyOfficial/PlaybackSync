# References for Content Model Data Substrate

## Source documents

These define the model this spec implements. Read these first if you need context.

### CONTENT_MODEL_DATA.md (authoritative)

- **Location:** [CONTENT_MODEL_DATA.md](../../../CONTENT_MODEL_DATA.md)
- **Relevance:** The canonical source for everything in this spec. Defines the room shape, playlist entry shape, merge rules, stale-entry semantics, catalog growth caps, and persistence boundary.
- **Key patterns:** Playlist + cursor + toggles substrate. `(providerId, videoId)` as natural key. Source priority (`curated` > `scraped`, with `auto_appended` as the freeform default). `lastSeenAt` refresh on every report.

### CONTENT_MODEL.md (logical overview)

- **Location:** [CONTENT_MODEL.md](../../../CONTENT_MODEL.md)
- **Relevance:** Non-technical overview of why the model exists. Useful for understanding the "why this shape holds up" argument and the use-case matrix.
- **Key patterns:** No `kind` discriminator. Toggles modify behaviour, not data structure. Default mode is permissive; toggles are opt-in deviations.

### CONTENT_MODEL_TECHNICAL.md (illustrative shapes & scenarios)

- **Location:** [CONTENT_MODEL_TECHNICAL.md](../../../CONTENT_MODEL_TECHNICAL.md)
- **Relevance:** Concrete JSON examples and scenario walkthroughs (one-shot YouTube, anime series, YouTube playlist, curated YouTuber series, freeform movie night). The JSON shapes are illustrative — when this spec disagrees with the technical doc on a field name, **this spec wins** (the data spec is more recent).
- **Key patterns:** End-to-end scenarios showing how `JOIN`, `CURSOR_CHANGE`, `PLAYLIST_UPDATE` interact with the data substrate (the wire frames themselves belong to the protocol spec).

## Sibling specs (out of scope for this spec, but relevant context)

- [CONTENT_MODEL_PROTOCOL.md](../../../CONTENT_MODEL_PROTOCOL.md) — wire-level message shapes. This spec must leave the protocol intact (handlers compile, but rename / payload changes happen there).
- [CONTENT_MODEL_DEFAULT.md](../../../CONTENT_MODEL_DEFAULT.md) — default-mode behaviour (steering, mismatch handling).
- [CONTENT_MODEL_SINGLE.md](../../../CONTENT_MODEL_SINGLE.md) — single-mode lock semantics and dashboard controls.
- [CONTENT_MODEL_FREEFORM.md](../../../CONTENT_MODEL_FREEFORM.md) — freeform mode, auto-prune policy, polite-follow vs eager-append.

## Architectural template

### Room Creation & Management (MVP) spec

- **Location:** [agent-os/specs/2026-05-09-1430-room-creation-management/plan.md](../2026-05-09-1430-room-creation-management/plan.md)
- **Relevance:** This spec established the Entity / Mapper / Service / Migration / TimedJob pattern for the app. Reuse:
  - Migration file naming + structure (`Version0001Date20260509120000.php` style)
  - `Entity` with explicit `addType()` and PHPDoc `@method` hints
  - Service-layer pattern: domain exceptions under `lib/Service/Exceptions/`, services injected with `IDBConnection`, transactional writes
  - Frontend pattern: typed Pinia store, `roomsApi.ts` axios wrapper, `src/types/room.ts` interfaces
- **Key patterns:** `IHasher` for password handling (untouched here); UUID generation; expiry handling via `expires_at` BIGINT.

## Concrete code references in this codebase

| File | Purpose |
|---|---|
| [lib/Migration/Version0001Date20260509120000.php](../../../lib/Migration/Version0001Date20260509120000.php) | Template for `Version0002…` (drop + recreate `playbacksync_rooms`) |
| [lib/Db/Room.php](../../../lib/Db/Room.php) | Entity to rewrite — drop `targetUrl`, add toggle / cursor / playlist fields |
| [lib/Db/RoomMapper.php](../../../lib/Db/RoomMapper.php) | Add `lockRoomForUpdate(string $uuid): Room` |
| [lib/Service/RoomService.php](../../../lib/Service/RoomService.php) | Existing `createRoom`, `getOwnedRoom`, etc. — extend for toggles + initial entries |
| [lib/WebSocket/RoomRegistry.php](../../../lib/WebSocket/RoomRegistry.php) | Daemon hydration entry point |
| [lib/WebSocket/RoomRuntime.php](../../../lib/WebSocket/RoomRuntime.php) | Per-room runtime state — drop `contentIdentity`, add `playlist` cache |
| [lib/WebSocket/ContentIdentity.php](../../../lib/WebSocket/ContentIdentity.php) | **Delete.** Replaced by `PlaylistEntry` + `cursorEntryId` |
| [lib/WebSocket/Handler/JoinHandler.php](../../../lib/WebSocket/Handler/JoinHandler.php) | Adapter shim — compile-only updates |
| [lib/WebSocket/Handler/EpisodeChangeHandler.php](../../../lib/WebSocket/Handler/EpisodeChangeHandler.php) | Adapter shim — compile-only updates |
| [src/types/room.ts](../../../src/types/room.ts) | Rewrite — drop `ContentIdentity`, add `PlaylistEntry` + new `Room` fields |
| [src/stores/rooms.ts](../../../src/stores/rooms.ts) | Rename `targetUrl` → `bootstrapUrl` |
| [src/services/roomsApi.ts](../../../src/services/roomsApi.ts) | Rename `targetUrl` → `bootstrapUrl` |

## External / archived

- `OLD_CODE/docs/unified_v1_backend_and_network_design.md` — Highest-authority archived design doc from the Node.js era. Useful only for historical context; this spec supersedes the data-model parts.
