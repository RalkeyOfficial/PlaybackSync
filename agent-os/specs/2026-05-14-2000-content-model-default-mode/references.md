# References for Content Model Default Mode

## Design documents

### CONTENT_MODEL_DEFAULT.md (authoritative for this spec)

- **Location:** [../../../CONTENT_MODEL_DEFAULT.md](../../../CONTENT_MODEL_DEFAULT.md)
- **Relevance:** Per-mode source of truth — JOIN reaction matrix for default mode, empty-playlist seeding, cursor change triggers, block-delete on cursor entry, bootstrapUrl rules, scraped/curated/curated-no-playlist scenarios.

### CONTENT_MODEL.md (logical overview)

- **Location:** [../../../CONTENT_MODEL.md](../../../CONTENT_MODEL.md)
- **Relevance:** Conceptual model (playlist + cursor, two toggles, scenarios). Read for "why" context behind default mode.

### CONTENT_MODEL_TECHNICAL.md (scenario walkthroughs + data shapes)

- **Location:** [../../../CONTENT_MODEL_TECHNICAL.md](../../../CONTENT_MODEL_TECHNICAL.md)
- **Relevance:** Step-by-step protocol traces for scenarios 2–4 (anime, YouTube playlist, curated YouTuber series). Use as oracle for manual verification scenarios in Task 9.

## Sibling specs

### Data substrate (2026-05-14-1700-content-model-data-substrate)

- **Location:** [../2026-05-14-1700-content-model-data-substrate/plan.md](../2026-05-14-1700-content-model-data-substrate/plan.md)
- **Relevance:** Ships `Room` entity changes, `PlaylistEntry` value object, `PlaylistService` (merge, autoAppend, setCursor, removeEntry, reorderEntries, promoteToCurated, refreshLastSeenAt). This spec extends the same service with `clearAll`.
- **Key patterns:** transactional service via `IDBConnection`, `lockRoomForUpdate`, exception → wire-error mapping.

### Protocol (2026-05-14-1830-content-model-protocol)

- **Location:** [../2026-05-14-1830-content-model-protocol/plan.md](../2026-05-14-1830-content-model-protocol/plan.md)
- **Relevance:** Ships the wire frames (`CURSOR_CHANGE_REQUEST`, `CURSOR_CHANGE`, `PLAYLIST_UPDATE`), HTTP endpoints (`POST /settings`, `POST /playlist/entries`, `DELETE /playlist/entries/{id}`, `POST /cursor`, `GET /playlist`), and the JOIN steering matrix. This spec adds the two HTTP routes the dashboard needs that the protocol spec deferred (`DELETE /playlist`, `PATCH /playlist/entries/{id}`).
- **Key patterns:** `RoomBroadcaster` for controller→WS push, exception→wire error mapping, frontend `playlistApi.ts` and `playlist` store layout.

### Event log SSE (event envelope pattern)

- **Location:** [../2026-05-12-2038-event-log-sse/plan.md](../2026-05-12-2038-event-log-sse/plan.md)
- **Relevance:** Event envelope (`type`, `category`, `actor`, `actorId`, `ts`, `id`, `data`) used by `AdminEventClient::record()`. The new `op: "cleared"` payload plugs into the existing `playlist_update` category.

### Room creation / management (architectural template)

- **Location:** [../2026-05-09-1430-room-creation-management/plan.md](../2026-05-09-1430-room-creation-management/plan.md)
- **Relevance:** Established the Entity / Mapper / Service / Controller pattern. Mirror it for the new controller methods.

## Reference implementations in this repo

### RoomDetailDialog.vue (tab + dialog patterns)

- **Location:** [../../../src/components/RoomDetailDialog.vue](../../../src/components/RoomDetailDialog.vue)
- **Relevance:** The existing tab strip ([lines 21–43](../../../src/components/RoomDetailDialog.vue#L21-L43)) is what the new `playlist` tab plugs into. Copy-to-clipboard buttons (lines 67–87), action chips, NcDialog footer (lines 284–329), and the SSE-driven event-log tab are all reusable patterns.
- **Key patterns:** `role="tab"` buttons toggling `activeTab` state; computed badges; tab body rendered via `v-if="activeTab === '…'"`.

### RoomCreateDialog.vue (form pattern)

- **Location:** [../../../src/components/RoomCreateDialog.vue](../../../src/components/RoomCreateDialog.vue)
- **Relevance:** Existing form layout with `NcTextField`, `NcButton`, validation messages. The new mode toggles slot into the existing form structure.

### src/stores/rooms.ts (live-reconciliation pattern)

- **Location:** [../../../src/stores/rooms.ts](../../../src/stores/rooms.ts)
- **Relevance:** Pattern for SSE-driven store updates. The `playlist` store (shipped by the protocol spec) mirrors this for `PLAYLIST_UPDATE` and `CURSOR_CHANGE` broadcasts.

### PlaylistService.php (merge/cursor/lock service)

- **Location:** [../../../lib/Service/PlaylistService.php](../../../lib/Service/PlaylistService.php)
- **Relevance:** The new `clearAll` method goes here. The existing `removeEntry` already throws on the cursor entry; reuse the same exception mapping. Merge rules (curated > scraped, lastSeenAt refresh) already implemented and verified by audit.

### CursorService.php (cursor reaction matrix)

- **Location:** [../../../lib/Service/CursorService.php](../../../lib/Service/CursorService.php)
- **Relevance:** Already wires `not_in_playlist` and the move-cursor flow. Read-only audit only.

### RoomController.php (controller + owner-check pattern)

- **Location:** [../../../lib/Controller/RoomController.php](../../../lib/Controller/RoomController.php)
- **Relevance:** Existing route handlers and the owner-check helper. The two new methods (`clearPlaylist`, `updateEntry`) follow the same shape — `@NoAdminRequired`, owner check, service call, `DataResponse`, exception → wire error mapping.

## Upstream / external

### @nextcloud/vue components

- **Reference:** [https://nextcloud-vue-components.netlify.app/](https://nextcloud-vue-components.netlify.app/)
- **Relevance:** Component catalogue for NcListItem with NcActions, NcCheckboxRadioSwitch, NcEmptyContent, NcLoadingIcon. Use the public component API; no custom theming.
