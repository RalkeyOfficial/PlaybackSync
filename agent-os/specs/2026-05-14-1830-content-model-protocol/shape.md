# Content Model Protocol — Shaping Notes

## Scope

Ship the **wire contract** for the new playlist + cursor + toggles content model, full-stack: backend WS handlers + HTTP endpoints + Pinia store/services + extension WS client. Authoritative source for the wire is [CONTENT_MODEL_PROTOCOL.md](../../../CONTENT_MODEL_PROTOCOL.md); logical/scenario context lives in [CONTENT_MODEL.md](../../../CONTENT_MODEL.md) and [CONTENT_MODEL_TECHNICAL.md](../../../CONTENT_MODEL_TECHNICAL.md). The data substrate (Room entity, `PlaylistService`, hydration) is the sibling [data-substrate spec](../2026-05-14-1700-content-model-data-substrate/plan.md) and is assumed in place.

Covered:

- WS messages: `JOIN` ↔ `ROOM_STATE`, `CURSOR_CHANGE_REQUEST` → `CURSOR_CHANGE`, `PLAYLIST_UPDATE` (bidirectional). Hard renames of `EPISODE_CHANGE_REQUEST` / `EPISODE_CHANGE`; deletion of `CONTENT_MISMATCH`.
- JOIN steering reaction matrix per toggle (default / single / freeform polite-follow).
- `CURSOR_CHANGE_REQUEST` reaction matrix per toggle.
- HTTP endpoints (all of them): `POST /settings`, `POST /playlist/entries`, `DELETE /playlist/entries/{id}`, `POST /cursor`, `GET /playlist`.
- Error frames + the five new codes plus existing `RATE_LIMITED`.
- New per-connection rate-limit bucket for `PLAYLIST_UPDATE`.
- Event-log envelopes `cursor_change` (playback) and `playlist_update` (lifecycle).
- Frontend: greenfield `src/services/websocket.ts` + `playlistApi.ts` + `src/stores/playlist.ts`; reconciliation hooks in `src/stores/rooms.ts`.
- Extension: first-pass WS client in `extension/` (promoted from `OLD_CODE/extension/`), minimal scraper seam for YouTube playlists + Crunchyroll.
- Tests: unit per existing `tests/Unit/` patterns plus one PHP-level multi-client steering integration test.

Explicitly NOT covered (deferred to per-mode specs):

- Dashboard playlist picker, reorder UI, "convert to curated" button, single-mode "hide add controls" polish.
- Freeform auto-prune cap policy + configuration.
- Freeform "polite follow vs eager append" sub-setting.
- Bootstrap URL auto-update on freeform cursor change.
- Stale-entry dimming in the dashboard.

## Decisions

### Wire shape
- **Hard renames, no compatibility shim.** Pre-launch project. `EPISODE_CHANGE_REQUEST` → `CURSOR_CHANGE_REQUEST`; `EPISODE_CHANGE` → `CURSOR_CHANGE`; `CONTENT_MISMATCH` deleted (folded into unicast `CURSOR_CHANGE` for steering).
- **JOIN steering is wire-level.** Implemented in `JoinHandler` with the per-mode reaction matrix from the protocol doc. Per-mode UX/edge cases (auto-prune, picker UI) live in sibling specs but the steering act itself ships here.
- **Empty-playlist seeding ships here too.** Default seeds from `catalogFragment + currentlyShowing`; freeform auto-appends `currentlyShowing`; single rooms shouldn't normally see this case (≥1 entry at creation).

### Validation + caps
- `MessageValidator` schema-level cap: ≤200 entries per `PLAYLIST_UPDATE` frame.
- Per-room 1000-entry cap is `PlaylistService`'s job (already throws `PlaylistCapExceededException` from data-substrate spec). Protocol layer just maps the exception to the wire code.

### Rate limiting
- **Separate token bucket for `PLAYLIST_UPDATE`.** A scrape on JOIN shouldn't eat into the playback-event budget. New config key `ws_rate_limit_playlist_per_sec` (default 2). `ClientConnection` holds two `RateLimiter` instances.
- `CURSOR_CHANGE_REQUEST` reuses the existing `ws_rate_limit_events_per_sec` bucket (it replaces `EPISODE_CHANGE_REQUEST` which lived there).

### Service shape
- New `lib/Service/CursorService.php` is the home of the `CURSOR_CHANGE_REQUEST` reaction matrix. Returns a `CursorChangeOutcome` describing what to broadcast (cursor moved? new entry appended?). Wraps `PlaylistService` calls in one DB transaction.
- New `lib/Service/RoomBroadcaster.php` is the seam HTTP controllers use to push WS broadcasts after a service write. Mirrors the existing implicit pattern from `POST /playback`.
- Domain exceptions used: `PlaylistLockedException`, `ToggleConflictException`, `PlaylistCapExceededException` (created by data-substrate) + new `NotInPlaylistException`, `CursorLockedEntryException`. Handlers + controllers map exceptions to wire error codes.

### Frontend split
- Dashboard reads WS only (no send). HTTP for all writes. Greenfield `src/services/websocket.ts` for reading live broadcasts.
- The extension is the only client that sends WS frames besides `JOIN`.

### Event log
- Emission from **handlers + controllers** (not from services). Keeps the service layer side-effect-free beyond DB.

### Tests
- Unit coverage matching existing `tests/Unit/` patterns (`MessageValidatorTest`, `RoomControllerTest`, etc.).
- One PHP-level integration test (`tests/Integration/WebSocket/SteeringScenarioTest.php`) using the Ratchet harness for a two-client steering scenario.

## Context

- **Visuals:** None — wire-layer spec, no UI surface beyond plumbing.
- **References:** [CONTENT_MODEL.md](../../../CONTENT_MODEL.md), [CONTENT_MODEL_TECHNICAL.md](../../../CONTENT_MODEL_TECHNICAL.md), [CONTENT_MODEL_PROTOCOL.md](../../../CONTENT_MODEL_PROTOCOL.md), [CONTENT_MODEL_DATA.md](../../../CONTENT_MODEL_DATA.md), [CONTENT_MODEL_DEFAULT.md](../../../CONTENT_MODEL_DEFAULT.md), [CONTENT_MODEL_SINGLE.md](../../../CONTENT_MODEL_SINGLE.md), [CONTENT_MODEL_FREEFORM.md](../../../CONTENT_MODEL_FREEFORM.md). Sibling [data-substrate spec](../2026-05-14-1700-content-model-data-substrate/plan.md). [OLD_CODE/extension/](../../../OLD_CODE/extension/) for the extension scaffolding sketch.
- **Product alignment:** Matches [mission.md](../../product/mission.md) (decentralized watch-party for self-hosted Nextcloud groups). The protocol shift removes the last brittle piece of the old single-fingerprint identity and unblocks the per-mode UX specs in the [roadmap](../../product/roadmap.md).

## Standards applied

- `backend/php-conventions` — strict types, OCP-only imports, real PHPDoc, no SPDX headers, controller annotations.
- `frontend/vue-conventions` — `@nextcloud/vue` components, camelCase props, l10n via `t('playbacksync', '…')` with parallel keys in `en.js` + `nl.js`. Surface is small (mostly services and types), but any user-facing error toasts still go through l10n.
- `tooling/build` — no Vite changes.

## Q&A from the shaping session

1. **Stack scope** — Full stack: backend + Pinia + extension + minimal dashboard plumbing.
2. **HTTP endpoints** — All HTTP endpoints from the protocol doc land here (overrides the data-substrate spec's "deferred to UX" note).
3. **Mode handling on the wire** — The protocol spec ships the toggle-aware reaction matrix for `JOIN` and `CURSOR_CHANGE_REQUEST` (the wire-level acts). The per-mode specs (default/single/freeform) own UX, picker UI, auto-prune, sub-settings.
4. **Tests** — Unit + one integration test for the steering scenario.
5. **Empty-playlist seeding** — Included here (it's wire behaviour, not UX).
6. **Visuals** — None.
