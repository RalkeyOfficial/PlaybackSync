# Freeform Mode — Shaping Notes

## Scope

Close the two gaps remaining for the otherwise-shipped freeform-mode feature:

1. **Auto-prune.** Cap the auto-appended growth of a freeform room at a default of 100 entries. Drop the oldest `auto_appended` entries first when over the cap; never drop `curated` entries; never drop the cursored entry. If only curated + cursored entries remain at the cap, refuse further auto-appends with a `freeform_cap_full` wire code.
2. **"Convert to curated" dashboard action.** Add an `NcActionButton` to each `auto_appended` row in `PlaylistEditor` that flips the entry's source to `curated` via the existing `updateEntry` HTTP path. No new endpoint.

Freeform mode itself (the persistence flag, WS auto-append on cursor change, JOIN polite-follow steering, empty-playlist seeding, error codes, mutual exclusion against single mode, mode picker UI) is already implemented and out of scope here.

## Decisions

- **Prune fires synchronously inside the room-locked transaction.** Same transaction as the append; no cron, no transient over-cap window. Done in `PlaylistService::autoAppend()` and `merge()` (the only two paths that grow a freeform playlist).
- **Cap default 100, app-config override.** Configured via `freeform_auto_append_cap` (Nextcloud app config), clamped to `[1, PER_ROOM_CAP]`. No per-room knob and no dashboard UI — matches the freeform doc's "configurable, default e.g. 100".
- **`auto_appended` entries are the only prune-eligible source.** Curated entries are owner-deliberate; scraped entries are rare in freeform but still protected (a scrape implies the user *expected* the entry). Cursored entry is preserved regardless of source — dropping it would orphan the cursor mid-watch.
- **Cap-exceeded with no eligible entries = explicit refusal.** Throw `PlaylistCapExceededException(CODE_FREEFORM_CAP)` rather than silently growing. The freeform doc says: *"the room stops accepting auto-appends until the owner clears entries."*
- **Convert button is a per-row `NcActionButton` inside the existing `NcActions`.** Conditional render on `entry.source === 'auto_appended'`. Reuses the existing `playlistApi.updateEntry()` call — the backend `PlaylistService::updateEntry()` already validates "only `→ curated` source transition allowed".
- **Consolidate `CursorService::appendEntry` onto `PlaylistService`.** The inline append in `CursorService` already duplicates `PlaylistService::autoAppend`'s body. Consolidate now so the prune logic lives in one place and can't drift between two paths. `CursorService` gets `PlaylistService` injected and calls a thin `appendForFreeformCursor(Room, …)` helper that operates on the already-locked room.
- **Eager-append joiner sub-setting is deferred.** Freeform doc explicitly says "expose only if anyone asks." Polite follow (the default) is already in place via `JoinHandler::maybeSteer`.
- **Bootstrap-URL auto-update on cursor change is deferred.** Lead doc calls it explicitly a UX choice, not a data-model question.

## Context

- **Visuals:** None (user opted out).
- **References:**
  - [CONTENT_MODEL_FREEFORM.md](../../../CONTENT_MODEL_FREEFORM.md) — the doc this spec implements.
  - [CONTENT_MODEL.md](../../../CONTENT_MODEL.md) + [CONTENT_MODEL_TECHNICAL.md](../../../CONTENT_MODEL_TECHNICAL.md) — lead idea docs; non-deviation rule explicitly stated by the user. The freeform doc must remain consistent with these two.
  - `agent-os/specs/2026-05-16-1500-content-model-single-mode/` — sibling spec; freeform spec mirrors its structure and consumes the mode-picker plumbing it added.
  - `agent-os/specs/2026-05-14-1700-content-model-data-substrate/` — established `freeform_mode` column and `SOURCE_AUTO_APPENDED`.
  - `agent-os/specs/2026-05-14-1830-content-model-protocol/` — established `CURSOR_CHANGE_REQUEST` auto-append, `JoinHandler` polite-follow steering, and `PlaylistCapExceededException` wire-error mapping.
- **Product alignment:** Not surfaced in `agent-os/product/` (mode features are data-model-level, not user-narrative).

## Audit summary

Backend (`Room` entity + migration, `CursorService::resolveAndApply` freeform branch, `PlaylistService::autoAppend`, `JoinHandler::seedFromCurrentlyShowing`, `JoinHandler::maybeSteer`, `PlaylistService::promoteToCurated` / `updateEntry`) and frontend (mode picker `NcSelect` in `PlaylistEditor`, source-aware styling at lines 398/401/414/417) already implement the freeform-mode contract today. The only missing pieces are surfaced in the two-gap list above.

## Standards Applied

- `backend/php-conventions` — applies to edits in `PlaylistService.php`, `CursorService.php`, `PlaylistCapExceededException.php`, `WsConfig.php`, and the new unit test: `declare(strict_types=1)`, `OCP\` imports only, `OCA\PlaybackSync\` namespace, exception code constants.
- `frontend/vue-conventions` — applies to edits in `PlaylistEditor.vue` and TS-type widening in `rooms.ts` / `playlistApi.ts`: `<script setup lang="ts">`, `@nextcloud/vue` imports, `t('playbacksync', …)` for every string, icon `:size` conventions, scoped styles.
