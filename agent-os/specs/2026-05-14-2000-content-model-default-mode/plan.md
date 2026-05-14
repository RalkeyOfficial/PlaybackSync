# Content Model — Default Mode (full vertical)

## Context

[CONTENT_MODEL_DEFAULT.md](../../../CONTENT_MODEL_DEFAULT.md) describes the un-named default behavior of every PlaybackSync room: a synchronized episode list with a playlist + cursor, where joiners on a stale tab get steered, and the playlist grows via scrapes or owner curation.

The wire + persistence work for this model is already done by two prior specs:

- [data-substrate](../2026-05-14-1700-content-model-data-substrate/plan.md) — Room entity, `PlaylistService`, hydration.
- [protocol](../2026-05-14-1830-content-model-protocol/plan.md) — WS messages, HTTP endpoints, JOIN steering matrix, empty-playlist seeding.

The protocol spec explicitly **defers** the dashboard playlist UI, "convert to curated", and stale-entry dimming to per-mode specs. This is that spec for the default mode.

A read-only audit confirms backend coverage for default mode is largely complete (data shapes, JOIN seeding/steering, `CURSOR_CHANGE_REQUEST`, merge rules, `cursor_locked_entry`, HTTP endpoints). The gap is end-user surfaces:

1. **Mode toggles in room creation** — `RoomCreateDialog` has no `singleMode` / `freeformMode` checkboxes; an owner picks "default" today by accident.
2. **Playlist tab in `RoomDetailDialog`** — `RoomDetailDialog` shows "Now watching" as a read-only link; no way to view the playlist, move the cursor, add entries, reorder, or convert auto/scraped entries to curated.
3. **Bulk "Clear all" + stale-entry dimming** — Called out as required in the spec doc; no UI or HTTP endpoint exists.
4. **Backend audit polish** — Re-verify merge rules, mid-watch position-insert, `singleMode`/`freeformMode` mutual exclusion at the settings endpoint, and add the missing "Clear all" route.

Intended outcome: an owner can create a default-mode room, watch the playlist populate from scrapes (anime / YouTube playlist), curate it manually (YouTuber series), insert a forgotten episode mid-watch, move the cursor from the dashboard, and have the block-delete on the cursor entry surface as a clear error.

## Critical files

### Backend (audit + small additions)
- [lib/Service/PlaylistService.php](../../../lib/Service/PlaylistService.php) — merge rules already implement curated > scraped; verify `lastSeenAt` refresh + position-insert reorder math. Add `clearAll()` method.
- [lib/Service/CursorService.php](../../../lib/Service/CursorService.php) — already wires `not_in_playlist` and `cursor_locked_entry`; no change expected, just unit-test pass.
- [lib/Controller/RoomController.php](../../../lib/Controller/RoomController.php) — add `DELETE /api/v1/rooms/{uuid}/playlist` (bulk clear, separate from single-entry `cursor_locked_entry` path); add `PATCH /api/v1/rooms/{uuid}/playlist/entries/{entryId}` for label + position edits (used by "convert to curated" and reorder); confirm settings endpoint rejects `singleMode: true` + `freeformMode: true` combinations.
- [appinfo/routes.php](../../../appinfo/routes.php) — register the two new routes.
- [tests/Unit/Service/PlaylistServiceTest.php](../../../tests/Unit/Service/PlaylistServiceTest.php) (if exists; else create) — cover merge edge cases + clearAll + position-insert.

### Frontend (the bulk of the work)
- [src/components/RoomCreateDialog.vue](../../../src/components/RoomCreateDialog.vue) — add `singleMode` / `freeformMode` toggles (NcCheckboxRadioSwitch), enforce mutual exclusion in template, surface short helper text.
- [src/components/RoomDetailDialog.vue](../../../src/components/RoomDetailDialog.vue) — add `playlist` tab between `overview` and `eventLog` (matches existing tab pattern at lines 21–43). Tab shows the playlist editor; "Now watching" in overview becomes a thin pointer at the tab.
- **New** [src/components/PlaylistEditor.vue](../../../src/components/PlaylistEditor.vue) — the centerpiece. List of `PlaylistEntry` rows (NcListItem-style), cursor indicator, per-row actions menu (NcActions: "Move cursor here", "Edit label", "Convert to curated", "Move up/down", "Remove"), header actions ("Add entry", "Add many", "Clear all"). Reorders via up/down buttons (simpler than drag-and-drop for v1). Dimmed rendering for stale entries (`lastSeenAt` older than configurable threshold).
- **New** [src/components/PlaylistAddDialog.vue](../../../src/components/PlaylistAddDialog.vue) — small NcDialog with a URL field + optional label/episode/season; batch tab takes one URL per line.
- [src/stores/playlist.ts](../../../src/stores/playlist.ts) (created in protocol spec) — confirm exposes `entries`, `cursorEntryId`, `addEntry`, `removeEntry`, `moveCursor`, `updateEntry`, `clearAll`. Wire missing actions to new HTTP routes.
- [src/services/playlistApi.ts](../../../src/services/playlistApi.ts) (created in protocol spec) — add `updateEntry` + `clearAll` calls.
- [l10n/en.js](../../../l10n/en.js) and [l10n/nl.js](../../../l10n/nl.js) — every user-facing string keyed in both, with proper Dutch translations (not English duplicates) per [CLAUDE.md](../../../CLAUDE.md).

### Reuse (do not reimplement)
- Tab pattern, copy-to-clipboard pattern, action chips, NcDialog footer — all already in [RoomDetailDialog.vue](../../../src/components/RoomDetailDialog.vue) (tab template lines 21–43, copy block lines 67–87, footer lines 284–329).
- Existing Pinia room store + SSE event-log hookup remain untouched.
- `NcSelect`, `NcTextField`, `NcActions`, `NcButton`, `NcCheckboxRadioSwitch`, `NcEmptyContent`, `NcNoteCard`, `NcLoadingIcon` per [CLAUDE.md](../../../CLAUDE.md) frontend rules — no native primitives.

## Tasks

### Task 1 — Save spec documentation

Create `agent-os/specs/2026-05-14-2000-content-model-default-mode/` with:

- `plan.md` — this file
- `shape.md` — scope, decisions, scenario list, UI tab placement decision
- `standards.md` — full content of `agent-os/standards/backend/php-conventions.md`, `agent-os/standards/frontend/vue-conventions.md`
- `references.md` — pointers to RoomDetailDialog.vue tab pattern, the data-substrate and protocol sibling specs, CONTENT_MODEL_DEFAULT.md
- `visuals/` — empty (user opted out of mockups)

### Task 2 — Backend audit + small additions

1. Add `PlaylistService::clearAll(string $roomUuid): void` (transactional; reset `cursorEntryId` to null; persist; emit `playlist_update` event with `op: "cleared"`).
2. Add `RoomController::clearPlaylist()` mapped to `DELETE /api/v1/rooms/{uuid}/playlist` — owner-only, requires confirmation header `X-Playbacksync-Confirm-Clear: true` (defense-in-depth against accidental DELETE).
3. Add `RoomController::updateEntry()` mapped to `PATCH /api/v1/rooms/{uuid}/playlist/entries/{entryId}` — accepts `label`, `episodeNumber`, `seasonNumber`, `position`, `source` (only `scraped`/`auto_appended` → `curated` is a valid transition). Repositioning reorders the rest of the playlist; broadcast `PLAYLIST_UPDATE`.
4. Verify `RoomController::updateSettings()` rejects `singleMode: true && freeformMode: true` with `toggle_conflict` (read-only check).
5. Unit tests in `tests/Unit/Service/PlaylistServiceTest.php` for: clearAll, position-insert reorder, curated-stickiness on rescrape, source transition rules.
6. Run the suite: `docker exec -u www-data master-nextcloud-1 sh -c "cd /var/www/html/apps-extra/playbacksync && phpunit"`.

### Task 3 — Room creation mode toggles

Edit `RoomCreateDialog.vue`:

- Add `NcCheckboxRadioSwitch` for `singleMode` and `freeformMode`. Helper text under each (one line: what it does + when to use it).
- Computed property disables `freeformMode` when `singleMode` is on, and vice-versa; brief inline `NcNoteCard` explains mutual exclusion when a user tries to flip the second.
- POST body sends both flags (default `false`); existing endpoint already accepts them.
- l10n keys added to both `l10n/en.js` and `l10n/nl.js`.

### Task 4 — `PlaylistEditor.vue` component

New SFC, mounted as the new `playlist` tab in `RoomDetailDialog`.

Header row: room title + small badge ("Default mode" / "Single mode" / "Freeform mode"), action buttons `Add entry`, `Add many`, `Clear all` (the last opens a confirm dialog and only enables for owners).

Entry rows (one per playlist entry, ordered by `position`):

- Cursor indicator (filled dot at left for `entryId === cursorEntryId`).
- Episode/position label (`S{season}E{episode}` if present, otherwise `#{position}`).
- Title + provider chip + `source` chip (`scraped` / `curated` / `auto_appended`).
- Stale dimming when `lastSeenAt` is older than 7 days (configurable constant, not a setting).
- `NcActions` menu per row: `Move cursor here`, `Edit label` (opens inline NcTextField), `Convert to curated` (only shown for `scraped`/`auto_appended`), `Move up`, `Move down`, `Remove`.
- Remove on the cursor entry shows an `NcNoteCard` warning ("This is the current entry — advance the cursor first") instead of triggering the API, mirroring the backend `cursor_locked_entry` semantics.

Empty state: `NcEmptyContent` ("The playlist will populate when a viewer joins" for default mode, "Add the first entry" for curated rooms).

Loading state: `NcLoadingIcon` while the store is hydrating.

### Task 5 — `PlaylistAddDialog.vue` component

Two tabs: `One entry` (URL + optional label, episode, season, position) and `Many entries` (textarea, one URL per line, all become `source: curated`).

Submits to `playlistApi.addEntry` / batched calls; closes on success; `NcNoteCard` errors on failure.

### Task 6 — Wire `RoomDetailDialog.vue` tab

Add `playlist` to the tab list (between `overview` and `eventLog` per the tab template at lines 21–43). Set `activeTab` initial value to `'overview'`. Tab badge shows `entries.length` when > 0 (mirrors the existing eventLog unread badge style at line 41).

Render `<PlaylistEditor :room="room" />` inside the tab panel; pass through any necessary props from the room store.

In the overview tab, change the "Now watching" link block (lines 246–264) to additionally render a "Open playlist →" link that switches the tab.

### Task 7 — Pinia store + API surface

Confirm `src/stores/playlist.ts` (from the protocol spec) is mounted on dialog open; add actions for `updateEntry`, `clearAll` if missing. Mirror the SSE-driven reconciliation pattern already used in `src/stores/rooms.ts` so `PLAYLIST_UPDATE` and `CURSOR_CHANGE` broadcasts update the editor live.

### Task 8 — l10n pass

Every string added in Tasks 3–6 keyed in both `l10n/en.js` and `l10n/nl.js`. No English copies in `nl.js`; real translations. Drop any keys made dead by this work.

### Task 9 — Manual verification

Per [CLAUDE.md](../../../CLAUDE.md): "For UI or frontend changes, start the dev server and use the feature in a browser before reporting the task as complete."

Walk all four scenarios end-to-end:

1. **Scraped anime** — Create default-mode room with Crunchyroll bootstrap URL. Simulate JOIN with `catalogFragment` (curl or extension); confirm playlist populates, cursor lands on `currentlyShowing`. From dashboard playlist tab, move cursor to ep4. Confirm `CURSOR_CHANGE` broadcasts.
2. **YouTube playlist** — Same flow with a YouTube playlist URL; confirm `list=` query parameter survives in `pageUrl`.
3. **Curated YouTuber series** — Create empty default-mode room. Use `Add many` to paste 5 URLs; confirm all land as `source: curated`. First JOIN sets cursor.
4. **Mid-watch insertion** — During scenario 3, add an entry at `position: 4`; confirm subsequent entries renumber and `PLAYLIST_UPDATE` broadcasts.
5. **Block-delete on cursor entry** — Try removing the cursor entry; confirm the inline warning shows and no DELETE fires.
6. **Clear all** — Confirm clear-all dialog requires confirmation; confirm cursor resets to `null`.
7. **Toggle mutual exclusion** — In create dialog, toggle `singleMode` on then try `freeformMode`; confirm UI blocks it with the explanation.

## Verification

- `phpunit` passes (`docker exec -u www-data master-nextcloud-1 sh -c "cd /var/www/html/apps-extra/playbacksync && phpunit"`).
- `npm run lint` and `npm run build` pass.
- Manual run-through of all seven verification scenarios above with two browser windows (owner + viewer) connected to the same room — confirm broadcasts land in both.
- Type-check via `vue-tsc` if configured (`npm run typecheck` if available).
- l10n: grep `l10n/en.js` and `l10n/nl.js` for matching key counts; no untranslated keys.
