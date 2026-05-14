# References for Content Model Protocol

## Design documents

### CONTENT_MODEL_PROTOCOL.md (authoritative wire contract)

- **Location:** [../../../CONTENT_MODEL_PROTOCOL.md](../../../CONTENT_MODEL_PROTOCOL.md)
- **Relevance:** The source of truth for every wire frame in this spec — message types, payload shapes, reaction matrix, error codes, HTTP endpoints, migration notes.
- **Key patterns:** `CURSOR_CHANGE_REQUEST` server reaction matrix, error-code mapping, HTTP endpoint inventory.

### CONTENT_MODEL.md (logical overview)

- **Location:** [../../../CONTENT_MODEL.md](../../../CONTENT_MODEL.md)
- **Relevance:** Conceptual model (playlist + cursor, two toggles, scenarios). Read for "why" context.

### CONTENT_MODEL_TECHNICAL.md (scenario walkthroughs)

- **Location:** [../../../CONTENT_MODEL_TECHNICAL.md](../../../CONTENT_MODEL_TECHNICAL.md)
- **Relevance:** Step-by-step protocol traces for each scenario (anime, YouTube playlist, curated, single, freeform). Use as oracle when writing the integration test.

### CONTENT_MODEL_DATA.md (sibling, already shaped)

- **Location:** [../../../CONTENT_MODEL_DATA.md](../../../CONTENT_MODEL_DATA.md)
- **Relevance:** Defines persisted shape — Room, PlaylistEntry, merge rules, caps. This spec calls into the services that the data-substrate spec ships.

### Per-mode docs (siblings, not yet implemented)

- [CONTENT_MODEL_DEFAULT.md](../../../CONTENT_MODEL_DEFAULT.md) — default mode UX + scenarios. UX deferred; protocol layer still implements the default-mode wire reaction matrix.
- [CONTENT_MODEL_SINGLE.md](../../../CONTENT_MODEL_SINGLE.md) — single mode UX, dashboard "hide add controls", toggling-on-multi-entry warning.
- [CONTENT_MODEL_FREEFORM.md](../../../CONTENT_MODEL_FREEFORM.md) — freeform mode UX, auto-prune policy, polite-follow vs eager-append sub-setting, "convert to curated" flow.

## Sibling specs

### Data substrate (2026-05-14-1700-content-model-data-substrate)

- **Location:** [../2026-05-14-1700-content-model-data-substrate/plan.md](../2026-05-14-1700-content-model-data-substrate/plan.md)
- **Relevance:** Ships `Room` entity changes, `PlaylistEntry` value object, `PlaylistService` (merge, autoAppend, setCursor, removeEntry, reorderEntries, promoteToCurated, refreshLastSeenAt), domain exceptions (`PlaylistLockedException`, `ToggleConflictException`, `PlaylistCapExceededException`, `CursorEntryNotFoundException`), frontend type rewrite. Protocol spec assumes those are in place.
- **Key patterns:** transactional service via `IDBConnection`, `lockRoomForUpdate`, exception → wire-error mapping conventions.

### Room creation / management (architectural template)

- **Location:** [../2026-05-09-1430-room-creation-management/plan.md](../2026-05-09-1430-room-creation-management/plan.md)
- **Relevance:** Established the Entity / Mapper / Service / Controller pattern for this app. Mirror it for `CursorService`, `RoomBroadcaster`, the new controllers.

### Event log SSE (event envelope pattern)

- **Location:** [../2026-05-12-2038-event-log-sse/plan.md](../2026-05-12-2038-event-log-sse/plan.md)
- **Relevance:** Defined the event envelope structure (`type`, `category`, `actor`, `actorId`, `ts`, `id`, `data`) used by `AdminEventClient::record()`. New event categories `cursor_change` and `playlist_update` plug into this.

### Dashboard live playback controls

- **Location:** [../2026-05-11-2112-dashboard-live-playback-controls/plan.md](../2026-05-11-2112-dashboard-live-playback-controls/plan.md)
- **Relevance:** Precedent for the controller-broadcast pattern (`POST /playback` calls into the daemon to push state to WS clients). `RoomBroadcaster` formalises that.

## Source-code reference points

### Backend

- `lib/WebSocket/MessageRouter.php` — dispatcher; register new types here.
- `lib/WebSocket/MessageValidator.php` — schema registration.
- `lib/WebSocket/Schemas/*.json` — JSON schema layout to mirror.
- `lib/WebSocket/Handler/JoinHandler.php` — already hydrates playlist + cursor; extend with the steering matrix.
- `lib/WebSocket/Handler/EpisodeChangeHandler.php` — current rough draft of cursor handling; supplants `CursorChangeHandler` is a clean reimplementation.
- `lib/WebSocket/Handler/EventHandler.php` — pattern for rate-limited handlers.
- `lib/WebSocket/ClientConnection.php` — where the new `RateLimiter` instance goes.
- `lib/WebSocket/RateLimiter.php` — existing token-bucket implementation.
- `lib/Controller/RoomController.php` — existing route conventions, owner-check helper.
- `lib/Service/RoomService.php` — `setToggles` method lands here.
- `lib/Service/AdminEventClient.php` — `record()` for emitting new envelopes.
- `appinfo/routes.php` — route registry.

### Frontend

- `src/stores/rooms.ts` — extension point for live reconciliation.
- `src/services/roomsApi.ts` — HTTP wrapper pattern; mirror for `playlistApi.ts`.
- `src/types/room.ts` — type definitions (already extended by data-substrate).

### Browser extension

- `OLD_CODE/extension/` — scaffolding sketch. Specifically:
  - `OLD_CODE/extension/background/index.ts` — message router skeleton (`EPISODE_CHANGE_REQUEST`, `CONTENT_IDENTITY`, `PLAYBACK_INTENT`).
  - `OLD_CODE/docs/` — protocol notes from the previous design pass.
- Promote the connect/send/receive scaffolding; rewrite around the new wire schema. Provider-specific scrapers (YouTube, Crunchyroll) are first-pass only.

### Tests

- `tests/Unit/WebSocket/MessageValidatorTest.php` — schema accept/reject patterns to mirror.
- `tests/Unit/WebSocket/RateLimiterTest.php` — bucket-test patterns.
- `tests/Unit/Controller/RoomControllerTest.php` — controller unit-test scaffold.
- `tests/Unit/Service/RoomServiceTest.php` — service unit-test scaffold.
- (No existing integration tests under `tests/Integration/` — `SteeringScenarioTest.php` introduces the directory.)
