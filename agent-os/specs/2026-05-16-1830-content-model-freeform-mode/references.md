# References for Freeform Mode

## Canonical model docs

### CONTENT_MODEL_FREEFORM.md

- **Location:** [CONTENT_MODEL_FREEFORM.md](../../../CONTENT_MODEL_FREEFORM.md)
- **Relevance:** The doc this spec implements. Defines auto-append on cursor change for any client, the auto-prune policy (drop oldest `auto_appended`, never curated, never cursored), the "convert auto_appended → curated" promotion path, polite-follow joiner default, and the explicit deferral of eager-append + bootstrap-URL auto-update.

### CONTENT_MODEL.md and CONTENT_MODEL_TECHNICAL.md (lead idea docs)

- **Location:** [CONTENT_MODEL.md](../../../CONTENT_MODEL.md), [CONTENT_MODEL_TECHNICAL.md](../../../CONTENT_MODEL_TECHNICAL.md)
- **Relevance:** The user explicitly called these the **lead idea documents** that the freeform doc must not deviate from. Treat as background source-of-truth. The persistence shapes, protocol messages, and merge / source rules described here are what the existing backend already implements; this spec does not modify them. If anything in CONTENT_MODEL_FREEFORM.md drifted from these two, the lead docs win.

## Sibling specs

### Single-mode spec (preceding work)

- **Location:** `agent-os/specs/2026-05-16-1500-content-model-single-mode/`
- **Relevance:** Built the mode picker (`NcSelect` in `PlaylistEditor`) that already supports a "Freeform mode" option, plus the `(singleMode, freeformMode)` mutual-exclusion mapping. Read its `plan.md` for the per-row `NcActions` pattern and the `roomsStore.updateEntry` flow that this spec extends.

### Default-mode spec

- **Location:** `agent-os/specs/2026-05-14-2000-content-model-default-mode/`
- **Relevance:** Created the playlist editor tab and the per-row `NcActions` block this spec extends. Established the inline-label-edit flow that pairs naturally with "Convert to curated".

### Data-substrate spec

- **Location:** `agent-os/specs/2026-05-14-1700-content-model-data-substrate/`
- **Relevance:** Defined the persisted `freeform_mode` column, the `playlist` JSON column shape, the `SOURCE_AUTO_APPENDED` enum value, and the entry-id format. No changes to this layer in the current spec.

### Protocol spec

- **Location:** `agent-os/specs/2026-05-14-1830-content-model-protocol/`
- **Relevance:** Defined the wire enforcement: `CursorService::resolveAndApply` freeform auto-append branch, `JoinHandler::maybeSteer` polite-follow steering, `CursorChangeHandler` `PLAYLIST_UPDATE` then `CURSOR_CHANGE` broadcast ordering, `PlaylistCapExceededException` wire-error mapping. Background only — these paths are already in place; this spec adds the `freeform_cap_full` code to the existing mapping pattern.

## Code references to study before implementing

### PlaylistService.php

- **Location:** [lib/Service/PlaylistService.php](../../../lib/Service/PlaylistService.php)
- **Relevance:** Task 3 and Task 4 edit this file. The `withRoomLock()` pattern at lines 519-534 is the transactional boundary every mutation runs inside. `autoAppend()` at lines 171-216 is where the new prune call slots in. `removeEntry()`'s renumbering pattern at lines 270-275 is the model for the prune-helper's position-renumber step. `updateEntry()` at lines 369-451 already validates the "only `→ curated` source transition" — reuse via the existing endpoint.
- **Key patterns:** `withRoomLock(fn(Room $room) => …)` transaction wrapper; `$room->getPlaylistEntries()` / `setPlaylistEntries(...)` mutation pattern; `PlaylistEntry::with(...)` immutable update.

### CursorService.php

- **Location:** [lib/Service/CursorService.php](../../../lib/Service/CursorService.php)
- **Relevance:** Task 4 replaces the inline `appendEntry()` (lines 127-162) with a delegation to `PlaylistService`. The `resolveAndApply()` switch at lines 71-106 stays put; only the freeform branch at line 104 changes call target. The constructor at lines 44-49 gains a `PlaylistService` dependency.
- **Key patterns:** `lockRoomForUpdate` + `commitCursorMove` flow; `CursorTarget` byEntryId vs byVideoRef discriminant.

### PlaylistCapExceededException.php

- **Location:** [lib/Service/Exceptions/PlaylistCapExceededException.php](../../../lib/Service/Exceptions/PlaylistCapExceededException.php)
- **Relevance:** Task 3 adds `CODE_FREEFORM_CAP = 'freeform_cap_full'` alongside the existing `CODE_PER_MESSAGE` / `CODE_PER_ROOM`. The exception's constructor takes the code as its first argument, propagated as the wire payload by the existing handlers.

### PlaylistEditor.vue

- **Location:** [src/components/PlaylistEditor.vue](../../../src/components/PlaylistEditor.vue)
- **Relevance:** Task 6 extends the per-row `NcActions` block at lines 85-130 with a "Convert to curated" `NcActionButton`. The label-edit button at lines 94-99 is the closest pattern to mirror (action button with icon + label + click handler + store action). The source-aware computed CSS classes at lines 398-417 already differentiate auto_appended / curated / scraped visually.
- **Key patterns:** `NcActionButton` with `#icon` slot and `v-if` source guard; `roomsStore.updateEntry` call returning a boolean; toast emission from the store on failure.

### stores/rooms.ts + services/playlistApi.ts

- **Location:** [src/stores/rooms.ts](../../../src/stores/rooms.ts), [src/services/playlistApi.ts](../../../src/services/playlistApi.ts)
- **Relevance:** Task 6 widens the `updateEntry` payload TS type to include `source?: 'curated'`. The store's existing toast handlers cover the failure case; no new handling needed.

### CursorChangeHandler.php / RoomController.php (wire mapping — confirm only)

- **Location:** [lib/WebSocket/Handler/CursorChangeHandler.php](../../../lib/WebSocket/Handler/CursorChangeHandler.php), [lib/Controller/RoomController.php](../../../lib/Controller/RoomController.php)
- **Relevance:** The existing `PlaylistCapExceededException` catch paths surface `getCode()` as the wire payload. Adding `CODE_FREEFORM_CAP` should propagate automatically. Confirm by reading both files; edit only if the catch is hard-coded against the two existing codes.
