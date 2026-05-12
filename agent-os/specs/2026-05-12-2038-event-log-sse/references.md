# References for Event Log (SSE)

## Similar implementations studied

### HMAC-loopback admin client

- **Location:** `lib/Service/AdminKickClient.php`
- **Relevance:** Exact template for the new `AdminEventClient`. Same canonical (`hash_hmac('sha256', "{METHOD}\n{path}\n{nowMs}", secret)`), same headers, same timeout, same options.
- **Key patterns:** Reads `ws_admin_secret` + `ws_admin_port` from `IAppConfig`; warning-logs on transport failure rather than throwing user-facing errors; per-instance curl handle reuse.

### Existing daemon HTTP admin endpoints

- **Location:** `lib/WebSocket/Admin/PlaybackController.php`, `lib/WebSocket/Admin/KickController.php`, routed through `lib/WebSocket/Admin/PresenceHttpServer.php`.
- **Relevance:** Pattern for adding `EventIngestController` and `EventStreamController`.
- **Key patterns:** HMAC header validation, JSON body parsing, response envelope `{result, …}`. `RoomRegistry::find($uuid)` for runtime lookups.

### Existing event ring buffer

- **Location:** `lib/WebSocket/RoomRuntime.php` lines 22, 99–110, 115–123.
- **Relevance:** The data structure we're extending — `$eventLog`, `pushEvent`, `recentEventsSince`.
- **Key patterns:** Fixed-size FIFO via `array_shift` when over `eventLogSize`. The legacy 5-arg `pushEvent` signature must morph into envelope-based storage while keeping `recentEventsSince` working for client reconnect-replay (mapped at the `MessageEncoder::roomState` boundary).

### Owner-gated room controllers

- **Location:** `lib/Service/RoomService.php::getOwnedRoom` (lines 96–110), called by `RoomController::kickClient` (lines 130–144), `playback` (lines 156–188), `show`, `destroy`.
- **Relevance:** The exact authorization pattern for `RoomController::eventsStream`.
- **Key patterns:** Opaque 404 — same response for "no such room" and "not your room". Don't leak existence.

### Admin-gated controllers

- **Location:** `lib/Controller/AdminSettingsController.php` (and Nextcloud middleware default behavior without `#[NoAdminRequired]`).
- **Relevance:** Pattern for `AdminSettingsController::eventsStream`. Admin auth is enforced by the framework — no extra code needed inside the action.

### Existing dashboard composition

- **Location:** `src/components/RoomDetailDialog.vue`, `src/components/RoomCard.vue`, `src/stores/rooms.ts`.
- **Relevance:** Mount point for the per-room event log. Existing dialog structure (Nc icon-headed sections, two-column field rows) sets the visual direction for the event-log section / tab.
- **Key patterns:** `useTimeFormat` composable (relative + absolute via user preference); optimistic updates with snapshot rollback in `rooms` store actions.

### Existing admin settings page

- **Location:** `src/views/AdminSettings.vue`, `src/stores/adminSettings.ts`, `src/services/adminSettingsApi.ts`.
- **Relevance:** Mount point for the new "Recent activity" `NcSettingsSection`.
- **Key patterns:** Three existing `NcSettingsSection` blocks (WebSocket tuning, daemon binding, room defaults). Title + description + form fields + save button per section. We'll append a fourth section that owns its own EventSource lifecycle.

### Live-state envelope (already on rooms responses)

- **Location:** `agent-os/specs/2026-05-09-1900-rooms-api-live-state/` and `RoomCard.vue` viewers count.
- **Relevance:** Same architectural shape — daemon-tracked ephemeral state surfaced via HMAC loopback, optional with graceful degradation. The event stream is the natural next step in that family.

### EventSource on the browser side

- **Web spec:** [WHATWG HTML — Server-Sent Events](https://html.spec.whatwg.org/multipage/server-sent-events.html)
- **Relevance:** `Last-Event-ID` header semantics, `retry:` field semantics, automatic reconnect. The composable defers reconnection to the browser implementation but adds backoff state tracking.

### Public WS endpoint (analogue for future v2)

- **Location:** `agent-os/specs/2026-05-09-1700-ws-sync-server/` plus the route `/apps/playbacksync/ws/{uuid}`.
- **Relevance:** Pattern for if/when SSE moves to a daemon-direct public path with a short-lived token. Not in scope today, but the architecture should not preclude that migration.
