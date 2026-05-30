# Suggest a Mode from the Bootstrap URL — Shaping Notes

## Scope

Add a lightweight, frontend-only nudge to the room-creation modal: inspect the pasted
bootstrap URL and, when it looks like a standalone video, suggest **Freeform** mode via a
dismissable hint card with a one-click apply. List/catalog/unknown URLs get no nudge.

A pre-existing bug surfaced while shaping: the Single/Freeform `NcCheckboxRadioSwitch`
toggles don't respond to clicks (wrong event name for `@nextcloud/vue` 9.8.0). Fixed as
part of this work since the suggestion's "apply" path depends on the toggle working.

**Follow-up during implementation:** the two mutually-exclusive switches were reworked
into a single three-option radio group (Default / Single / Freeform, `NcCheckboxRadioSwitch
type="radio"` sharing one `name`), defaulting to Default, each with an explanatory hint.
A single `mode` ref is now the source of truth; `singleMode`/`freeformMode` are `computed`
from it, so the create-API contract is unchanged. The "apply suggestion" path sets
`mode = 'freeform'` and marks the hint dismissed so toggling back off doesn't resurrect it.

## Decisions

- **UX form:** Hint note + Apply button (`NcNoteCard`). Never silently auto-flip the
  toggle — the owner's manual choice always wins.
- **URL → mode mapping (TODO note as-is):**
  - plain YouTube / Vimeo video → suggest **freeform**
  - YouTube with `?list=` → **default** (no nudge)
  - miruro / Crunchyroll watch URLs → **default** (no nudge)
  - unknown host → **no suggestion**
- **Single mode is never suggested** — deliberate owner choice only.
- **Only the freeform direction is surfaced.** Classifier returns the full
  classification for testability; the modal renders a note only for `freeform` while the
  form is still on Default. Nudging back to Default is a deliberate non-goal.
- **Classification is URL-shape only.** The extension's catalog detection
  (`scrapeCatalog`) isn't reachable at dashboard room-creation time.
- **No backend changes.** Mode flags (`singleMode`/`freeformMode`) already exist end to
  end.

## Context

- **Visuals:** None provided.
- **References:**
  - `src/util/parseVideoUrl.ts` — existing host-parsing util whose style the new
    `suggestMode.ts` mirrors.
  - `src/components/RoomCreateDialog.vue` — host component (bootstrap URL field, mode
    toggles, submit path).
  - `NcNoteCard` precedent in `PlaylistAddDialog.vue` and `PlaylistEditor.vue`.
  - Correct `NcCheckboxRadioSwitch` event usage in `AdminSettings.vue`.
- **Product alignment:** roadmap §"Phase 2: Browser extension" and the two-mode model
  (Default = planned playlist, Freeform = active DJ) documented in `MODES_UX.md`.

## Standards Applied

- **frontend/vue-conventions** — `<script setup lang="ts">`, `@nextcloud/vue` components
  (`NcNoteCard`, `NcButton`), all user-facing strings through `t('playbacksync', …)`,
  scoped styles. This is the only standard that applies; the change is purely Vue.
