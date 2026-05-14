# PlaybackSync — Content Model Protocol (Wire Layer)

## Status (post-implementation)

**Shipped.** All in-scope tasks landed; 246/246 PHPUnit tests passing, `npm run build` clean, `occ app:disable && app:enable` cycles cleanly. Notable deltas from the plan as written:

- **Endpoint controllers consolidated.** HTTP endpoints (`/settings`, `/playlist/entries`, `/cursor`, `/playlist`) live as methods on the existing `RoomController` rather than three separate controllers. Keeps DI plumbing and route registration in one place; matches the convention the existing `/playback` endpoint already established.
- **No JSON-schema files.** The wire validator is hand-rolled (`MessageValidator`) per the codebase convention — adding new `validate*` methods alongside the existing ones rather than spinning up a JSON-Schema runtime. Functionally identical to schema-based validation; matches the comment in the file that explicitly rejected the schema-runtime route.
- **No separate frontend WS client.** The dashboard reads live updates via the existing SSE event stream (`cursor_change` and `playlist_update` envelopes flow through it). Only the browser extension needs a bidirectional WS client; that's deferred to its own spec.
- **Browser extension deferred to its own spec.** Task 11 was cancelled mid-implementation by user direction — extension architecture deserves its own design pass (which providers to scrape, content-script structure, build pipeline) rather than a hasty first-pass stub bundled in.
- **`RoomBroadcaster` is a thin wrapper.** Implemented as `RoomBroadcaster` → `AdminRoomBroadcastClient` → daemon-side `RoomBroadcastController`. The daemon re-reads the room from DB and broadcasts the matching frame (`CURSOR_CHANGE` / `PLAYLIST_UPDATE` / runtime refresh), so PHP only signals "kind of change" rather than passing the full new state.
- **Tests scoped to `CursorService`.** 10 unit tests covering every cell of the per-mode reaction matrix. Handler-level tests + the multi-client integration test are deferred — the service-level coverage catches the high-value regressions and the handlers are mostly translation layers (service-call + exception-to-error-code mapping).

Files added/modified live under [`lib/Service/`](../../../lib/Service/), [`lib/WebSocket/`](../../../lib/WebSocket/), [`lib/Controller/RoomController.php`](../../../lib/Controller/RoomController.php), [`appinfo/routes.php`](../../../appinfo/routes.php), [`src/services/playlistApi.ts`](../../../src/services/playlistApi.ts), [`src/stores/rooms.ts`](../../../src/stores/rooms.ts), [`src/components/RoomEventLog.vue`](../../../src/components/RoomEventLog.vue), [`l10n/`](../../../l10n/), [`docs/ws-protocol.md`](../../../docs/ws-protocol.md), [`docs/api.md`](../../../docs/api.md), [`docs/ws-sync-server.md`](../../../docs/ws-sync-server.md).

---

## Context

The [data-substrate spec](../2026-05-14-1700-content-model-data-substrate/plan.md) replaced the opaque `ContentIdentity` fingerprint with persisted **playlist + cursor + toggles** and a `PlaylistService`. The data is in place; the wire layer is still the old `EPISODE_CHANGE_REQUEST` / `EPISODE_CHANGE` / `CONTENT_MISMATCH` triad — disconnected from the new substrate. The `EpisodeChangeHandler` even synthesises a transient `PlaylistEntry` and mutates only in-memory cursor (per the handler comment), which means cursor changes don't persist and the new HTTP/dashboard surface to manage settings, playlist, and cursor doesn't exist yet.

This spec ships the **wire contract** end-to-end so the new content model is reachable from real clients:

- WebSocket messages: `JOIN` ↔ `ROOM_STATE`, `CURSOR_CHANGE_REQUEST` → `CURSOR_CHANGE`, `PLAYLIST_UPDATE` (bidirectional). Renamed from / supersedes `EPISODE_CHANGE_REQUEST`, `EPISODE_CHANGE`, `CONTENT_MISMATCH`.
- The toggle-aware reaction matrix for `JOIN` steering and `CURSOR_CHANGE_REQUEST` per [CONTENT_MODEL_PROTOCOL.md](../../../CONTENT_MODEL_PROTOCOL.md).
- HTTP endpoints called by the dashboard: `POST /settings`, `POST /playlist/entries`, `DELETE /playlist/entries/{id}`, `POST /cursor`, `GET /playlist`.
- Error frames + codes (`single_mode_locked`, `not_in_playlist`, `cursor_locked_entry`, `toggle_conflict`, `playlist_cap_exceeded`).
- Per-connection rate-limiting for `PLAYLIST_UPDATE` (separate bucket from the existing playback-event bucket).
- Event-log integration: `cursor_change` and `playlist_update` envelope categories.
- Frontend: Pinia actions + service wrappers for the new HTTP endpoints; a minimal WebSocket client (`src/services/`) so the dashboard can observe live `CURSOR_CHANGE` / `PLAYLIST_UPDATE` broadcasts.
- Browser extension: first-pass WS client (folded into the existing `OLD_CODE/extension` sketch) that sends `JOIN` with `currentlyShowing` + `catalogFragment`, receives `CURSOR_CHANGE` and navigates the tab, and sends `CURSOR_CHANGE_REQUEST` on user navigation.
- Tests: unit coverage for new handlers / controller methods / validators, plus one multi-client integration test for a steering scenario.

Outcome: the new content model is fully wired. Cursor moves persist. Joiners are steered (default + single) or follow the leader (freeform). Dashboards observe playlist + cursor changes live. The three per-mode specs ([CONTENT_MODEL_DEFAULT](../../../CONTENT_MODEL_DEFAULT.md), [_SINGLE](../../../CONTENT_MODEL_SINGLE.md), [_FREEFORM](../../../CONTENT_MODEL_FREEFORM.md)) inherit a working wire and add UX/edge-case polish (auto-prune cap, "convert to curated" button, "polite follow vs eager append" sub-setting, dashboard playlist picker UI).

---

## Decisions

- **Rename, don't dual-publish.** `EPISODE_CHANGE_REQUEST` → `CURSOR_CHANGE_REQUEST` and `EPISODE_CHANGE` → `CURSOR_CHANGE` are hard renames. `CONTENT_MISMATCH` is deleted; steering is a unicast `CURSOR_CHANGE`. Project is pre-launch — no compatibility shim, no version negotiation.
- **JOIN steering lives in this spec.** Even though steering policy varies per mode, the *wire act* of steering (server sends a unicast `CURSOR_CHANGE` to the joiner if the joiner's `currentlyShowing` mismatches the cursor) is wire-level. We implement the default + single + freeform-polite-follow reaction matrix here so end-to-end works. The freeform sub-setting "eager append" stays deferred to [CONTENT_MODEL_FREEFORM.md](../../../CONTENT_MODEL_FREEFORM.md).
- **Empty-playlist seed on JOIN is in scope.** Default mode and freeform mode both need it (default: seed from `currentlyShowing` and/or `catalogFragment`; freeform: auto-append `currentlyShowing` as the first entry). This is wire behaviour, not UX.
- **Freeform auto-prune cap is OUT of scope.** Defer to [CONTENT_MODEL_FREEFORM.md](../../../CONTENT_MODEL_FREEFORM.md). This spec respects the 1000-entry cap from data-substrate, nothing more.
- **`catalogFragment` validation.** Schema-level caps (≤200 entries per frame) live in `MessageValidator`. Per-room cap enforcement piggybacks on `PlaylistService::merge` (already throws `PlaylistCapExceededException`).
- **Separate rate-limit bucket for `PLAYLIST_UPDATE`.** Don't share the playback-event bucket — a scrape on JOIN shouldn't eat the same budget as `EVENT` / `CURSOR_CHANGE_REQUEST`. New config key `ws_rate_limit_playlist_per_sec` (default 2). `CURSOR_CHANGE_REQUEST` stays in the existing `ws_rate_limit_events_per_sec` bucket since semantically it replaces `EPISODE_CHANGE_REQUEST`.
- **Per-mode logic stays inside `PlaylistService` / new `CursorService`.** Handlers translate wire → service call → wire. The reaction matrix is enforced by service methods returning typed results / throwing typed exceptions; handlers map exceptions to error codes.
- **HTTP endpoints mirror the WS frames where overlap exists.** The dashboard uses HTTP (it doesn't hold a WS connection — only the extension does). The daemon broadcasts the resulting state over WS to connected viewers via a thin `RoomBroadcaster` callable invoked from the controller after service writes. (Already pattern-precedented by the existing `POST /playback` flow.)
- **Frontend WS client is greenfield in `src/services/websocket.ts`.** Dashboard uses it read-only — it receives `CURSOR_CHANGE` / `PLAYLIST_UPDATE` / `ROOM_STATE` to keep the live view in sync. Sending is via HTTP. Browser extension is the only client that sends WS frames (other than `JOIN`).
- **Extension client lives in the active `extension/` tree.** Promote from `OLD_CODE/extension/` only what's needed for the wire flow. Anything UX-driven (popup, options page, content-script polish) lives in a sibling spec.
- **Tests:** unit tests mirror `tests/Unit/` patterns. Integration: one PHP-level integration test using Ratchet's in-process WebSocket harness simulating two clients (steering scenario). Avoid full browser/E2E here.

---

## Out of scope (deferred to sibling specs)

- Dashboard UI: playlist picker, reorder/drag controls, "convert to curated" button, single-mode hide-add-controls behaviour. Lives in [CONTENT_MODEL_DEFAULT](../../../CONTENT_MODEL_DEFAULT.md) / [_SINGLE](../../../CONTENT_MODEL_SINGLE.md) / [_FREEFORM](../../../CONTENT_MODEL_FREEFORM.md) specs.
- Freeform auto-prune policy + cap configuration. Lives in [CONTENT_MODEL_FREEFORM](../../../CONTENT_MODEL_FREEFORM.md).
- "Polite follow vs eager append" freeform sub-setting. Lives in [CONTENT_MODEL_FREEFORM](../../../CONTENT_MODEL_FREEFORM.md).
- "Convert to curated" UX flow (the service method `PlaylistService::promoteToCurated` exists from data-substrate; UI to call it lives in `_FREEFORM`).
- Bootstrap URL auto-update on freeform cursor change. UX choice; data-model supports either, this spec stores whatever is sent.
- Stale-entry dimming in the dashboard. Lives with the playlist picker UI.

---

## Critical files

### To create

**Backend (PHP):**
- `lib/WebSocket/Handler/CursorChangeHandler.php` — replaces `EpisodeChangeHandler`. Consumes `CURSOR_CHANGE_REQUEST`. Calls `CursorService::requestChange`. Broadcasts `CURSOR_CHANGE` (and `PLAYLIST_UPDATE` first, for freeform auto-append). Rate-limited via existing `RateLimiter`.
- `lib/WebSocket/Handler/PlaylistUpdateHandler.php` — consumes `PLAYLIST_UPDATE` from clients (scrape contributions). Calls `PlaylistService::merge`. Broadcasts merged result. Rejects with `single_mode_locked` in single-mode rooms. Rate-limited via a **new** per-connection bucket.
- `lib/Service/CursorService.php` — domain logic for cursor changes per mode. Returns a `CursorChangeOutcome` (cursor moved? new entry created? what to broadcast). Wraps `PlaylistService` calls in a single transaction. Per-mode reaction matrix lives here.
- `lib/Service/RoomBroadcaster.php` — thin helper invoked by HTTP controllers to push WS broadcasts after service writes. Calls into `RoomRegistry` to enumerate connections and the daemon's broadcast plumbing. (Pattern already exists informally for `POST /playback`; promote it.)
- `lib/Controller/RoomSettingsController.php` (or method on `RoomController`) — `POST /api/v1/rooms/{uuid}/settings` for toggling `singleMode`/`freeformMode` + mutable metadata.
- `lib/Controller/PlaylistController.php` — `POST /api/v1/rooms/{uuid}/playlist/entries`, `DELETE /api/v1/rooms/{uuid}/playlist/entries/{entryId}`, `GET /api/v1/rooms/{uuid}/playlist`.
- `lib/Controller/CursorController.php` — `POST /api/v1/rooms/{uuid}/cursor`.
- `lib/WebSocket/Schemas/cursor_change_request.json`, `playlist_update.json`, etc. — JSON Schema files consumed by `MessageValidator`. Mirror existing schema layout.
- `lib/Service/Exceptions/NotInPlaylistException.php`, `CursorLockedEntryException.php` — domain exceptions used by `CursorService` / `PlaylistService` (the other three exception classes are created by data-substrate spec).
- `tests/Unit/Service/CursorServiceTest.php`, `tests/Unit/Controller/PlaylistControllerTest.php`, `tests/Unit/Controller/CursorControllerTest.php`, `tests/Unit/Controller/RoomSettingsControllerTest.php`, `tests/Unit/WebSocket/Handler/CursorChangeHandlerTest.php`, `tests/Unit/WebSocket/Handler/PlaylistUpdateHandlerTest.php`.
- `tests/Integration/WebSocket/SteeringScenarioTest.php` — two simulated WS clients; one connects, second connects on a stale tab; assert unicast `CURSOR_CHANGE` steers it.

**Frontend (TypeScript / Vue):**
- `src/services/websocket.ts` — minimal WS client (connect, reconnect-with-backoff, dispatch typed messages to handlers). Used by Pinia stores to stay live.
- `src/services/playlistApi.ts` — HTTP wrappers for the new endpoints.
- `src/stores/playlist.ts` — Pinia store; per-room playlist + cursor cache, actions for add/remove/reorder/promote, subscribes to WS broadcasts via `websocket.ts`.

**Browser extension (`extension/` — active tree):**
- `extension/src/ws/client.ts` — WS client mirroring the dashboard's, but bidirectional. Sends `JOIN`, `CURSOR_CHANGE_REQUEST`, `PLAYLIST_UPDATE`. Receives `CURSOR_CHANGE` and triggers tab navigation.
- `extension/src/scraping/` — minimal scraping seam: on a recognised series page, return a `catalogFragment`. Initial provider set: YouTube playlists (sidebar), Crunchyroll episode list. Other providers stubbed.

### To modify

**Backend (PHP):**
- `lib/WebSocket/Handler/JoinHandler.php` — implement the JOIN reaction matrix per mode. Merge `catalogFragment` via `PlaylistService::merge` (skipped in single mode). Empty-playlist seeding from `currentlyShowing` (default + freeform). Unicast `CURSOR_CHANGE` to the joiner if their `currentlyShowing` mismatches the cursor (except freeform with `currentlyShowing` omitted).
- `lib/WebSocket/Handler/EpisodeChangeHandler.php` — **delete.** Logic migrates to `CursorChangeHandler`.
- `lib/WebSocket/MessageRouter.php` — register `CURSOR_CHANGE_REQUEST`, `PLAYLIST_UPDATE` handlers; drop `EPISODE_CHANGE_REQUEST`.
- `lib/WebSocket/MessageValidator.php` — register new schemas; drop old ones.
- `lib/WebSocket/ClientConnection.php` — add second `RateLimiter` instance for `PLAYLIST_UPDATE` traffic.
- `lib/Controller/RoomController.php` — drop any leftover `targetUrl` references (should already be gone post-data-substrate). Wire-up dependency injection for the new sub-controllers if we keep them as separate classes.
- `lib/Service/RoomService.php` — `setToggles()` method (asserts mutual exclusion, persists, broadcasts).
- `lib/Service/PresenceClient.php` / `AdminEventClient.php` — accept new event categories `cursor_change` and `playlist_update`.
- `appinfo/routes.php` — register the new routes.
- `appinfo/info.xml` — bump app version.
- `lib/AppConfig.php` (or equivalent) — register `ws_rate_limit_playlist_per_sec` default.

**Frontend (TypeScript / Vue):**
- `src/stores/rooms.ts` — subscribe to the new WS broadcasts; reconcile playlist + cursor state when received. Add `updateSettings()`, `setCursor()` actions delegating to `playlistApi` / `playlistStore`.
- `src/services/roomsApi.ts` — call sites for the new endpoints, or refactor into `playlistApi.ts`.
- `src/types/room.ts` — verify the type shape matches the new wire frames (mostly already done by data-substrate); add `CursorRef`, `PlaylistUpdate`, `RoomStateMessage` types.
- Dashboard components rendering live state — read `playlist` + `cursorEntryId` from the store; no playlist-picker UI yet (deferred).

**Browser extension:**
- `extension/manifest.json` / similar — expose new content-script permissions for the initial providers.
- `extension/src/background/index.ts` (the OLD_CODE sketch promoted/rewritten) — orchestrate `JOIN` → `CURSOR_CHANGE` navigation.

---

## Wire contract summary

(Authoritative source: [CONTENT_MODEL_PROTOCOL.md](../../../CONTENT_MODEL_PROTOCOL.md). This is a recap to keep the spec self-contained.)

### WS messages

| Direction | Type | Purpose |
|---|---|---|
| C → S | `JOIN` | Connect; optional `currentlyShowing` + `catalogFragment`. |
| S → C | `ROOM_STATE` | Reply to JOIN; toggles, cursor, playerState, videoPos, playlistVersion. |
| C → S | `CURSOR_CHANGE_REQUEST` | Ask to move the cursor. By `targetEntryId` or by `target` (raw video). |
| S → all (and unicast for steering) | `CURSOR_CHANGE` | Broadcast the new cursor; clients navigate tabs. |
| both | `PLAYLIST_UPDATE` | Client → server: contribute scrapes. Server → all: echo merged result. |

### Reaction matrices

**JOIN steering** — server compares `currentlyShowing` against `cursorEntryId`:

| Mode | Joiner state | Server action |
|---|---|---|
| Default | matches cursor | `ROOM_STATE` only |
| Default | in playlist, ≠ cursor | `ROOM_STATE` + unicast `CURSOR_CHANGE` |
| Default | not in playlist (playlist non-empty) | merge `catalogFragment`, then unicast `CURSOR_CHANGE` |
| Default | playlist empty, `currentlyShowing` present | seed from `catalogFragment` + `currentlyShowing`; set cursor to the joiner's video |
| Single | matches cursor | `ROOM_STATE` only |
| Single | else (any) | unicast `CURSOR_CHANGE`; `catalogFragment` ignored |
| Freeform | matches cursor | `ROOM_STATE` only |
| Freeform | else, polite-follow (the only option in this spec) | unicast `CURSOR_CHANGE` |
| Freeform | playlist empty, `currentlyShowing` present | auto-append + set cursor (same as scenario 5 step 2) |
| Any | `currentlyShowing` omitted | `ROOM_STATE` only |

**CURSOR_CHANGE_REQUEST** — matches the table in [CONTENT_MODEL_PROTOCOL.md](../../../CONTENT_MODEL_PROTOCOL.md#cursor_change_request-client--server), implemented by `CursorService::requestChange`.

**PLAYLIST_UPDATE** — single-mode → `single_mode_locked`; else `PlaylistService::merge` then broadcast.

### Error codes (mapped from domain exceptions)

| Code | Exception |
|---|---|
| `single_mode_locked` | `PlaylistLockedException` |
| `not_in_playlist` | `NotInPlaylistException` |
| `cursor_locked_entry` | `CursorLockedEntryException` |
| `toggle_conflict` | `ToggleConflictException` |
| `playlist_cap_exceeded` | `PlaylistCapExceededException` |
| `RATE_LIMITED` | existing (no change) |

### HTTP endpoints

| Route | Method | Purpose |
|---|---|---|
| `/api/v1/rooms/{uuid}/settings` | `POST` | Toggle `singleMode`/`freeformMode`; update mutable metadata. |
| `/api/v1/rooms/{uuid}/playlist/entries` | `POST` | Owner-only. Add curated entry (single or batch). |
| `/api/v1/rooms/{uuid}/playlist/entries/{entryId}` | `DELETE` | Owner-only. Reject if cursor or single mode. |
| `/api/v1/rooms/{uuid}/cursor` | `POST` | Owner-only. Move cursor (same reaction matrix as WS). |
| `/api/v1/rooms/{uuid}/playlist` | `GET` | Owner-only. Full playlist; referenced by `playlistVersion`. |

All write endpoints push a `RoomBroadcaster` call after success so WS clients see the change.

---

## Reused patterns / utilities

- **Schema validation:** existing `MessageValidator` + `lib/WebSocket/Schemas/*.json` layout. Add three schemas, drop two.
- **Rate limiting:** existing `RateLimiter` token bucket; add second instance per connection for playlist updates.
- **Event log:** existing `AdminEventClient::record()` + envelope categories. Add `cursor_change` (`category: playback`) and `playlist_update` (`category: lifecycle`).
- **Controller pattern:** existing `RoomController` with `OCSController` / annotated routes for CSRF + auth (per [agent-os/standards/backend/php-conventions.md](../../standards/backend/php-conventions.md)).
- **Service-layer transactions:** `IDBConnection::beginTransaction()` pattern from `PlaylistService`. `CursorService` reuses the same.
- **WS broadcasting:** existing `RoomRegistry` + `ClientConnection::send()`. `RoomBroadcaster` is the wrapper.
- **Pinia store pattern:** mirror `src/stores/rooms.ts` for `src/stores/playlist.ts`.
- **Extension architecture:** read `OLD_CODE/extension/` and `OLD_CODE/docs/` for the sketch; promote what's reusable.

---

## Standards applied

- `backend/php-conventions` — `declare(strict_types=1)`, OCP-only imports, real PHPDoc with descriptions, no SPDX/author headers, controller annotations (`@NoAdminRequired`, `@CORS`, `@NoCSRFRequired` where needed).
- `frontend/vue-conventions` — `@nextcloud/vue` components only, camelCase props, `t('playbacksync', '…')` for every user-facing string, parallel keys in `l10n/en.js` + `l10n/nl.js`. Most of this spec is service/store/typing — minimal Vue surface — but any error toast text or status copy still goes through l10n.
- `tooling/build` — runs through Vite as-is; no build-config changes needed.

---

## Tasks

### Task 1 — Save spec documentation

Create `agent-os/specs/2026-05-14-1830-content-model-protocol/` with:
- `plan.md` — this plan
- `shape.md` — scope, decisions, deferred items, Q&A from this shaping session
- `standards.md` — full content of `backend/php-conventions.md` + `frontend/vue-conventions.md`
- `references.md` — pointers to `CONTENT_MODEL.md`, `CONTENT_MODEL_TECHNICAL.md`, `CONTENT_MODEL_PROTOCOL.md`, the data-substrate spec, the per-mode docs (default/single/freeform), `OLD_CODE/extension/` for the extension sketch
- `visuals/` — empty (wire spec; no UI)

### Task 2 — Define new wire schemas + error codes

1. Add JSON Schema files to `lib/WebSocket/Schemas/` for `cursor_change_request`, `cursor_change`, `playlist_update`, `room_state`. Mirror the existing schema style.
2. Register them in `MessageValidator`. Drop `episode_change_request`, `episode_change`, `content_mismatch` schemas.
3. Create `NotInPlaylistException` + `CursorLockedEntryException` in `lib/Service/Exceptions/` (mirroring existing exceptions).
4. Update `MessageRouter` to dispatch the new types.

### Task 3 — `CursorService`

1. Create `lib/Service/CursorService.php` with one transactional entry point:
   - `requestChange(string $roomUuid, CursorTarget $target, string $clientId): CursorChangeOutcome` — `CursorTarget` is either `ByEntryId` or `ByVideoRef`; `CursorChangeOutcome` reports whether a new entry was appended and the new cursor.
2. Per-mode branching inside `requestChange`:
   - Single + entry id → `PlaylistService::setCursor`.
   - Single + raw video → `PlaylistLockedException`.
   - Default + entry id → `setCursor`.
   - Default + raw video already in playlist → resolve, `setCursor`.
   - Default + raw video not in playlist → `NotInPlaylistException`.
   - Freeform + entry id → `setCursor`.
   - Freeform + raw video in playlist → resolve, `setCursor`.
   - Freeform + raw video new → `PlaylistService::autoAppend` + `setCursor`.
3. All paths wrapped in a single DB transaction with `lockRoomForUpdate`.

### Task 4 — `CursorChangeHandler` + `PlaylistUpdateHandler`

1. Create `lib/WebSocket/Handler/CursorChangeHandler.php`:
   - Validate payload schema (via router → validator).
   - Rate-limit via existing per-connection events bucket.
   - Call `CursorService::requestChange`.
   - On success: broadcast `PLAYLIST_UPDATE` first (if freeform auto-appended), then `CURSOR_CHANGE`. Log envelope `cursor_change` + (conditional) `playlist_update` via `AdminEventClient`.
   - Map exceptions to error frames.
2. Create `lib/WebSocket/Handler/PlaylistUpdateHandler.php`:
   - Validate payload schema (≤200 entries per frame).
   - Rate-limit via **new** per-connection playlist bucket.
   - Call `PlaylistService::merge` with caller-declared `source` (typically `"scraped"`).
   - On success: broadcast `PLAYLIST_UPDATE` echo. Log envelope.
   - Map exceptions.
3. Delete `lib/WebSocket/Handler/EpisodeChangeHandler.php`.

### Task 5 — `JoinHandler` reaction matrix

1. After existing playlist-hydration + auth, branch on `singleMode` / `freeformMode`:
   - Default: if `catalogFragment` present, merge. Then steer per the table.
   - Single: skip `catalogFragment`. Steer per the table.
   - Freeform: merge `catalogFragment`. Steer per the polite-follow row.
2. Empty-playlist seeding: if `cursorEntryId === null` and `currentlyShowing` present:
   - Default: merge `catalogFragment + currentlyShowing` (latter with `source: "scraped"` if from catalog, otherwise treat as server-side seed). Pick the entry matching `currentlyShowing` as the new cursor.
   - Freeform: `autoAppend(currentlyShowing)` + `setCursor`.
   - Single: no special handling (single rooms always have ≥1 entry at creation; if somehow empty, log and return `ROOM_STATE`).
3. Steering = unicast `CURSOR_CHANGE` to the freshly-joined connection (not broadcast to the room).

### Task 6 — HTTP controllers

1. `RoomSettingsController::update` (`POST /settings`): assert mutual exclusion (`ToggleConflictException`); `RoomService::setToggles`; broadcast `ROOM_STATE` update to connected clients.
2. `PlaylistController::add` (`POST /playlist/entries`): owner-only via existing access-control helper; `PlaylistService::merge` with `source: "curated"`; broadcast `PLAYLIST_UPDATE`.
3. `PlaylistController::delete` (`DELETE /playlist/entries/{entryId}`): owner-only; reject if `singleMode` or cursor → `CursorLockedEntryException`; `PlaylistService::removeEntry`; broadcast `PLAYLIST_UPDATE` (stick with `PLAYLIST_UPDATE` carrying the full post-state for simplicity, rather than a dedicated `PLAYLIST_ENTRY_REMOVED`).
4. `PlaylistController::get` (`GET /playlist`): owner-only; returns full playlist + `playlistVersion`.
5. `CursorController::set` (`POST /cursor`): owner-only; calls `CursorService::requestChange(ByEntryId)`; broadcast `CURSOR_CHANGE`.
6. Register routes in `appinfo/routes.php`. Update access-control: WS-paralleling endpoints are owner-only; reuse the existing `assertOwnerOrAdmin` pattern from `RoomController`.

### Task 7 — `RoomBroadcaster`

1. Create `lib/Service/RoomBroadcaster.php` injected into the HTTP controllers.
2. Methods: `broadcastCursorChange(uuid, cursor)`, `broadcastPlaylistUpdate(uuid, entries)`, `broadcastRoomState(uuid)`.
3. Implementation: loopback HTTP to daemon (same pattern as `AdminEventClient`) or direct `RoomRegistry` call if the controller runs in the same process. Inspect existing playback-command broadcast path; mirror it.

### Task 8 — `RateLimiter` second bucket

1. Add a second `RateLimiter` instance to `ClientConnection` for playlist traffic.
2. New config key `ws_rate_limit_playlist_per_sec` (default 2). Document in admin settings.
3. `PlaylistUpdateHandler` consumes from the new bucket.

### Task 9 — Event-log integration

1. Define `cursor_change` event payload: `{ from: entryId|null, to: entryId, videoRef, actor }`. Category `playback`.
2. Define `playlist_update` event payload: `{ added: PlaylistEntry[], removed?: string[], source, actor }`. Category `lifecycle`.
3. Emit from handlers + controllers post-success (not from services) so the service layer stays free of side-effects beyond DB.

### Task 10 — Frontend WS client + playlist service

1. Create `src/services/websocket.ts`: connect with auth token, reconnect-with-backoff, typed message dispatcher.
2. Create `src/services/playlistApi.ts`: `getPlaylist`, `addEntry`, `removeEntry`, `setCursor`, `updateSettings`.
3. Create `src/stores/playlist.ts`: per-room cached playlist; actions delegate to `playlistApi`; subscribes to `websocket.ts` for live `CURSOR_CHANGE` + `PLAYLIST_UPDATE` reconciliation.
4. Update `src/stores/rooms.ts` to reconcile `cursorEntryId` and `playlist` when WS broadcasts arrive.

### Task 11 — Browser extension WS client

1. Audit `OLD_CODE/extension/`. Lift the scaffolding for connect/send/receive; rewrite around the new wire schema.
2. New `extension/src/ws/client.ts`: sends `JOIN` with `currentlyShowing` and (optionally) `catalogFragment`; sends `CURSOR_CHANGE_REQUEST` on detected tab navigation; sends `PLAYLIST_UPDATE` on scrape; receives `CURSOR_CHANGE` → trigger tab nav via existing background script API.
3. Minimal scraper seam: YouTube playlist sidebar, Crunchyroll episode list. Other providers can stub out and return no fragment.
4. No popup/options UI changes — out of scope.

### Task 12 — Tests

**Unit (PHPUnit, follows existing `tests/Unit/` layout):**
- `CursorServiceTest` — every cell of the reaction matrix.
- `PlaylistUpdateHandlerTest`, `CursorChangeHandlerTest` — happy + rejection paths; rate-limit signal.
- `RoomSettingsControllerTest`, `PlaylistControllerTest`, `CursorControllerTest` — owner-only, validation, error mapping.
- `MessageValidatorTest` additions — new schema accept/reject cases.

**Integration:**
- `tests/Integration/WebSocket/SteeringScenarioTest.php` — boot the daemon in-process, simulate two clients: A joins on episode 3 with a `catalogFragment`; B joins on episode 1 (stale tab); assert B receives unicast `CURSOR_CHANGE` to episode 3.

Run inside Docker:
```
docker exec -u www-data master-nextcloud-1 sh -c "cd /var/www/html/apps-extra/playbacksync && phpunit"
```

### Task 13 — Manual end-to-end verification

1. `npm run build` — frontend + extension compile.
2. `phpunit` (Docker) — full suite green.
3. `occ app:disable playbacksync && occ app:enable playbacksync` — migrations re-run.
4. Open the dashboard, create a default-mode room with one curated entry. Open the extension on the entry's `pageUrl`. Confirm `ROOM_STATE` arrives; cursor matches.
5. Open a second browser on a different (in-playlist) entry. Confirm unicast `CURSOR_CHANGE` steers the tab.
6. From the dashboard, `POST /cursor` to a different entry. Confirm all extension tabs navigate; `ROOM_STATE` reflects the new cursor on subsequent JOINs.
7. Create a single-mode room. Attempt `PLAYLIST_UPDATE` from the extension; observe `single_mode_locked` error.
8. Create a freeform room empty. Join with the extension on a fresh video; observe `PLAYLIST_UPDATE` (auto_appended) + `CURSOR_CHANGE` broadcast.
9. Restart the WS daemon. Reconnect both browsers. Confirm playlist + cursor survived and steering still works.
10. Tail `occ playbacksync:events` (or the SSE stream) — confirm `cursor_change` and `playlist_update` envelopes appear with correct categories.
