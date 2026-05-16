# Content Model — Freeform Mode (auto-prune + curation UI)

## Context

[CONTENT_MODEL_FREEFORM.md](../../../CONTENT_MODEL_FREEFORM.md) describes a per-room "freeform mode" toggle for movie-night-style rooms: any connected client can jump to a brand-new video and the server auto-appends it. The lead docs ([CONTENT_MODEL.md](../../../CONTENT_MODEL.md), [CONTENT_MODEL_TECHNICAL.md](../../../CONTENT_MODEL_TECHNICAL.md)) are the source of truth; the freeform doc must not deviate from them.

A read-only audit confirms most of freeform is **already implemented** by prior specs:

- **Data substrate**: `freeform_mode` column, `Room::$freeformMode`, `SOURCE_AUTO_APPENDED` enum value, `ToggleConflictException` (substrate spec).
- **Protocol — auto-append on cursor change**: `CursorService::resolveAndApply()` at [lib/Service/CursorService.php:99-105](../../../lib/Service/CursorService.php) inserts an `auto_appended` entry and moves the cursor in one transaction; `CursorChangeHandler` broadcasts `PLAYLIST_UPDATE` then `CURSOR_CHANGE` (protocol spec).
- **Protocol — JOIN polite follow**: `JoinHandler::maybeSteer()` at [lib/WebSocket/Handler/JoinHandler.php:217-228](../../../lib/WebSocket/Handler/JoinHandler.php) unconditionally steers mismatched joiners — that *is* polite follow per the freeform doc, and the doc explicitly defers "eager append" until anyone asks (out of scope per shaping).
- **Protocol — empty-playlist seeding**: `JoinHandler::seedFromCurrentlyShowing()` at [JoinHandler.php:182-205](../../../lib/WebSocket/Handler/JoinHandler.php) handles the "first viewer picks a video" path (skips the merge in freeform mode and lets `CursorService` auto-append).
- **Convert auto_appended → curated (backend)**: `PlaylistService::promoteToCurated()` at [PlaylistService.php:331-353](../../../lib/Service/PlaylistService.php) and the more general `updateEntry()` at [PlaylistService.php:369-451](../../../lib/Service/PlaylistService.php) both already enforce "only `→ curated` source transition is valid"; the existing entry-patch HTTP endpoint exposes it.
- **Mode picker (frontend)**: `PlaylistEditor.vue` already has Default/Single/Freeform `NcSelect` wired with mutual-exclusion mapping (single-mode spec).

The genuine gaps relative to the freeform doc are two:

1. **Auto-prune.** [CONTENT_MODEL_FREEFORM.md §Auto-prune](../../../CONTENT_MODEL_FREEFORM.md) requires a freeform cap (default 100, separate from the global `PER_ROOM_CAP = 1000`) that drops the oldest `auto_appended` entries when exceeded. Curated entries and the cursored entry are never auto-dropped. If only curated + cursored remain at the cap, freeform stops accepting auto-appends until the owner clears entries. No prune logic exists today — every auto-append just grows the playlist toward the global 1000 cap.
2. **"Convert to curated" dashboard action.** Backend is ready; no UI surface yet. Owners can't promote an `auto_appended` entry to `curated` from the playlist tab, so the doc's "Erin likes `vid_1`, gives it a custom label, converts to curated" scenario can't be completed end-to-end.

Intended outcome: a freeform room caps its auto-appended growth at 100 entries with the right exemptions; an owner can promote any `auto_appended` entry to `curated` from the existing per-row NcActions menu in one click, protecting it from auto-prune and unlocking label editing.

## Decisions

- **Prune timing**: synchronously inside the existing room-locked transaction in `CursorService::appendEntry()` and `PlaylistService::autoAppend()` / `merge()` (when an insert is happening in a freeform room). No cron, no transient over-cap window.
- **Prune scope**: only `auto_appended` entries are eligible. Curated and (the rare) scraped entries are never dropped by auto-prune. The cursored entry is never dropped regardless of source.
- **Cap value**: default 100, override via Nextcloud app config key `freeform_auto_append_cap`. No per-room knob and no dashboard UI for it (matches the doc's "configurable, default e.g. 100").
- **Over-cap-with-no-eligible-entries**: throw `PlaylistCapExceededException` with a new code `CODE_FREEFORM_CAP` so the caller surfaces "the room is full of curated entries; the owner must clear some" rather than silently accepting unbounded growth. The doc explicitly endorses this: *"the room stops accepting auto-appends until the owner clears entries."*
- **Convert-to-curated UI**: an `NcActionButton` inside the existing per-row `NcActions` in [PlaylistEditor.vue](../../../src/components/PlaylistEditor.vue), conditionally rendered when `entry.source === 'auto_appended'`. Reuses the existing `playlistApi.updateEntry()` call path (no new endpoint).
- **No eager-append sub-setting** (deferred per shaping; the freeform doc says expose only if anyone asks).
- **No bootstrap-URL auto-update on cursor change** (deferred per shaping; the lead doc calls it explicitly a UX choice, not a data-model question).

## Critical files

### Backend
- [lib/Service/PlaylistService.php](../../../lib/Service/PlaylistService.php) — add `pruneAutoAppendedIfOverCap(Room $room, int $cap): void` (private helper, operates on the in-memory entries list inside the existing lock). Drops oldest `auto_appended` entries (lowest `addedAt`, ties broken by lowest `position`) excluding the cursored entry, until either `count(entries) <= cap` or no eligible entries remain. Renumbers `position` to stay contiguous so the dashboard list stays clean. If still over cap after pruning, throws `PlaylistCapExceededException` with the new `CODE_FREEFORM_CAP`. Call sites: `autoAppend()` (after the new entry is added, only if `$room->getFreeformMode()`) and `merge()` (after merging, only if `$room->getFreeformMode()` — merges in freeform rooms are rare but possible via `catalogFragment`; same treatment applies).
- [lib/Service/CursorService.php](../../../lib/Service/CursorService.php) — `appendEntry()` (lines 130-162) currently does the freeform auto-append inline rather than delegating to `PlaylistService::autoAppend()`. Refactor to call a shared helper on `PlaylistService` so prune lives in one place. Inject `PlaylistService` into `CursorService`.
- [lib/Service/Exceptions/PlaylistCapExceededException.php](../../../lib/Service/Exceptions/PlaylistCapExceededException.php) — add `public const CODE_FREEFORM_CAP = 'freeform_cap_full';` next to existing `CODE_PER_MESSAGE` / `CODE_PER_ROOM`. The wire-error mapping in `RoomController` and `CursorChangeHandler` already converts these codes to JSON responses / WS error frames; surface `freeform_cap_full` analogously.
- [lib/WebSocket/Handler/CursorChangeHandler.php](../../../lib/WebSocket/Handler/CursorChangeHandler.php) — confirm the existing `PlaylistCapExceededException` catch surfaces the new `freeform_cap_full` code in the error frame (it should; the exception's `getCode()` is the wire payload). Verify by reading; expect no edit.
- [lib/Controller/RoomController.php](../../../lib/Controller/RoomController.php) — confirm the existing `PlaylistCapExceededException` handler at the playlist-entry POST/PATCH paths propagates the new code (it should). Verify; expect no edit.
- **New** `WsConfig` knob (or `IAppConfig`-backed accessor): read `freeform_auto_append_cap` (default `100`). [lib/WebSocket/WsConfig.php](../../../lib/WebSocket/WsConfig.php) already centralises config — add the field there and pass through to `PlaylistService::merge()` / `autoAppend()` via a constructor injection or a small `FreeformConfig` value object. Backend-only setting, no admin UI.
- **New** [tests/Unit/Service/PlaylistServiceFreeformPruneTest.php](../../../tests/Unit/Service/PlaylistServiceFreeformPruneTest.php) — covers: prune drops oldest auto_appended first; never drops curated; never drops cursored auto_appended; renumbers position; throws `freeform_cap_full` when nothing eligible to drop; no-op when under cap; no-op when freeformMode is false.

### Frontend
- [src/components/PlaylistEditor.vue](../../../src/components/PlaylistEditor.vue) — inside the per-row `NcActions` block at lines 85-130, add an `NcActionButton` conditionally rendered when `entry.source === 'auto_appended'`:
  - Icon: a "pin" or "bookmark" Material icon (`IconPin` or `IconBookmark`), matching existing icon import style.
  - Label: `t('playbacksync', 'Convert to curated')`.
  - Click: call a new handler `onConvertToCurated(entry)` that invokes `roomsStore.updateEntry(props.room.uuid, entry.entryId, { source: 'curated' })` (the store method already exists for label/episode/season edits; widen its payload type to accept `source: 'curated'`). On success the entry's source flips in the room object via the existing reactive pipeline; the action menu re-renders without the button.
- [src/stores/rooms.ts](../../../src/stores/rooms.ts) — confirm `updateEntry()` exists (it does, used by the label-edit flow from the single-mode/default-mode specs). Widen its TS payload type to include `source?: 'curated'`. No new toast wiring.
- [src/services/playlistApi.ts](../../../src/services/playlistApi.ts) — confirm `updateEntry` payload allows `source` (it should — the backend `updateEntry()` already accepts `source` and rejects anything other than `curated`). Widen the TS body type if needed.
- [l10n/en.js](../../../l10n/en.js) and [l10n/nl.js](../../../l10n/nl.js) — add the new strings ("Convert to curated", and the freeform-cap-full toast) in both files with real Dutch translations.

### Reuse (do not reimplement)
- `PlaylistService::updateEntry()` already validates the `source` transition (only `→ curated`) — reuse via existing store/api.
- `NcActions` + `NcActionButton` per-row pattern in [PlaylistEditor.vue](../../../src/components/PlaylistEditor.vue) lines 85-130.
- `PlaylistCapExceededException` wire-error mapping pattern already in place for `CODE_PER_MESSAGE` / `CODE_PER_ROOM`.
- `JoinHandler::maybeSteer()` already implements freeform polite follow; no change.
- `CursorChangeHandler` already broadcasts `PLAYLIST_UPDATE` then `CURSOR_CHANGE` on the auto-append path; no change.
- `@nextcloud/vue` components per [CLAUDE.md](../../../CLAUDE.md): no native primitives.

## Tasks

### Task 1 — Save spec documentation

Create `agent-os/specs/2026-05-16-1830-content-model-freeform-mode/` with `plan.md`, `shape.md`, `standards.md`, `references.md`, and an empty `visuals/` directory.

### Task 2 — Backend: app config knob

Add a `freeformAutoAppendCap` field (default `100`, clamped to `[1, PlaylistService::PER_ROOM_CAP]`) sourced from app config key `freeform_auto_append_cap`. Inject into `PlaylistService` and `CursorService` constructors.

### Task 3 — Backend: prune logic in `PlaylistService`

1. Add `public const FREEFORM_DEFAULT_CAP = 100;`.
2. Add `PlaylistCapExceededException::CODE_FREEFORM_CAP = 'freeform_cap_full'`.
3. Add `private function pruneAutoAppendedIfOverCap(Room $room, int $cap): void`:
   - Only act when `$room->getFreeformMode() === true`.
   - Build eligibility: `auto_appended` entries whose `entryId !== $room->getCursorEntryId()`. Sort by `addedAt` asc, ties by `position` asc.
   - Drop entries from the head of the eligibility list until `count(entries) <= $cap`.
   - Renumber remaining `position` contiguously from 1.
   - If still over cap after exhausting eligibility, throw `PlaylistCapExceededException(CODE_FREEFORM_CAP, …)`.
4. Call `pruneAutoAppendedIfOverCap` in `autoAppend()` and in `merge()` (after their respective inserts, only when `freeformMode`).
5. Skip in `updateEntry()`, `removeEntry()`, `reorderEntries()`, `promoteToCurated()`, `setCursor()`, `clearAll()`, `refreshLastSeenAt()`.

### Task 4 — Backend: consolidate `CursorService::appendEntry`

Refactor `CursorService::appendEntry` to delegate to a new `PlaylistService::appendForFreeformCursor(Room $room, array $entryShape, string $clientId): PlaylistEntry` method that performs the append + prune inside the already-locked `Room`. Both `CursorService` and the existing `autoAppend()` wrapper share the underlying body.

### Task 5 — Backend: tests

`tests/Unit/Service/PlaylistServiceFreeformPruneTest.php` covering: under cap (no-op); over cap with all eligible (oldest dropped); over cap with cursored auto_appended (cursor preserved); mixed curated + auto_appended (only auto_appended dropped); curated-saturated (throws `freeform_cap_full`); non-freeform mode (no-op); `autoAppend` triggers prune end-to-end.

Run: `docker exec -u www-data master-nextcloud-1 sh -c "cd /var/www/html/apps-extra/playbacksync && phpunit"`.

### Task 6 — Frontend: "Convert to curated" NcActionButton

Edit [src/components/PlaylistEditor.vue](../../../src/components/PlaylistEditor.vue):

1. Inside the per-row `NcActions` (lines 85-130), add an `NcActionButton` with `v-if="entry.source === 'auto_appended'"` after the label-edit button, calling `onConvertToCurated(entry)`.
2. Import `IconPin` (or `IconBookmark`) from `vue-material-design-icons/`.
3. Add `async function onConvertToCurated(entry)` that calls `await roomsStore.updateEntry(props.room.uuid, entry.entryId, { source: 'curated' })`.
4. Widen `roomsStore.updateEntry()` payload TS type and the `playlistApi.updateEntry()` body type to allow `source?: 'curated'`.

### Task 7 — l10n pass

Add to both `l10n/en.js` and `l10n/nl.js`:

- `"Convert to curated"` → `"Zet om naar gecureerd"`
- `freeform_cap_full` toast copy → English + real Dutch translation.

### Task 8 — Manual verification

Walk all seven scenarios (movie-night flow; convert to curated; auto-prune; cursor-protected prune; curated-saturated; mode toggle freeform → default; mutual exclusion) with two browser windows.

## Verification

- `phpunit` passes inside the Docker container.
- `npm run lint` and `npm run build` pass.
- `npm run typecheck` if configured.
- l10n parity: `grep -c "':" l10n/en.js` matches `grep -c "':" l10n/nl.js`.
- Manual walkthrough of all seven Task 8 scenarios with two browser windows.
- Cross-check: `PlaylistService::merge()` and `removeEntry()` in a non-freeform room still behave as before (the helper is a no-op when `freeformMode === false`).
