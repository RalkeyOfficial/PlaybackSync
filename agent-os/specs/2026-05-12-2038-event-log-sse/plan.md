# Event Log — Per-room + Global Admin Viewer (SSE-streamed)

## Context

Today the PlaybackSync daemon already keeps an in-memory ring buffer of `play/pause/seek/reset` events per room (`RoomRuntime::$eventLog`, populated by `pushEvent`), but the buffer is never exposed: clients use `recentEventsSince` only for reconnect replay. `MISSING_FEATURES.md` lists "Audit/event log in UI" as Server-side ring buffer only; not exposed.

Room owners want to see *who did what* in their room, and Nextcloud administrators want a cross-room operational feed for insight into the daemon. This spec exposes the existing ring buffer + a new global ring through **Server-Sent Events streams** so the dashboard receives new entries live without polling. Persistence stays in-memory only — events are lost on daemon restart, by design.

## Decisions captured during shaping

- **No database changes, no migrations.** Persistence = daemon process lifetime.
- **Transport = SSE (`EventSource`)** with a single long-lived connection per surface. No polling, no manual refresh button. On reconnect, the browser's automatic `Last-Event-ID` header drives a server-side replay of buffered events.
- **Event sources covered:** playback, presence (join / leave / kick), room lifecycle (created / renamed / deleted), Nextcloud-admin actions (settings updated, admin secret rotated). `room_expired` is **not** emitted (no cron sweep).
- **`actor` semantics — important fix.** Today `Admin/PlaybackController` records playback commands with `clientId: 'admin'`, but those commands originate from a *room owner clicking the dashboard*, not a Nextcloud admin. New `actor` values:
  - `owner` — owner-initiated action via the dashboard (replaces today's `'admin'` clientId for playback commands).
  - `admin` — reserved for Nextcloud-administrator actions (`settings_updated`, `admin_secret_rotated`).
  - `client` — peer client over WS (clientId = the room client UUID).
  - `system` — daemon-internal (idle prune, tombstone expiry).
- **Owner visibility = events whose `roomUuid` matches an owned room.** Admins don't act on other people's rooms via the existing flows, so this isn't a privacy concern.
- **Per-room UX:** tabbed `RoomDetailDialog` (`Overview` | `Event log`).
- **Global admin UX:** new `NcSettingsSection` `Recent activity` appended to `AdminSettings.vue`.

## Event record schema (single envelope)

```
{
  id:        int,           // monotonic, daemon-process-wide (RoomRegistry::allocateEventId)
  ts:        int,           // unix ms
  type:      string,        // see vocabulary below
  category:  'playback' | 'presence' | 'lifecycle' | 'admin',
  actor:     'client' | 'owner' | 'admin' | 'system',
  actorId:   string | null, // clientId for 'client', userId for owner/admin, null for system
  roomUuid:  string | null, // null only for non-room admin events (e.g. settings_updated)
  data:      object | null  // type-specific
}
```

Vocabulary:
- **playback**: `play`, `pause`, `seek` (`data.videoPos`), `reset`
- **presence**: `client_joined` (`data.clientId`), `client_left` (`data.clientId`, `data.reason: 'closed'|'idle'|'tombstone_expired'`), `client_kicked` (`data.clientId`)
- **lifecycle**: `room_created` (`data.name`, `data.ttlSeconds`), `room_renamed` (`data.from`, `data.to`), `room_deleted`
- **admin**: `settings_updated` (`data.keys`), `admin_secret_rotated`

## SSE wire format

Each event is one SSE record:

```
id: 42
event: event
data: {"id":42,"ts":1735080000000,"type":"play","category":"playback","actor":"client","actorId":"a1b2","roomUuid":"…","data":{"videoPos":12.3}}

```

Additional control records the daemon emits:
- **On connect** — a `meta` record with `{"daemonStartedAtMs":…,"backfilledFromId":…,"backfillCount":…}` so the UI can show a "log was reset since you last looked" hint when `Last-Event-ID > daemon counter`.
- **Heartbeat** — `: keepalive\n\n` comment line every 25 s to defeat reverse-proxy idle timeouts.

Replay-on-connect logic: if the `Last-Event-ID` header is present, daemon emits all currently-buffered events with `id > lastSeen` (chronological), then enters live mode. If absent, daemon emits the entire current ring (up to the configured cap) before going live. SSE `id:` fields make this idempotent across reconnects.

## Architecture

### Daemon — ring storage + pub/sub

**Modify `lib/WebSocket/RoomRegistry.php`:**
- `private int $nextEventLogId = 0;` + `public function allocateEventId(): int`
- `private array $globalEventLog = []` ring (size = `WsConfig::$eventLogSize`).
- `appendGlobalEvent(array $event): void` — pushes + fans out.
- `recentGlobalEventsSince(int $sinceId): list` (supports `?roomUuid=` filter for per-room replay).
- `mergedEventsSince(int $sinceId): list` — chronological merge for the global stream's initial backfill.
- **Pub/sub:**
  - `private array $roomSubscribers = []` keyed by `$uuid` → list of subscriber callables.
  - `private array $globalSubscribers = []`.
  - `subscribeRoom(string $uuid, callable $emit): callable` returns an `unsubscribe` closure.
  - `subscribeGlobal(callable $emit): callable`.
  - Whenever `pushEvent` (on a `RoomRuntime`) or `appendGlobalEvent` is called, invoke matching subscribers with the envelope. Room events fan out to *both* `roomSubscribers[$uuid]` *and* `globalSubscribers`.

**Modify `lib/WebSocket/RoomRuntime.php`:**
- Replace `pushEvent(type, value, clientId, ts, eventId)` with a signature that takes the full envelope and stores it. Call sites (`Handler/EventHandler`, `Admin/PlaybackController`) migrate. Existing client reconnect-replay (`recentEventsSince` → `MessageEncoder::roomState`) keeps working via a legacy adapter at the encoder boundary.

### Daemon — SSE handlers

The daemon's admin HTTP port (`PresenceHttpServer`) is built on the same React/Amp-style loop as the WS server, so long-lived responses are first-class. Add:

- `GET /admin/rooms/{uuid}/events/stream` → new `lib/WebSocket/Admin/EventStreamController.php::room()`
- `GET /admin/events/stream` → `EventStreamController::global()`

Each handler:
1. Verifies the HMAC `Authorization` header (`hash_hmac('sha256', "GET\n{path}\n{nowMs}", secret)` — same canonical as `AdminKickClient`).
2. Reads `Last-Event-ID` header (or `?lastEventId=` query) — query is a fallback for the PHP proxy that strips headers.
3. Writes SSE preamble: `HTTP/1.1 200 OK`, `Content-Type: text/event-stream`, `Cache-Control: no-store`, `X-Accel-Buffering: no`, `Connection: close`.
4. Emits the `meta` record, then the backfill, then registers a subscriber and forwards live events.
5. Heartbeats every 25 s. Cleans up the subscriber on socket close.

Subscriber back-pressure: if a single write buffer exceeds `ws_sse_max_buffered_bytes` (new tunable, default 256 KiB), drop the slowest subscriber and close — protects the daemon from one stuck consumer pinning memory.

### PHP — proxy controllers (`StreamedResponse`-style)

PHP-FPM workers will pin while a stream is open. Acceptable for this product (small friend-group Nextcloud installs, ~1–3 simultaneous viewers per surface). Documented as a known tradeoff.

Two new endpoints in `appinfo/routes.php`:
- `room#eventsStream` → `GET /api/v1/rooms/{uuid}/events/stream`
- `admin_settings#eventsStream` → `GET /api/v1/admin/events/stream`

Implementation pattern (both endpoints):
1. Authenticate / authorize:
   - `RoomController::eventsStream` — owner-gated via `RoomService::getOwnedRoom`.
   - `AdminSettingsController::eventsStream` — admin-gated via the default middleware (no `#[NoAdminRequired]`).
2. Disable framework buffering: `@ob_end_clean()` in a loop, then set headers manually and flush. Return a Nextcloud `StreamResponse` subclass — add a small `lib/Http/SseStreamResponse.php` that overrides `render()` to write the proxy loop and never returns until the upstream closes.
3. Inside `render()`:
   - Build curl handle for the daemon path. Sign the request with the same canonical the daemon expects. Forward `Last-Event-ID` from the client request as a query param.
   - `curl_setopt(CURLOPT_WRITEFUNCTION, fn ($ch, $chunk) => $this->relay($chunk))` where `relay()` echoes the chunk and `flush()`-es.
   - On client abort (`connection_aborted()` checked inside `relay`), return a non-matching byte count so curl aborts the upstream.
   - Cap total runtime at `ws_sse_proxy_max_seconds` (new tunable, default 1800 s); on cap hit, close cleanly with a final `: bye` comment so EventSource reconnects.
4. Emit `Content-Type: text/event-stream`, `Cache-Control: no-store`, `X-Accel-Buffering: no` headers before the first byte.

### New PHP loopback client — `lib/Service/AdminEventClient.php`

Mirrors `lib/Service/AdminKickClient.php`. Public methods:
- `record(string $type, string $category, string $actor, ?string $actorId, ?string $roomUuid, array $data = []): void` — POSTs to `/admin/events` on the daemon, swallows transport errors with a warning log (an event-log write must never break a user request).
- `streamRoom(string $uuid, ?int $lastEventId, callable $onChunk): void` — used by the proxy controller; runs curl with `WRITEFUNCTION`.
- `streamGlobal(?int $lastEventId, callable $onChunk): void`.

### New daemon insertion points

- `lib/WebSocket/Handler/JoinHandler.php` — push `client_joined` after `$ctx->joined = true`.
- `lib/WebSocket/MessageRouter.php` — push `client_left` (`reason: 'closed'`) on close.
- `lib/WebSocket/Tick.php` — push `client_left` (`reason: 'idle' | 'tombstone_expired'`) when pruning.
- `lib/WebSocket/Admin/KickController.php` — push `client_kicked` (actor `'owner'`, actorId = requesting userId from loopback body).
- `lib/WebSocket/Admin/PlaybackController.php` — already pushes playback events; migrate to the new envelope and set `actor: 'owner'` with the userId forwarded from PHP.

Plus a new daemon admin ingress for PHP-originated events:
- `POST /admin/events` → new `lib/WebSocket/Admin/EventIngestController.php`. Body `{ type, category, actor, actorId?, roomUuid?, data? }`. Daemon assigns `ts` and `id`. Routes to per-runtime ring if `roomUuid` matches a live runtime, else `appendGlobalEvent`. Both paths fan out to subscribers.

### PHP insertion points (call `AdminEventClient::record`)

- `lib/Service/RoomService.php::createRoom` → `room_created`.
- `lib/Service/RoomService.php::deleteOwnedRoom` → `room_deleted`.
- `lib/Service/RoomService.php::renameRoom` if/when it lands (not in scope today; leave a TODO).
- `lib/Controller/AdminSettingsController.php::update` → `settings_updated` (actor `'admin'`, `data.keys = array_keys($normalized)`).
- `lib/Controller/AdminSettingsController.php::regenerateAdminSecret` → `admin_secret_rotated`.
- `lib/Controller/RoomController.php::kickClient` — forward the requesting userId into the loopback body so the daemon writes `actor: 'owner', actorId: $userId` on `client_kicked`.
- `lib/Controller/RoomController.php::playback` — same: forward userId so dashboard playback writes `actor: 'owner', actorId: $userId` (today it's mis-labeled `'admin'`).

## Frontend

### New `useEventSource` composable — `src/composables/useEventSource.ts`
Wraps `EventSource` with:
- Reactive `state: 'connecting' | 'open' | 'closed' | 'error'`.
- Reactive `events: Ref<EventLogEntry[]>` (append-only, capped at a configurable max — default 500 — to bound memory).
- Reactive `meta: Ref<{ daemonStartedAtMs, backfilledFromId, backfillCount } | null>`.
- Reactive `degraded: Ref<boolean>` (true after N failed reconnects).
- Automatic reconnect with exponential backoff (1 s → 30 s cap) — `EventSource` already retries, but the composable surfaces state.
- Lifecycle: `start()`, `stop()`. Caller is responsible for stopping on unmount / tab-close.

### New files
- `src/types/event.ts` — TS type for the envelope.
- `src/composables/useEventSource.ts` — see above.
- `src/services/roomEventsApi.ts` — `openRoomEventStream(uuid): EventSource`.
- `src/services/adminEventsApi.ts` — `openAdminEventStream(): EventSource`.
- `src/components/RoomEventLog.vue` — shared renderer. Props `:events`, `:meta`, `:state`, `:degraded`, `:showRoom` (default false). No internal fetching — the parent owns the EventSource.

### Modifications
- `src/components/RoomDetailDialog.vue` — convert body to two tabs (`Overview` | `Event log`). Tab strip is a tiny `role="tablist"` of `NcButton`s (no Nc tab primitive on @nextcloud/vue 9.8). Open the EventSource only when the `Event log` tab activates; close on tab switch / dialog close.
- `src/views/AdminSettings.vue` — append `NcSettingsSection` "Recent activity". Opens its EventSource on mount; closes on unmount. Filter row (category checkboxes, room UUID free-text) applied client-side.
- `src/composables/useTimeFormat.ts` — reuse for row timestamps (tooltip `formatAbsolute`, label `formatRelativePast`).

### Row design (technical/stylish, single line + sub-line)

```
[category icon] [type label]  [actor chip]            [relative ts]
                {data summary, e.g. "seek to 12:34"}  [tooltip = absolute ts]
```

- Icons by category: `Play`/`Pause` for playback, `AccountMultiple` for presence, `Cog` for lifecycle, `ShieldCrown` for admin.
- Actor chip colours: `client` = neutral, `owner` = primary, `admin` = warning, `system` = muted. Resolve userId → display name client-side via `@nextcloud/users` if cheap; otherwise show userId verbatim.
- A small live indicator (pulsing green dot when `state === 'open'`, red when `state === 'closed' || degraded`) at the section header.
- Admin global view prepends a compact room chip (`#abcd1234 · Movie night`) clickable to open `RoomDetailDialog`.

### L10n — add to **both** `l10n/en.js` and `l10n/nl.js` (real Dutch, not copies)

Keys: `Event log`, `Overview`, `Recent activity`, `No events recorded yet.`, `Live`, `Reconnecting…`, `Disconnected`, `Filter`, `Playback`, `Presence`, `Lifecycle`, `Admin`, `Client {clientId} joined`, `Client {clientId} left`, `Client {clientId} disconnected ({reason})`, `Client {clientId} was kicked`, `Played`, `Paused`, `Seeked to {time}`, `Reset to start`, `Room created`, `Room renamed from {from} to {to}`, `Room deleted`, `Settings updated ({count} keys)`, `Admin secret rotated`, `The event log was reset (daemon restarted).`, `Event log is temporarily unavailable.`, `Showing {n} of {total} events`.

## Critical files

### Create
- `lib/Service/AdminEventClient.php`
- `lib/Http/SseStreamResponse.php`
- `lib/WebSocket/Admin/EventIngestController.php`
- `lib/WebSocket/Admin/EventStreamController.php`
- `src/components/RoomEventLog.vue`
- `src/composables/useEventSource.ts`
- `src/services/roomEventsApi.ts`
- `src/services/adminEventsApi.ts`
- `src/types/event.ts`

### Modify
- `lib/WebSocket/RoomRuntime.php` (new envelope storage)
- `lib/WebSocket/RoomRegistry.php` (id allocator, global ring, pub/sub)
- `lib/WebSocket/Admin/PresenceHttpServer.php` (routing for new endpoints)
- `lib/WebSocket/Admin/PlaybackController.php` (actor `'admin'` → `'owner'`, userId forwarded)
- `lib/WebSocket/Admin/KickController.php` (emit `client_kicked` with owner attribution)
- `lib/WebSocket/Handler/JoinHandler.php`
- `lib/WebSocket/MessageRouter.php`
- `lib/WebSocket/Tick.php`
- `lib/WebSocket/WsConfig.php` (new tunables: `ws_sse_max_buffered_bytes`, `ws_sse_proxy_max_seconds`)
- `lib/Service/RoomService.php`
- `lib/Controller/RoomController.php`
- `lib/Controller/AdminSettingsController.php`
- `appinfo/routes.php`
- `src/components/RoomDetailDialog.vue`
- `src/views/AdminSettings.vue`
- `l10n/en.js`, `l10n/nl.js`

## Verification

PHPUnit:
- `tests/Unit/WebSocket/RoomRegistryGlobalRingTest.php` — id monotonicity across runtimes + global; ring eviction at capacity; merged ordering.
- `tests/Unit/WebSocket/RoomRegistrySubscribersTest.php` — `subscribeRoom` / `subscribeGlobal` fan-out + unsubscribe cleanup; subscriber exception isolation (one bad subscriber doesn't break others).
- `tests/Unit/WebSocket/Admin/EventIngestControllerTest.php` — routes to per-runtime vs global; bad payload → 400; HMAC failure → 401.
- `tests/Unit/WebSocket/Admin/EventStreamControllerTest.php` — emits `meta` record first; backfills events with `id > lastEventId`; switches to live mode and forwards new pushes; heartbeats; closes cleanly on socket close; back-pressure subscriber drop.
- `tests/Unit/Service/AdminEventClientTest.php` — HMAC headers match `AdminKickClient`; `record` swallows transport errors; `streamRoom` / `streamGlobal` forward chunks via callback.
- `tests/Unit/Http/SseStreamResponseTest.php` — sets correct headers, flushes incrementally, honours `connection_aborted()`.
- `tests/Unit/Controller/RoomControllerEventsStreamTest.php` — 401 unauth, 404 non-owner, 200 + correct content type happy path.
- `tests/Unit/Controller/AdminSettingsControllerEventsStreamTest.php` — admin-gated; passthrough.

Manual end-to-end:
1. Create a room → admin section shows `room_created` (actor=owner) appearing live in the feed without refresh.
2. Open share link, join with password → both surfaces receive `client_joined` instantly. Play / pause / seek → playback events stream in live.
3. Trigger play from the owner dashboard → both surfaces show playback with actor=owner.
4. Kick from owner UI → `client_kicked` (actor=owner) followed by `client_left` (actor=system, reason=closed) — verify both appear in real-time.
5. Edit admin settings → `settings_updated` arrives within ~1 s. Rotate secret → `admin_secret_rotated`.
6. Delete the room → `room_deleted`. (No `room_expired` — by design.)
7. Restart the daemon (`occ playbacksync:ws-serve`) → EventSource auto-reconnects, UI flashes "Reconnecting…", then a `meta` record with reset daemon counter triggers the "log was reset" banner. New events stream in.
8. Stop the daemon entirely → after backoff exhausts the UI shows the `Disconnected` indicator; rooms list still loads.
9. Open three browser tabs on the admin page → all three receive the same events live; close one → daemon subscriber count decreases (verify via debug log or healthz extension).
10. Switch UI to Dutch locale → every new string renders translated; no English fallthrough.

Browser sanity:
- DevTools Network shows a single EventSource per surface, `Content-Type: text/event-stream`, never-completing pending response.
- Vue devtools shows `RoomEventLog` unmounts when dialog closes / tab switches; the composable's `stop()` cleanly closes the EventSource (no zombie connections in network tab).
- 10-minute open connection shows no memory growth client-side.
- Lighthouse a11y on the admin section: tablist semantics correct, focus order sensible.
- Dutch locale renders every new string.

## Risks and open notes

- **PHP-FPM worker pinning** — one FPM worker is held for the lifetime of each open SSE proxy. With 3 dashboard tabs + 1 admin viewer that's ~4 workers tied up. Document as a known constraint; if it becomes a problem, v2 can move to a public token-gated SSE path served by the daemon directly (mirroring how `/apps/playbacksync/ws/{uuid}` already works).
- **Reverse-proxy buffering** — `X-Accel-Buffering: no` covers nginx; Apache deployments may need `mod_proxy_http` with `flushpackets=on`. Add a docs note.
- **Daemon restart clears the `id` counter.** A reconnecting client's `Last-Event-ID` will be higher than the new counter; the `meta` record's `daemonStartedAtMs` lets the UI detect this and surface a "log was reset" banner instead of silently dropping the `since` filter.
- **Event volume during seek storms** — playback events can spike. The 200-entry per-room default may need bumping; surface as a tunable note in `ws_event_log_size`'s helper text. The 500-entry client-side cap in `useEventSource` is a safety net for browser memory.
- **Tab UI** — `@nextcloud/vue` 9.8 has no first-class tab primitive; the dialog ships a tiny ARIA tablist inside the dialog. Acceptable; promote to a shared component only if a second consumer appears.
- **User display names for `actorId`** — looking up display names per row can be expensive. Fetch lazily and memoize in the composable; raw userId is an acceptable fallback.
