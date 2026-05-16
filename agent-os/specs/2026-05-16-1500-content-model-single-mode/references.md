# References for Single Mode

## Canonical model docs

### CONTENT_MODEL_SINGLE.md

- **Location:** [CONTENT_MODEL_SINGLE.md](../../../CONTENT_MODEL_SINGLE.md)
- **Relevance:** The doc this spec implements. Defines what single mode locks (playlist mutations) vs allows (cursor between existing entries), JOIN steering behaviour, toggle on/off semantics, the multi-entry lock warning, the bootstrap-URL = sole-entry-pageUrl identity, and the Rick Astley creation scenario the create dialog is being built for.

### CONTENT_MODEL.md / CONTENT_MODEL_TECHNICAL.md

- **Location:** [CONTENT_MODEL.md](../../../CONTENT_MODEL.md), [CONTENT_MODEL_TECHNICAL.md](../../../CONTENT_MODEL_TECHNICAL.md)
- **Relevance:** Treat as background. The logical model document and its technical companion frame single mode as one of two opt-in toggles on a single underlying room shape (playlist + cursor). The persistence shapes and protocol messages described in `CONTENT_MODEL_TECHNICAL.md` are what the existing backend already implements; this spec does not modify them.

## Sibling specs

### Default-mode spec (preceding work)

- **Location:** `agent-os/specs/2026-05-14-2000-content-model-default-mode/`
- **Relevance:** Created `PlaylistEditor.vue` (the surface this spec extends with a mode picker) and the create-dialog mode toggles (the surface this spec extends with a seed-entry field). Read its `plan.md` to understand the playlist-tab placement, the `PlaylistAddDialog` pattern, and the `NcDialog` confirm pattern for "Clear playlist?" that this spec mirrors for "Lock the playlist?".

### Data-substrate spec

- **Location:** `agent-os/specs/2026-05-14-1700-content-model-data-substrate/`
- **Relevance:** Defined the persisted `singleMode` column, the `playlist` JSON column, and `cursorEntryId`. No changes to this layer in the current spec.

### Protocol spec

- **Location:** `agent-os/specs/2026-05-14-1830-content-model-protocol/`
- **Relevance:** Defined the WebSocket and HTTP enforcement: `PLAYLIST_UPDATE` rejected, `CURSOR_CHANGE_REQUEST` with raw video rejected, `single_mode_locked` error code, `toggle_conflict` mutual-exclusion error. Background only — single-mode enforcement is already in place; this spec consumes those error codes via the existing Pinia toast handlers.

## Code references to study before implementing

### PlaylistEditor.vue

- **Location:** [src/components/PlaylistEditor.vue](../../../src/components/PlaylistEditor.vue)
- **Relevance:** Task 5 edits the header. The mode badge at lines 8–10 and `modeBadgeClass` at line 264 are the visual cue to preserve. The "Clear playlist?" `NcDialog` confirm at lines 163–187 is the exact pattern to mirror for the lock-warning confirmation in Task 5.
- **Key patterns:** Inline `NcDialog` with `:canClose` and a `disabled` state; pending boolean ref pattern (`clearing`); `roomsStore` action invocation + success-driven dialog close.

### RoomCreateDialog.vue

- **Location:** [src/components/RoomCreateDialog.vue](../../../src/components/RoomCreateDialog.vue)
- **Relevance:** Task 4 extends this dialog. Existing `singleMode` / `freeformMode` switches at lines 53–69 are unchanged; the bootstrap URL field at lines 13–20 gets a variant helper text and grows a debounced lookup; a new `label` field appears conditionally; the submit payload at lines 275–281 gets `initialEntries` appended.
- **Key patterns:** `watch(() => props.open, …)` reset block at lines 221–231 (extend it for the new refs); `canSubmit` computed at lines 215–219 (extend it for the seed lookup guard); `onOpenChange` close-suppression pattern.

### RoomController.php

- **Location:** [lib/Controller/RoomController.php](../../../lib/Controller/RoomController.php)
- **Relevance:** Task 2 adds `MetadataController` in the same style. RoomController shows the `@NoAdminRequired` annotation pattern, the exception → wire-code translation (`single_mode_locked` at lines 378, 434, 476, 500, 534; `toggle_conflict` at line 321), and the JSON response shape.
- **Key patterns:** `JSONResponse` + `Http::STATUS_*` constants; try/catch around service calls; structured `{ error: 'code', message: '…' }` envelope.

### playlistApi.ts

- **Location:** [src/services/playlistApi.ts](../../../src/services/playlistApi.ts)
- **Relevance:** Task 3 adds `metadataApi.ts` in the same style. Use the route-generator pattern, the axios instance import, and the error-passing convention this file establishes.

### stores/rooms.ts

- **Location:** [src/stores/rooms.ts](../../../src/stores/rooms.ts)
- **Relevance:** Task 5 calls the existing `updateSettings()` action at line 173. The `toggle_conflict` toast at line 185 and `single_mode_locked` toasts (lines 212, 246, 274, 292, 321) are already wired and do not need new handling.
