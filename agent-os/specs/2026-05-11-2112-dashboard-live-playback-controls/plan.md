# Dashboard live playback controls

## Context

Today the room detail modal (`src/components/RoomDetailDialog.vue`) is read-only: it shows `playerState`, `videoPos`, connected clients, and the currently playing content, but offers no way to *act* on that state. Owners have to alt-tab to the actual player on one of the clients to pause or seek the group.

The daemon already has all the machinery to do this — `RoomRuntime::applyPlay/applyPause/applySeek()` mutate authoritative state, bump `eventId`, append to the ring buffer, and `MessageEncoder::state()` + `activeConnectionsExcept()` broadcast the new `STATE` frame to everyone. Today only client `EVENT` frames trigger this path (via `Handler/EventHandler.php`). The dashboard never enters the picture.

This feature adds an **admin-initiated** equivalent: dashboard sends `play`/`pause`/`seek`/`reset` → PHP controller → HMAC-signed POST to the daemon's admin HTTP server (port 8766) → daemon applies state + broadcasts. Pattern mirrors the already-shipped `kickClient` flow.

Rooms are already per-user in PlaybackSync, so "you can see it = you own it" — the controller reuses `RoomService::getOwnedRoom()` for authorization, exactly like delete and kick.

Spec folder: `agent-os/specs/2026-05-11-2112-dashboard-live-playback-controls/`

## Task 1: Save spec documentation

Create `agent-os/specs/2026-05-11-2112-dashboard-live-playback-controls/` containing:

- `plan.md` — this plan
- `shape.md` — scope, decisions, references
- `standards.md` — full content of `agent-os/standards/backend/php-conventions.md` and `agent-os/standards/frontend/vue-conventions.md` (both apply)
- `references.md` — pointers to `kickClient` flow and the client `EVENT` handler, the two production analogues we extend
- `visuals/` — empty directory (`.gitkeep`); user opted "no visuals, pick a reasonable layout"

## Task 2: Daemon admin endpoint for playback commands

**Goal:** Add a single admin HTTP route `POST /admin/rooms/{uuid}/playback` accepting `{ action: "play"|"pause"|"seek"|"reset", videoPos?: number }`.

Files to add / modify:

- **New:** `lib/WebSocket/Admin/PlaybackController.php`
  - Constructor takes `RoomRegistry`, `MessageEncoder`.
  - Method `apply(string $roomUuid, string $action, ?float $videoPos, int $nowMs): string` returning a result enum (`APPLIED`, `ROOM_NOT_FOUND`, `INVALID_ACTION`).
  - Resolves runtime via `$this->registry->find($roomUuid)`. If runtime is null, return `ROOM_NOT_FOUND` (means no client has joined yet — the daemon has no in-memory state to mutate; controller should surface this to the dashboard, which can show "no live session").
  - Dispatch:
    - `play` → `$runtime->applyPlay($nowMs)`
    - `pause` → `$runtime->applyPause($nowMs)`
    - `seek` → require `$videoPos` ≥ 0 → `$runtime->applySeek((float)$videoPos, $nowMs)`
    - `reset` → `$runtime->applyPause($nowMs)` then `$runtime->applySeek(0.0, $nowMs)` (two events, last-write-wins-state is fine since both are logged)
  - After applying, build a `STATE` frame via `$this->encoder->state($runtime->state, $nowMs)` and broadcast: `foreach ($runtime->activeConnectionsExcept(null) as $peer) { $peer->send($frame); }`
  - **Reuse, don't duplicate:** the broadcast helper. If we end up with two broadcast call sites in `Handler/EventHandler.php` and the new controller, leave it inline — three lines is below the abstraction threshold.

- **Modify:** `lib/WebSocket/Admin/PresenceHttpServer.php`
  - In the route table (lines 20–24), add a route for `POST /admin/rooms/{uuid}/playback`.
  - In `onOpen()` dispatch (around the existing `KickController` branch, ~lines 102–109), parse the JSON body (`action`, `videoPos`), call `PlaybackController::apply()`, map result enum to HTTP status:
    - `APPLIED` → 204 No Content
    - `ROOM_NOT_FOUND` → 404
    - `INVALID_ACTION` → 400
  - Wrap body parsing in try/catch on `JsonException` → 400.

- **Modify:** `lib/Command/WsServe.php` (daemon entry point)
  - Wire `PlaybackController` into the `PresenceHttpServer` constructor alongside `KickController` and `PresenceController`.

Tests: extend the existing PHPUnit coverage for the admin HTTP layer (look under `tests/` — search `KickController` to find the parallel test file and mirror it). Cover happy paths, missing runtime, invalid action, invalid `videoPos`.

## Task 3: PHP backend — client + service + controller route

**Goal:** Expose `POST /api/v1/rooms/{uuid}/playback` to the dashboard, signed-relay to the daemon.

Files to add / modify:

- **New:** `lib/Service/AdminPlaybackClient.php`
  - Pattern: copy `lib/Service/AdminKickClient.php` (lines 46–94) wholesale.
  - Method `apply(string $uuid, string $action, ?float $videoPos): void`.
  - Path: `/admin/rooms/{uuid}/playback`; method: `POST`; JSON body: `{ action, videoPos? }`.
  - HMAC canonical: `"POST\n" . $path . "\n" . $nowMs` (matches PresenceClient/AdminKickClient — note: kick uses path only, no query; we follow that).
  - Throw `PlaybackCommandFailedException` (new, alongside `KickFailedException`) on transport failure / non-2xx, and `RoomNotLiveException` (new) on 404.
  - **Reuse-vs-duplicate call:** the HMAC signing block is now triplicated across `PresenceClient`, `AdminKickClient`, and this new client. Per CLAUDE.md's "three similar lines is better than a premature abstraction," leave it. If a fourth admin client appears later, *then* extract `AdminRequestSigner`.

- **Modify:** `lib/Service/RoomService.php`
  - Add method `sendPlaybackCommand(string $userId, string $uuid, string $action, ?float $videoPos): void`.
  - Body: `$room = $this->getOwnedRoom($userId, $uuid); $this->adminPlaybackClient->apply($room->getUuid(), $action, $videoPos);` — exact mirror of `kickClient()` at lines 147–150.
  - Constructor: inject `AdminPlaybackClient`.

- **Modify:** `lib/Controller/RoomController.php`
  - Add `playback(string $uuid, string $action, ?float $videoPos = null): DataResponse`.
  - Validate `$action` against `['play','pause','seek','reset']` → 400 on miss.
  - Validate `$videoPos`: required and ≥0 when `$action === 'seek'`; ignored otherwise → 400 on miss.
  - Call `$this->service->sendPlaybackCommand($this->userId, $uuid, $action, $videoPos)`.
  - Map exceptions: `RoomNotLiveException` → 409 Conflict with `{ error: 'room_not_live' }`; `PlaybackCommandFailedException` → 502; reuse existing `RoomNotFoundException` mapping from `kickClient`.
  - Annotations: same `@NoAdminRequired`, `@NoCSRFRequired` pattern as `kickClient` (lines 128–142).

- **Modify:** `appinfo/routes.php`
  - Add `['name' => 'room#playback', 'url' => '/api/v1/rooms/{uuid}/playback', 'verb' => 'POST']`.

## Task 4: Frontend — store action + API call

**Goal:** A single Pinia action that wraps the new endpoint with optimistic update and reconcile.

Files to modify:

- **`src/services/roomsApi.ts`**
  - Add `sendPlaybackCommand(uuid: string, action: 'play'|'pause'|'seek'|'reset', videoPos?: number): Promise<void>` — POSTs to `generateUrl('/apps/playbacksync/api/v1/rooms/{uuid}/playback')`.

- **`src/stores/rooms.ts`**
  - Add action `sendPlaybackCommand(uuid, action, videoPos?)`.
  - **Optimistic update:** locate the room in `state.rooms`, snapshot `room.live`, then patch in-place:
    - `play` → `room.live.playerState = 'playing'`
    - `pause` → `room.live.playerState = 'paused'`
    - `seek` → `room.live.videoPos = videoPos`
    - `reset` → `room.live.playerState = 'paused'; room.live.videoPos = 0`
  - Call API. On error: restore snapshot and rethrow. On success: fire-and-forget `this.refresh()` to reconcile from authoritative source.
  - Surface 409 (`room_not_live`) as a distinct error so the modal can show "no clients connected — start playback on a client first."

## Task 5: Frontend — control bar in RoomDetailDialog

**Goal:** Add a control row directly below the playback status display (`src/components/RoomDetailDialog.vue` lines 116–122).

Layout (no visuals provided; reasonable default):

```
[ ▶/⏸ Play|Pause ]   [ ⏮ Reset ]   [ Seek to: (NcTextField type=number) ] [ Go ]
```

Implementation notes:

- Use `NcButton` for Play/Pause and Reset; `NcTextField` `type="number"` `min="0"` for the seek position (per CLAUDE.md: no native `<input>`); a second `NcButton` for "Go" to submit the seek.
- Button label switches based on `playbackVariant`: "Pause" if `playing`, "Play" otherwise (treat `buffering` as playing for the action — pressing it pauses).
- Disable the entire row when `live === null` (daemon offline / no runtime). Add an `NcNoteCard type="warning"` above the row in that case explaining controls are unavailable until a client connects.
- Show a per-button busy state via `NcLoadingIcon` while the request is in flight.
- On error from the store, show a Nextcloud toast (`@nextcloud/dialogs` `showError`) with the message; on `room_not_live` show a specific "no clients connected" message.
- **Every user-facing string** goes through `t('playbacksync', '…')` AND gets a key added to both `l10n/en.js` and `l10n/nl.js` — confirm by grepping for any new key in both files before finishing.

Keys to add to `l10n/en.js` + `l10n/nl.js`:
- `"Play"`, `"Pause"`, `"Reset to start"`, `"Seek to (seconds)"`, `"Go"`, `"No clients connected"`, `"Playback controls unavailable — no clients connected"`, `"Failed to send playback command"`.

## Critical files

**Backend (PHP / daemon):**
- [lib/WebSocket/Admin/PresenceHttpServer.php](lib/WebSocket/Admin/PresenceHttpServer.php) — add route + dispatch
- [lib/WebSocket/Admin/KickController.php](lib/WebSocket/Admin/KickController.php) — reference pattern for new PlaybackController
- [lib/WebSocket/RoomRuntime.php](lib/WebSocket/RoomRuntime.php) — reuse `applyPlay/Pause/Seek`, `activeConnectionsExcept`, `MessageEncoder::state`
- [lib/Command/WsServe.php](lib/Command/WsServe.php) — wire new controller into daemon bootstrap
- [lib/Service/AdminKickClient.php](lib/Service/AdminKickClient.php) — reference for AdminPlaybackClient (HMAC pattern)
- [lib/Service/RoomService.php](lib/Service/RoomService.php) — add `sendPlaybackCommand` (mirror `kickClient` at L147–150)
- [lib/Controller/RoomController.php](lib/Controller/RoomController.php) — add `playback` action (mirror `kickClient` at L128–142)
- [appinfo/routes.php](appinfo/routes.php) — register new route

**Frontend (Vue):**
- [src/components/RoomDetailDialog.vue](src/components/RoomDetailDialog.vue) — add control row at L122
- [src/stores/rooms.ts](src/stores/rooms.ts) — add `sendPlaybackCommand` action
- [src/services/roomsApi.ts](src/services/roomsApi.ts) — add HTTP wrapper
- [l10n/en.js](l10n/en.js), [l10n/nl.js](l10n/nl.js) — new keys, both files

## Verification

End-to-end:

1. **Start the daemon:** `./start-ws-server` (runs `occ playbacksync:ws-serve` inside the docker container). Confirm `GET /api/v1/ws/status` returns healthy in the admin UI.
2. **Open two browser windows** logged in as the same Nextcloud user. Window A: dashboard. Window B: a video player page or test client that has joined the room over WebSocket.
3. **Play:** open the room modal in Window A, click Play. Window B's client should receive a `STATE` frame and reflect `playing`. Window A's modal should optimistically show "Playing", then a fraction of a second later confirm via refresh.
4. **Pause:** click Pause; verify Window B pauses and `videoPos` stops advancing.
5. **Seek:** type `120` into the seek field, click Go. Verify Window B jumps to 120s and `eventId` increments (visible in browser devtools WS panel).
6. **Reset:** click Reset; verify state becomes `paused` with `videoPos: 0`.
7. **No live session:** delete and re-create the room (so no client has joined). Open the modal — control row should be disabled with the "no clients connected" note card.
8. **Concurrent client EVENT:** while Window A is sending admin commands, also trigger a play/pause from Window B's WS client. Confirm both paths use the same `STATE` broadcast and `eventId` advances monotonically (check the daemon log).
9. **Reconnect replay:** seek to 90s from the dashboard, then have a fresh client JOIN — confirm `ROOM_STATE` response includes the admin-initiated event in its `recentEvents` tail (this verifies the event log integration).

Automated:

- `composer run psalm` and `composer run phpcs` clean.
- `npm run lint` clean (no `eslint-disable jsdoc/*`, no hyphenated prop names, no native `<input>`/`<select>`/`<label>`).
- New PHPUnit tests for `PlaybackController`, `AdminPlaybackClient`, and `RoomController::playback` pass.
- Confirm both `l10n/en.js` and `l10n/nl.js` contain every new key: `grep -F '"Play"' l10n/en.js l10n/nl.js` etc.
