# References for Playback Notifications

## Server — where actor attribution already exists

### Event-log envelope (the vocabulary to reuse)

- **Location:** [`lib/WebSocket/RoomRuntime.php`](../../../lib/WebSocket/RoomRuntime.php) —
  `pushEvent()` / `pushEnvelope()`.
- **Relevance:** already builds `{id, ts, type, category('playback'|'presence'|'lifecycle'),
  actor('client'|'owner'|'system'), actorId(nickname), roomUuid, data}` and publishes to the
  admin SSE stream. The new `NOTICE` frame reuses this field vocabulary (`type`→`event`).
- **Key pattern:** `activeConnectionsExcept(?clientId)` is the existing peer-iteration helper the
  new `broadcastNotice()` builds on; actor-exclusion is just passing `$ctx->clientId`.

### Frame encoders / validators (the wire boundary)

- **Location:** [`lib/WebSocket/MessageEncoder.php`](../../../lib/WebSocket/MessageEncoder.php) —
  `encode()`, `roomState()` (line 34), `cursorChange()`, `encodeCursor()` (line 147, carries
  `label`).
- **Relevance:** the new `notice()` method mirrors these; `roomState()` gains a `nickname` param.
  `encodeCursor()`'s projection (incl. `label`) is what the welcome badge's video title and the
  `cursor_change` notice reuse.
- **Note:** [`lib/WebSocket/MessageValidator.php`](../../../lib/WebSocket/MessageValidator.php)
  validates **client→server** frames only — no change needed for the server→client `NOTICE`.

### Handlers (the emission call sites)

- [`lib/WebSocket/Handler/EventHandler.php`](../../../lib/WebSocket/Handler/EventHandler.php) —
  play/pause/seek; broadcasts `STATE` then (new) `broadcastNotice`.
- [`lib/WebSocket/Handler/CursorChangeHandler.php`](../../../lib/WebSocket/Handler/CursorChangeHandler.php)
  — change-video; has a `videoRefOf()` projection to reuse.
- [`lib/WebSocket/Handler/JoinHandler.php`](../../../lib/WebSocket/Handler/JoinHandler.php) —
  assigns `nickname` via `NicknameGenerator`; emits `client_joined`; calls `roomState(...)`.
- [`lib/WebSocket/MessageRouter.php`](../../../lib/WebSocket/MessageRouter.php) — `onClose()`
  emits `client_left`.
- [`lib/WebSocket/Admin/RoomBroadcastController.php`](../../../lib/WebSocket/Admin/RoomBroadcastController.php)
  — owner/dashboard-driven `CURSOR_CHANGE` (`actor='owner'`).

## Protocol contract (three layers kept 1:1)

- [`docs/ws-protocol.md`](../../../docs/ws-protocol.md) — authoritative wire reference; add
  `NOTICE` + `ROOM_STATE.nickname` + the peer-attribution callout.
- [`extension/src/background/protocol.ts`](../../../extension/src/background/protocol.ts) — the TS
  mirror. `InboundFrame` union + `decode()` switch + per-frame decoders with coercion helpers
  (`asString`/`asInt`/`asNullableString`). Add `NoticeFrame`/`decodeNotice()`, extend
  `RoomStateFrame`/`decodeRoomState()`.

## Extension messaging + dispatch path

- [`extension/src/messages.ts`](../../../extension/src/messages.ts) — cross-context discriminated
  unions. Add the `Notice` interface + `{ kind:'notice' }` arm to `BackgroundToContent` (today
  only `{ kind:'command' }`).
- [`extension/src/background/ws.ts`](../../../extension/src/background/ws.ts) — the only WebSocket
  client; `handleFrame()` dispatches inbound frames via `WsCallbacks`. Add `case 'NOTICE'` +
  `dispatchNotice` callback + the `welcomeShown` latch on `WsRuntime` fired from `ROOM_STATE`.
- [`extension/entrypoints/background.ts`](../../../extension/entrypoints/background.ts) —
  `dispatchCommand(tabId, …)` (≈lines 1093–1117) is the template for `dispatchNotice(tabId, …)`;
  `makeCallbacks(tabId)` wires it.
- [`extension/entrypoints/content.ts`](../../../extension/entrypoints/content.ts) — pure message
  bridge today (renders nothing). The `onMessage` listener (≈lines 81–84) gains a
  `{ kind:'notice' }` branch → `showNotice`; `main` receives `ctx` for `initNotifications(ctx)`.

## On-page UI — greenfield, but a styling precedent exists

- [`extension/entrypoints/popup/index.html`](../../../extension/entrypoints/popup/index.html) —
  the toolbar popup's inline `<style>` (CSS custom properties on `:root`, `color-scheme: light
  dark`, `@media (prefers-color-scheme: dark)` override, `system-ui` font, BEM-ish classes). The
  new shadow-root CSS copies this token approach (scoped to `:host`).
- [`extension/entrypoints/popup/main.ts`](../../../extension/entrypoints/popup/main.ts) —
  imperative vanilla-DOM render (`createElement`/`replaceChildren`), the pattern
  `notifications.ts` follows. **No** framework anywhere in the extension.
- **No existing injected UI** — no `createShadowRootUi`/`attachShadow`/overlay today. WXT's
  `createShadowRootUi(ctx, …)` (with `ctx.onInvalidated` teardown) is the isolation boundary
  against host-page CSS.

## Documentation precedent

- [`extension/docs/`](../../../extension/docs/) — per-feature markdown (`architecture.md`,
  `popup.md`, `protocol-client.md`, …). Add `notifications.md`; update `architecture.md` for the
  new injected-UI layer.
- [`extension/WXT-AND-BROWSERS.md`](../../../extension/WXT-AND-BROWSERS.md) — the cross-browser
  rules (`browser.*`, no global `manifestVersion`, fire-and-forget returns `undefined`, build
  both targets).

## Identity model (for copy)

- Server assigns a random `clientId` + a `NicknameGenerator` nickname (e.g. `SwiftFox42`) on
  JOIN; no user-chosen usernames (recent commit: "username field must be empty").
- Copy layer: `actor==='owner'` → **"Host"**; `actor==='system'` (leave) → `data.nickname`;
  otherwise → `actorId` (the nickname). Welcome badge uses the client's own `ROOM_STATE.nickname`.
