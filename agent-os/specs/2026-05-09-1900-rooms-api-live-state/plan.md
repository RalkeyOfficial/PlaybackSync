# Rooms API — Live-State Expansion (presence, playback, content)

## Context

Today the rooms API returns only the static DB row (`uuid`, `name`, `targetUrl`, `createdAt`, `expiresAt`, `shareLink` — see [RoomController.php:96-105](lib/Controller/RoomController.php#L96-L105) and [src/types/room.ts](src/types/room.ts)). Everything *interesting* about a live room — who's connected, what's playing, where playback currently is — lives only inside the WS daemon's in-memory `RoomRuntime` ([RoomRuntime.php](lib/WebSocket/RoomRuntime.php)) and is never reachable from the PHP request layer. The Vue rooms page therefore can't show "Alice and Bob are in this room watching Netflix S01E03 at 42:15" — it can only say "this room exists".

This spec expands `GET /api/v1/rooms` and `GET /api/v1/rooms/{uuid}` with live state pulled from the daemon: connected clients (random per-connection `clientId`s — clients are anonymous by design and stay that way; the Chrome extension that drives playback isn't tied to NC user identity), live playback state, content identity, and last-activity. Doing so requires a small new bridge between the PHP app and the daemon, since the daemon currently has no HTTP/IPC surface at all.

The change is additive (no breaking field renames, no removed fields), so we extend the existing v1 spec in place rather than minting a v1.1 — clients ignore unknown fields. A new endpoint is added (`GET /api/v1/rooms/{uuid}/clients`) only as a focused, lower-overhead surface for clients that want presence without the rest.

## Decisions

- **Identity model:** anonymous, server-generated `clientId` is the sole identity surfaced. Matches today's [JOIN spec](docs/ws-protocol.md#L54-L77) and the OLD_CODE precedent (`connectedClients: Map<ClientId, ClientConnection>`). No NC userId, no display name. The frontend renders `clientId` truncated (e.g. first 6 chars) + a stable color hash; "you" is identified by the `clientId` the daemon returned in `ROOM_STATE` and stored in the extension.
- **Bridge:** the daemon exposes a **loopback HTTP admin port** alongside its WebSocket port. Read-only endpoints, shared-secret auth (HMAC of `(ts, path)` in an `X-PBSync-Admin` header — replay-protected with a 30 s window). PHP makes a single batched call per request.
  - **Why not shared cache (IMemcache/Redis)** — distributed cache is an unreliable substitute for ground-truth state; many NC deployments don't run a distributed memcache, and APCu is per-process so the daemon (separate `occ` process) can't share with PHP-FPM workers.
  - **Why not a DB-backed presence table** — heartbeats fire every ~5 s per client. A presence write-storm against `oc_*` for ephemeral state is the wrong direction; presence is intrinsically transient and shouldn't survive daemon restart.
  - **Why HTTP+HMAC over loopback** — matches Nextcloud Talk's signaling-server contract (PHP ↔ external WS daemon over backend HTTP with shared secret), reuses the daemon's existing ReactPHP loop (Ratchet ships `Ratchet\Http\HttpServer` mountable on a separate port), and stays in-memory & exact. Stale by ≤ HTTP RTT (~1 ms) instead of ≤ cache TTL.
- **Failure mode:** if the daemon is unreachable / HMAC fails / call exceeds a 200 ms hard timeout, the rooms API still returns the static room data with `live: null` (and a single warn-log per request, not per room). The rooms page already handles "WS unavailable" via [WsStatusBadge.vue](src/components/WsStatusBadge.vue) — same UX for live fields.
- **List vs detail payloads:** identical live-state shape on both endpoints — the rooms page wants to show a presence dot and "playing 42:15" on each card, and the data is cheap (in-memory lookup, capped at room count × `clientCount`). Per-room client list is capped at 50 in the response; if exceeded, `clients[]` truncates and `clientCount` reflects the true total.
- **Spec versioning:** keep v1. Additive optional fields only. The OpenAPI / route attributes get new optional fields documented; nothing existing changes shape.
- **What "last activity" means:** `max(lastSeenMs across clients, lastEventTs)` from `RoomRuntime`. Falls back to `null` if no client has ever joined.

## Architecture

```
   GET /api/v1/rooms[/uuid]
        ▼
   RoomController
        ▼
   RoomService::listForOwner / getOwnedRoom
        ▼
   ┌─────────────────────────────────────┐
   │ RoomLiveStateEnricher (new)         │
   │  → PresenceClient::fetch(uuids[])   │
   └──────────────┬──────────────────────┘
                  │ HTTP GET 127.0.0.1:8766/admin/rooms/presence?uuids=...
                  │ X-PBSync-Admin: t=...,sig=...   (HMAC-SHA256)
                  ▼
   ┌─────────────────────────────────────┐
   │ occ playbacksync:ws-serve            │
   │  Ratchet IoServer @ 8765 (WS)        │
   │  PresenceHttpServer @ 8766 (admin)   │  ← new
   │   ├─ AdminAuthMiddleware (HMAC)      │
   │   └─ PresenceController              │
   │        reads RoomRegistry            │
   └─────────────────────────────────────┘
```

## Critical files

### To create

**Backend (PHP) — daemon side:**
- `lib/WebSocket/Admin/PresenceHttpServer.php` — wires `Ratchet\Http\HttpServer` + `Ratchet\Http\Router` on a second `React\Socket\SocketServer`. Bound from `WsServe` against the same event loop. Routes one path: `GET /admin/rooms/presence`.
- `lib/WebSocket/Admin/PresenceController.php` — reads `RoomRegistry`, builds the response shape (see *Response shape* below). Pure read, no I/O.
- `lib/WebSocket/Admin/AdminAuthMiddleware.php` — validates `X-PBSync-Admin: t=<unix-ms>,sig=<hex>` where `sig = hmac_sha256(secret, "{method}\n{path}\n{t}")`. Rejects requests with `|now - t| > 30000` (replay window) or bad sig with 401.

**Backend (PHP) — request side:**
- `lib/Service/PresenceClient.php` — `fetch(string ...$uuids): array<string, RoomLiveState|null>`. Issues one `GuzzleHttp\Client::request` (Guzzle is already a Nextcloud transitive dep — check; otherwise use `OCP\Http\Client\IClientService`) with the HMAC header, 200 ms timeout, returns parsed map. Logs once at warn on failure, returns empty map.
- `lib/Service/RoomLiveStateEnricher.php` — given a list of `Room` entities, calls `PresenceClient`, returns `array<uuid, ?array>` of live-state payloads to merge into the serialized response.
- `lib/Service/Dto/RoomLiveState.php` — typed value object: `connectedCount`, `clients[]`, `playerState`, `videoPos`, `contentIdentity?`, `lastActivityMs?`.

**Frontend:**
- *(no new files — extend [src/types/room.ts](src/types/room.ts), [src/services/roomsApi.ts](src/services/roomsApi.ts), [src/components/RoomCard.vue](src/components/RoomCard.vue))*

**Tests:**
- `tests/Unit/WebSocket/Admin/PresenceControllerTest.php` — fixture `RoomRegistry` → expected JSON shape; client list capping at 50.
- `tests/Unit/WebSocket/Admin/AdminAuthMiddlewareTest.php` — accepts valid HMAC; rejects bad sig, stale timestamp, missing header.
- `tests/Unit/Service/PresenceClientTest.php` — mocks the HTTP client; exercises success / timeout / 401 / malformed JSON paths and verifies graceful degradation.
- `tests/Unit/Service/RoomLiveStateEnricherTest.php` — merge logic; unknown room (in DB but not in registry) yields empty live state with `connectedCount=0`, not `null`.

### To modify

- `lib/Controller/RoomController.php` — `index()` and `show()` call `RoomLiveStateEnricher` and merge into the existing `serializeRoom` payload. `serializeRoom` signature gains an optional `?array $live` parameter; output gains `live` key (always present, may be `null`).
- `lib/Command/WsServe.php` — after starting the existing Ratchet `IoServer`, also start `PresenceHttpServer` on `ws_admin_host` (default `127.0.0.1`) / `ws_admin_port` (default `8766`). Loop is shared.
- `lib/AppInfo/Application.php` — register `PresenceClient`, `RoomLiveStateEnricher`, and the admin classes in the container.
- `lib/WebSocket/RoomRuntime.php` — add `lastActivityMs` (touched on every event push & heartbeat). Pure addition, no behavior change to existing methods.
- `lib/WebSocket/ClientConnection.php` — already has `lastSeenMs`; verify and ensure it's exposed via a getter or public readonly.
- `appinfo/routes.php` — add `room#clients` route for `GET /api/v1/rooms/{uuid}/clients` (focused presence-only endpoint, returns the same `live.clients` array).
- `src/types/room.ts` — add `live: RoomLiveState | null` field; declare the `RoomLiveState` interface.
- `src/services/roomsApi.ts` — already returns whatever the server sends; verify no client-side schema validation will reject the new field. Add a `getRoomClients(uuid)` helper for the new endpoint (used by detail views later; rooms page uses inline `room.live`).
- `src/components/RoomCard.vue` — add a presence row (avatar-style chips for the first ~5 `clientId`s, "+N more" if longer) and a small playback chip ("▶ 42:15" / "⏸ 42:15") gated on `room.live !== null`. Reuse [StatusDot.vue](src/components/StatusDot.vue) for the live indicator.
- `src/stores/rooms.ts` — no shape change; `Room` typing carries through.
- `l10n/en.js` and `l10n/nl.js` — new strings: "{n} viewer", "{n} viewers", "Playing", "Paused", "Buffering", "Live state unavailable", "+{n} more". Both files updated in the same change with real Dutch.
- `docs/ws-protocol.md` — add a short section "Admin HTTP" documenting the `/admin/rooms/presence` endpoint, HMAC scheme, and the response shape (the Chrome extension does NOT use this; it's PHP-only, but operators and future client implementers benefit from it being in the protocol doc).
- `docs/ws-sync-server.md` — document the new config keys (`ws_admin_host`, `ws_admin_port`, `ws_admin_secret`), how to generate the secret (`openssl rand -hex 32`), and the systemd / proxy implications (admin port stays on `127.0.0.1` — never proxied).

### Not modified

- DB schema. No new tables, no new columns. Live state is intrinsically ephemeral; persistence would lie.
- Existing WS protocol message types or JOIN flow.
- Existing rooms response field names or types — strictly additive.

## Response shape

`GET /api/v1/rooms` (and analogous on `/rooms/{uuid}`):

```json
{
  "rooms": [
    {
      "uuid": "…", "name": "…", "targetUrl": "…",
      "createdAt": 1700000000000, "expiresAt": 1700090000000,
      "shareLink": "https://…",
      "live": {
        "connectedCount": 3,
        "clients": [
          { "clientId": "5c4df08c…", "isBuffering": false, "lastSeenMs": 1700000005000 },
          { "clientId": "9a7e1bf2…", "isBuffering": true,  "lastSeenMs": 1700000004500 }
        ],
        "playerState": "playing",
        "videoPos": 42.71,
        "contentIdentity": {
          "providerId": "netflix",
          "episodeId": "S01E03",
          "pageUrl": "https://www.netflix.com/watch/12345",
          "contentKey": "fc4…"
        },
        "lastActivityMs": 1700000005000
      }
    }
  ]
}
```

`live` is `null` when (a) the daemon couldn't be reached or (b) the room has zero clients ever joined and no content identity. `live` with `connectedCount: 0` and a non-null `contentIdentity` is valid — means the daemon knows the room but everyone left.

`GET /api/v1/rooms/{uuid}/clients` returns just `{ clients: [...], connectedCount: N }`.

## Reused patterns / utilities

- `serializeRoom` array-return pattern with optional enrichment (mirrors the way `password` is grafted onto `create()`'s response in [RoomController.php:73](lib/Controller/RoomController.php#L73)).
- `WsStatusController` graceful-degradation pattern (return `available: false` rather than 500 when something's wrong) — same idea applied to `live: null`.
- `IAppConfig` keys for daemon configuration — same as existing `ws_host` / `ws_port` / etc.
- `OCP\Http\Client\IClientService` for the loopback HTTP call (preferred over Guzzle direct — uses NC's HTTP stack and respects proxy config).
- Ratchet's `Http\HttpServer` + `Http\Router` (already a transitive dep via `cboden/ratchet`).
- `IHasher` / random_bytes for admin-secret generation (operator runs once, stores in `IAppConfig`).
- StatusDot atom for the live indicator on RoomCard (already used for expired rooms).

## Standards applied

- **backend/php-conventions** — `declare(strict_types=1)`, `OCP\` imports, attribute-based controller annotations, app-id const.
- **frontend/vue-conventions** — `@nextcloud/vue` components only, camelCase props, l10n in both `en.js` and `nl.js`, real Dutch (no copy-of-English).

## Tasks

### Task 1 — Save spec documentation

Create `agent-os/specs/2026-05-09-1900-rooms-api-live-state/`:
- `plan.md` — copy of this plan.
- `shape.md` — scope, decisions, the Q&A from this session (anonymous clientId-only identity, HTTP+HMAC bridge over shared cache / DB table, additive v1 fields, both list and detail surfaces).
- `standards.md` — full content of `agent-os/standards/backend/php-conventions.md` and `agent-os/standards/frontend/vue-conventions.md`.
- `references.md` — pointers to the prior spec (`agent-os/specs/2026-05-09-1700-ws-sync-server/`), [docs/ws-protocol.md](docs/ws-protocol.md), [OLD_CODE/server/src/types/room.ts](OLD_CODE/server/src/types/room.ts) for the `connectedClients: Map<ClientId, ClientConnection>` shape, and Nextcloud Talk's signaling-server backend protocol as the conceptual reference.
- `visuals/` — empty (UI changes are small enough to describe in text; no mockups needed).

### Task 2 — Daemon-side admin HTTP server

1. Add `lib/WebSocket/Admin/AdminAuthMiddleware.php`, `PresenceController.php`, `PresenceHttpServer.php`.
2. Add `lastActivityMs` to `RoomRuntime` (initialized to `createdAt`-equivalent, touched on `pushEvent` and on every heartbeat-handler call).
3. Wire `PresenceHttpServer` from `WsServe` against the same `LoopInterface`; bind to `ws_admin_host`/`ws_admin_port` (defaults `127.0.0.1`/`8766`).
4. Read `ws_admin_secret` from `IAppConfig`; if empty, log error at startup and refuse to start the admin server (WS server still runs).
5. Unit-test middleware (HMAC validation) and controller (registry → response shape, capping at 50 clients/room).
6. Smoke test: start daemon, `curl -H "X-PBSync-Admin: t=$(date +%s%3N),sig=$(echo -n "GET\n/admin/rooms/presence\n…" | openssl dgst -sha256 -hmac "$SECRET")" 'http://127.0.0.1:8766/admin/rooms/presence?uuids=…'` returns expected JSON.

### Task 3 — PHP-side presence client + enricher

1. Add `lib/Service/Dto/RoomLiveState.php`, `lib/Service/PresenceClient.php`, `lib/Service/RoomLiveStateEnricher.php`.
2. `PresenceClient` uses `IClientService` with 200 ms timeout, builds the HMAC header, parses JSON into `RoomLiveState[]`. On any failure path returns `[]` and logs `warning` once per request.
3. `RoomLiveStateEnricher::enrich(Room ...$rooms): array<string, ?RoomLiveState>` — single batched call.
4. Register both in `Application::register`.
5. Unit-test against a mocked `IClientService`: success, 401, timeout, malformed body, partial response (some uuids missing). Each must produce the stable graceful-degradation shape.

### Task 4 — Wire enrichment into RoomController + new clients endpoint

1. Inject `RoomLiveStateEnricher` into `RoomController`.
2. `index()`: fetch rooms → enrich in one batch → `serializeRoom($r, $liveByUuid[$r->getUuid()] ?? null)`.
3. `show()`: same, single-uuid batch.
4. `serializeRoom` — accept optional `?array $live`, set `'live' => $live` (always present in output, may be `null`).
5. Add `clients(string $uuid): DataResponse` controller method + `appinfo/routes.php` entry for `GET /rooms/{uuid}/clients`. Returns `{ clients, connectedCount }` only.
6. Update the route attribute / annotation block on each method so OpenAPI generation picks up the new optional fields.

### Task 5 — Frontend types + RoomCard rendering

1. Extend `Room` interface in [src/types/room.ts](src/types/room.ts) with optional `live: RoomLiveState | null` and the nested `RoomLiveState` shape.
2. [src/services/roomsApi.ts](src/services/roomsApi.ts): no behavioral change for `listRooms`/`createRoom`; add `getRoomClients(uuid)`.
3. [src/components/RoomCard.vue](src/components/RoomCard.vue): below the existing meta row, add a `<NcChip>`-style presence row showing up to 5 client chips (avatar-styled with stable color from clientId hash) plus `+{n} more`, and a playback chip with NcIconPlay/Pause + `videoPos` formatted as `mm:ss`. Both gated on `room.live !== null && room.live.connectedCount > 0`. Reuse [StatusDot.vue](src/components/StatusDot.vue) variant `success` to mark "live" rooms (vs. the existing `neutral`/`expired`).
4. Localize all new strings in both `l10n/en.js` and `l10n/nl.js`. Add real Dutch (e.g. "Bezig met spelen" for "Playing", "{n} kijker"/"{n} kijkers" for the plural).

### Task 6 — Documentation

1. `docs/ws-protocol.md` — append an "Admin HTTP" section: endpoint, HMAC scheme (with the canonical-string format), response shape, error codes (401, 400). Note that this is operator-internal; clients (browser extension, Vue) never call it.
2. `docs/ws-sync-server.md` — add a *Configuration* row each for `ws_admin_host`, `ws_admin_port`, `ws_admin_secret`. Add an *Operator setup* paragraph: how to generate the secret, why the admin port must stay on loopback, what happens if the secret is missing.

### Task 7 — End-to-end manual verification

In `nextcloud-docker-dev`:
1. `composer install`, `npm run build`, `occ app:enable playbacksync`, set `ws_admin_secret` via `occ config:app:set playbacksync ws_admin_secret --value=$(openssl rand -hex 32)`.
2. Start daemon: `occ playbacksync:ws-serve`. Verify both ports are listening (`ss -tln | grep -E '876[56]'`).
3. **No live state path:** with daemon stopped, `curl /api/v1/rooms` → every room has `"live": null`. UI shows static cards, no presence row, no errors in browser console.
4. **Live state path:** start daemon. Open the rooms page → cards show no presence yet (no clients connected). Open `websocat` to a room, `JOIN` correctly. Refresh rooms page → that card shows 1 client chip, "Playing 0:00" / "Paused 0:00".
5. **Multiple clients & playback:** open two `websocat` sessions; from one send `EVENT play`. Refresh rooms page → 2 clients, "Playing", `videoPos` advancing each refresh.
6. **Content identity:** in the JOIN message include `episodeId`/`providerId`/`pageUrl`. Refresh rooms page → card shows the `pageUrl` host or episode label.
7. **Dedicated endpoint:** `curl /api/v1/rooms/{uuid}/clients` returns the focused shape.
8. **HMAC failure:** `curl http://127.0.0.1:8766/admin/rooms/presence` (no header) → 401. With wrong secret → 401. With timestamp 60 s old → 401.
9. **Graceful degradation:** kill the daemon mid-session; refresh rooms page within 1 s. Cards transition to `"live": null` (no errors, single warn-log entry on the PHP side, not one per room).
10. **Run unit tests:** `vendor/bin/phpunit tests/Unit/WebSocket/Admin tests/Unit/Service` — all green. `npm run lint && npm run test:unit` — all green.

## Out of scope (explicitly deferred)

- WS-side push of presence changes to clients (`MEMBER_JOINED` / `MEMBER_LEFT` broadcasts) — current spec is REST-poll only, matching the rooms-page refresh model. Push lands when the rooms page itself becomes WS-reactive.
- Display names / avatars / NC user identity on connections — explicitly rejected by the identity model.
- Per-room admin / kick / mute endpoints — out of scope; this spec is read-only.
- Persisting last-known presence across daemon restarts.
- Compatibility with multi-instance / clustered daemons (single-daemon assumption holds; clustering would need a different bridge).

## Verification

End-to-end: see Task 7 above. Tests: `phpunit tests/Unit/WebSocket/Admin tests/Unit/Service` plus `npm run test:unit`. Lints: `npm run lint`, `composer lint` (or whatever the project uses).
