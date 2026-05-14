# Content Model — Default Mode — Shaping Notes

## Scope

Full vertical for the **un-named default** room behavior: backend audit + the two small endpoints the dashboard needs (`DELETE /playlist`, `PATCH /playlist/entries/{id}`), and the Vue dashboard surfaces an owner uses to manage a default-mode room. Authoritative source: [CONTENT_MODEL_DEFAULT.md](../../../CONTENT_MODEL_DEFAULT.md); overview/source-of-truth in [CONTENT_MODEL.md](../../../CONTENT_MODEL.md) and [CONTENT_MODEL_TECHNICAL.md](../../../CONTENT_MODEL_TECHNICAL.md).

Covered:

- Backend audit + `PlaylistService::clearAll`, `RoomController::clearPlaylist`, `RoomController::updateEntry`.
- Unit tests for merge edge cases, position-insert reorder, source transitions.
- Room creation dialog gets `singleMode` / `freeformMode` toggles (with mutual exclusion).
- New `Playlist` tab in `RoomDetailDialog`, sitting **between** the existing `overview` and `eventLog` tabs.
- `PlaylistEditor.vue` and `PlaylistAddDialog.vue` SFCs.
- Stale-entry dimming (≥7 days since `lastSeenAt`).
- Block-delete UX for the cursor entry (`cursor_locked_entry` semantics).
- "Convert to curated" affordance for scraped/auto-appended entries.
- l10n keys in both `en.js` and `nl.js`.
- Manual run-through of all four scenarios from CONTENT_MODEL_DEFAULT.md + three edge-case verifications.

Explicitly NOT covered (deferred):

- Single-mode UX ([CONTENT_MODEL_SINGLE.md](../../../CONTENT_MODEL_SINGLE.md)).
- Freeform-mode UX, auto-prune, polite-follow setting ([CONTENT_MODEL_FREEFORM.md](../../../CONTENT_MODEL_FREEFORM.md)).
- Drag-and-drop reorder — v1 uses Move up / Move down NcAction items.
- Bootstrap URL auto-update (default mode never auto-updates per spec).

## Decisions

### UI placement
- **`Playlist` tab in `RoomDetailDialog`, between `overview` and `eventLog`.** Matches existing tab pattern at [RoomDetailDialog.vue:21-43](../../../src/components/RoomDetailDialog.vue#L21-L43). Owners and viewers both see the tab; mutating actions render disabled for non-owners.
- Overview tab keeps the "Now watching" link; gains an "Open playlist →" link that switches to the new tab.

### Mode toggles in creation
- Both `singleMode` and `freeformMode` exposed as `NcCheckboxRadioSwitch` in the room create dialog. Mutual exclusion enforced client-side (computed `:disabled` on the inactive toggle) plus the existing backend rejection of the combination at the settings endpoint.
- Default mode is the un-named default: both off, no special copy needed except a short helper line under each toggle.

### Reorder mechanism (v1)
- Move up / Move down NcAction items only. Drag-and-drop deferred — adds dependency surface and reorder math is identical either way.
- Owner can also enter a position number via Edit entry → Position field (one source of truth, the backend's `PATCH ... { position }` endpoint).

### Stale dimming
- Hardcoded 7-day threshold (`STALE_THRESHOLD_DAYS = 7`). Not user-configurable. Re-evaluate later if owners complain.
- Dimmed rows are still interactive — owner can still move cursor to them, remove them, etc.

### Block-delete on cursor entry
- Frontend pre-flight check: if `entry.entryId === cursorEntryId`, the Remove action shows an inline NcNoteCard ("This is the current entry — advance the cursor first") instead of firing the DELETE.
- Backend still enforces (`cursor_locked_entry`); the UI just prevents the round-trip.

### Bulk Clear All
- New `DELETE /api/v1/rooms/{uuid}/playlist` endpoint, owner-only, requires `X-Playbacksync-Confirm-Clear: true` header. UI fires a confirm dialog before sending.
- Resets `cursorEntryId` to `null` and emits `playlist_update` event with `op: "cleared"`.

### Convert to curated
- Surfaced as an NcAction menu item visible only when `entry.source ∈ {scraped, auto_appended}`.
- Calls `PATCH ... { source: "curated" }`. Once curated, future scrapes only refresh `lastSeenAt`; label and metadata stick.

## Context

- **Visuals:** None. User: "make it look pretty / technical."
- **References:** `src/components/RoomDetailDialog.vue` (tab pattern, dialog footer, action chips), `src/components/RoomCreateDialog.vue` (form layout), `src/stores/rooms.ts` (live-reconciliation pattern), `@nextcloud/vue` upstream patterns (NcListItem with NcActions).
- **Product alignment:** PlaybackSync mission emphasises self-hosted low-end-friendly group watching. A polished playlist editor lowers the friction of owner curation, which directly serves the "small friend groups" target audience from [agent-os/product/mission.md](../../../agent-os/product/mission.md).

## Standards Applied

- `backend/php-conventions` — applies to the two new controller methods and the new service method (strict types, OCP-only imports, OCA\PlaybackSync namespace).
- `frontend/vue-conventions` — applies to `PlaylistEditor.vue`, `PlaylistAddDialog.vue`, `RoomDetailDialog.vue`, `RoomCreateDialog.vue` (script setup, `@nextcloud/vue` imports, `t('playbacksync', …)`, `<style scoped>`).
