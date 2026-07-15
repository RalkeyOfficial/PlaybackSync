# Playback Notifications

On-page popup toasts, injected by the browser extension, that tell each viewer what their
watch-party peers are doing (play / pause / seek / change-video / join / leave), plus a
prominent animated welcome badge shown to *you* the first time you join a room.

## Context

PlaybackSync synchronizes video playback across a small, trusted group. Today the sync is
silent: when a peer pauses or skips, your player just jumps — you get no idea *who* did it or
*why*. The server already knows who did what (it records actor-attributed events in
`RoomRuntime::pushEvent` and streams them to the admin dashboard over SSE), but this
attribution is **deliberately withheld from WS clients** — peers are anonymous to each other
on the wire, and the extension injects **no on-page UI at all** today.

This feature closes that gap: the server broadcasts a lightweight, actor-attributed `NOTICE`
frame to peers, and the extension renders it as a small toast. It also gives new joiners a
clear "you're in" confirmation via a centered animated badge. Net outcome: participants
understand the shared playback state as a social activity, not a series of unexplained jumps.

This is a deliberate, scoped relaxation of the current peer-anonymity design — acceptable per
the product mission (small, trusted, self-hosted friend groups).

## Decisions (from shaping)

- **Broadcast nicknames to peers.** Notices carry the actor's server-generated nickname
  (e.g. `SwiftFox42`). Confirmed acceptable.
- **Notify on all listed events:** play/pause, seek (with target time), change-video (with
  title), and peer join/leave.
- **Two distinct UI surfaces:**
  - **Peer notices** → small **bottom-right**, auto-dismiss (~5s), **stacking** toasts.
  - **Your first-join welcome** → a prominent **horizontally-centered, ~25%-from-top,
    animated badge**: *"You joined the room for **\<video title\>** as **\<nickname\>**"*.
- **Welcome is client-only** (no server round-trip), fires **once per join session**.
- Dedicated new `NOTICE` wire frame — decoupled from authoritative `STATE`/`CURSOR_CHANGE`,
  which stay minimal.
- Extension UI is **vanilla TS + scoped CSS in a Shadow DOM** (WXT `createShadowRootUi`),
  matching the existing toolbar-popup style. **No framework, no `@nextcloud/vue`.**

## Task 1 — Save spec documentation

Create `agent-os/specs/2026-07-15-1940-playback-notifications/` with `plan.md`, `shape.md`,
`standards.md`, `references.md`, and `visuals/.gitkeep`.

## Task 2 — Server: `NOTICE` frame + own-nickname in `ROOM_STATE`

Actor attribution now goes over the wire to peers (the deliberate protocol change).

- **`lib/WebSocket/MessageEncoder.php`**
  - Add `notice(string $event, string $category, string $actor, ?string $actorId, ?array $data, int $serverTsMs): string` — builds
    `{type:'NOTICE', event, category, actor, actorId, data, serverTs}`. Mirror the existing
    `encode()` JSON flags. (`event` is the inner discriminant so it doesn't collide with
    `type:'NOTICE'`.)
  - Extend `roomState(...)` to include the joining client's own `nickname` (needed for the
    welcome badge's *"as \<nickname\>"*). Add a `nickname` param and emit it in the frame.
- **`lib/WebSocket/RoomRuntime.php`**
  - Add `broadcastNotice(MessageEncoder $encoder, string $event, string $category, string $actor, ?string $actorId, ?array $data, int $serverTsMs, ?string $excludeClientId): void` —
    single fan-out choke-point over `activeConnectionsExcept($excludeClientId)`. Encoder is
    **passed in** (no constructor/DI change).
- **Call `broadcastNotice(...)` from the handlers that already hold `clientId`/`nickname`/encoder:**
  - `lib/WebSocket/Handler/EventHandler.php` — after the `STATE` broadcast: `event=$payload['event']`,
    `category='playback'`, `actor='client'`, `actorId=$client->nickname`, `data=['value'=>$value]`
    for seek else `null`, `excludeClientId=$ctx->clientId`.
  - `lib/WebSocket/Handler/CursorChangeHandler.php` — after `CURSOR_CHANGE`:
    `event='cursor_change'`, `data=['videoRef'=>videoRefOf($outcome->cursor)]` (reuse existing
    projection, includes `label`), exclude the actor.
  - `lib/WebSocket/Handler/JoinHandler.php` — after `pushEnvelope(client_joined)`:
    `event='client_joined'`, `category='presence'`, `data=['nickname'=>$client->nickname]`,
    exclude the joiner. Also **pass `$client->nickname` into the `roomState(...)` call** here.
  - `lib/WebSocket/MessageRouter.php` `onClose()` — after `pushEnvelope(client_left)`:
    `event='client_left'`, `category='presence'`, `actor='system'`, `actorId=null`,
    `data=['nickname'=>$client->nickname,'reason'=>$reason]`.
  - `lib/WebSocket/Admin/RoomBroadcastController.php` `broadcastCursorChange()` — after the
    `CURSOR_CHANGE` fan-out: `event='cursor_change'`, `actor='owner'`, `actorId=$ownerUserId`,
    `excludeClientId=null`. `playlist_update` deliberately gets **no** notice.
- **No `MessageValidator.php` change** — it validates client→server frames only.

## Task 3 — Protocol sync (keep all three layers 1:1)

- **`docs/ws-protocol.md`** — document the `NOTICE` frame + per-`event` `data` shapes; document
  the new `ROOM_STATE.nickname` field; add a callout that actor nicknames are now broadcast to
  peers via `NOTICE`; add a short "A pauses → B sees a NOTICE" example. No new `ERROR` codes.
- **`extension/src/background/protocol.ts`**
  - Add `NoticeFrame` (with `NoticeEvent` / `NoticeData` types) to the `InboundFrame` union;
    add `case 'NOTICE': return decodeNotice(parsed)` in `decode()` + a tolerant `decodeNotice()`.
  - Add `nickname` to `RoomStateFrame` and read it in `decodeRoomState()`.

## Task 4 — Extension background: forward notices + emit welcome

- **`extension/src/messages.ts`** — add a shared `Notice` interface and a new
  `BackgroundToContent` arm `{ kind:'notice'; notice: Notice }`.
- **`extension/src/background/ws.ts`**
  - `handleFrame()` `case 'NOTICE':` → forward via a new `WsCallbacks.dispatchNotice(notice)`.
  - Add `welcomeShown: boolean` to `WsRuntime` (init `false`). On first `ROOM_STATE`, emit
    `dispatchNotice({ event:'welcome', actorId: frame.nickname, data:{ videoTitle: frame.cursor?.label ?? null } })`.
- **`extension/entrypoints/background.ts`** — add `dispatchNotice` to `makeCallbacks(tabId)` and
  a `dispatchNotice(tabId, notice)` mirroring `dispatchCommand`.

## Task 5 — Extension content UI (greenfield injected UI)

- **New `extension/src/ui/notifications.ts`** — `initNotifications(ctx)` (lazy) + `showNotice(notice)`.
  WXT `createShadowRootUi` shadow root; bottom-right stacking toasts (`MAX_TOASTS≈4`, ~5s
  auto-dismiss, transition in/out, optional seek coalescing); a separate centered ~25%-from-top
  animated welcome badge. Scoped CSS reuses the popup's token + `prefers-color-scheme` approach.
  Teardown via `ctx.onInvalidated`. Copy mapping: `Host` for owner, `data.nickname` for system,
  else `actorId`; `mmss()` for seek target.
- **`extension/entrypoints/content.ts`** — pass `ctx` into `main`, `await initNotifications(ctx)`,
  route `{ kind:'notice' }` to `showNotice`. Keep the fire-and-forget `undefined` return + the
  `browser.runtime?.id` guard.
- **Docs (project convention):** add `extension/docs/notifications.md` and update
  `extension/docs/architecture.md` (injected-UI layer now exists).

## Task 6 — Popup: always show your own nickname

Surface the viewer's own nickname persistently in the toolbar popup (the Leave
Room screen), reusing the `nickname` now carried on `ROOM_STATE`.

- **`extension/src/background/session.ts`** — add `nickname: string | null` to
  `SessionState` (default `null` in `createSession`); set it in `applyRoomState`
  (`frame.nickname || null`).
- **`extension/src/messages.ts`** — add `nickname: string | null` to `PopupSnapshot`.
- **`extension/src/background/popupBroadcast.ts`** — populate `nickname` in
  `buildSnapshot` (`null` in the no-creds branch, `session?.nickname ?? null`
  otherwise). No new broadcast trigger needed — `ROOM_STATE` already fires one.
- **`extension/entrypoints/popup/main.ts`** + **`popup/index.html`** — render a
  small "You · \<nickname\>" identity chip at the top of the `joined` (and
  reconnecting `disconnected`) views, styled with the popup's existing tokens.
- Docs: update `extension/docs/popup.md`.

## Verification (end-to-end)

1. **Daemon:** run `occ playbacksync:ws-serve` (nextcloud-docker-dev: `docker exec -u www-data
   <stableNN-container> php occ playbacksync:ws-serve`); watch `[playbacksync ws]` log lines.
2. **Builds (required before commit):** from `extension/` — `npm run compile`, `npm run lint`,
   then **both** `npm run build` and `npm run build:firefox`.
3. **Manual E2E:** load both builds, open two sessions on the same miruro page + room link.
   Drive play/pause/seek/change-video/join/leave in session A; confirm session B's bottom-right
   toasts, that A sees no toast for its own actions, the once-per-join centered welcome badge
   with correct title + nickname, stacking/cap/auto-dismiss, dark mode, fullscreen overlay, and
   "Host changed the video to …" on a dashboard-driven cursor change.

## Out of scope

- No user-chosen usernames — nicknames remain server-generated.
- No notification history/settings UI, no mute/preferences, no sound.
- No notices for `playlist_update`, `reset`, buffering, or clock frames.
- No changes to the Nextcloud dashboard/SSE event log (already has attribution).
