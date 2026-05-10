# PlaybackSync — WS daemon `/healthz` + PHP `/api/v1/health` passthrough

## Context

`MISSING_FEATURES.md` flags the WS-daemon healthcheck as a gap and recommends it as the highest-value parity item with the OLD design ("useful regardless, trivial to add"). PlaybackSync already runs a long-lived daemon via `occ playbacksync:ws-serve`; today there's no way for an operator (or a docker/k8s probe, or a Nextcloud admin UI) to confirm the daemon is alive and processing rooms without opening a WebSocket.

Goal: expose a minimal, non-sensitive liveness + light-stats endpoint on the daemon, and a `#[PublicPage]` PHP passthrough so external probes can reach it through Nextcloud's normal HTTP surface.

## Approach

- Mount `GET /healthz` on the existing admin HTTP server (`PresenceHttpServer`, loopback-only on `ws_admin_port`).
- Skip HMAC auth for this single route. Safe because the admin port is loopback-bound and the response body contains no sensitive identifiers.
- Add PHP `HealthController` exposing `GET /api/v1/health` as `#[PublicPage]`. It loopback-calls the daemon's `/healthz` and surfaces a merged response so admins/probes can hit it through the Nextcloud webroot.
- Capture daemon start time at boot so `uptime_seconds` is real, not derived.
- Leave the existing `ws_admin_secret` gate on the admin-server boot in place (no behavior change). When the secret is unset the daemon's admin port is not bound at all, so PHP `/api/v1/health` cleanly reports `daemon.reachable=false` — that is itself a useful signal.

### Daemon response shape (`GET /healthz`, 200)

Counts and timings only — no UUIDs, no client IDs, no IPs, no secrets, no room names.

```json
{
  "status": "ok",
  "daemon_version": "0.3.0",
  "uptime_seconds": 12345,
  "timestamp_ms": 1715339000000,
  "rooms": { "active": 4 },
  "clients": { "connected": 11 },
  "tick": { "running": true, "last_tick_ms_ago": 982 }
}
```

### PHP response shape (`GET /api/v1/health`, 200)

Wraps the daemon response and adds a reachability probe:

```json
{
  "status": "ok",
  "daemon": { "reachable": true, "latency_ms": 3, "body": { "...": "<daemon body>" } }
}
```

If the loopback call fails, return `200 { "status": "degraded", "daemon": { "reachable": false, "error": "<short reason>" } }` — a healthcheck that 5xxs is itself a worse signal than one that reports degradation.

## Critical files

### Read / reference (not modified)
- `lib/WebSocket/Admin/KickController.php` — structural precedent for new `HealthController`.
- `lib/Service/AdminKickClient.php`, `lib/Service/PresenceClient.php` — structural precedent for new PHP-side `HealthClient`.
- `lib/WebSocket/RoomRegistry.php` — `all()` for active room count.
- `lib/WebSocket/RoomRuntime.php` — `clientCount()` summed across rooms.
- `lib/WebSocket/WsConfig.php` — config snapshot for ports/host.
- `appinfo/info.xml` — source for `daemon_version` (read via `IAppManager::getAppVersion`).

### To create
- `lib/WebSocket/Admin/HealthController.php`
- `lib/Service/HealthClient.php`
- `lib/Controller/HealthController.php`
- `tests/Unit/WebSocket/Admin/HealthControllerTest.php`
- `tests/Unit/Controller/HealthControllerTest.php`

### To modify
- `lib/WebSocket/Admin/PresenceHttpServer.php` — register `GET /healthz` route, bypass HMAC on that path only.
- `lib/Command/WsServe.php` — capture `startedAtMs`, build `HealthController`, hand it to `PresenceHttpServer` via setter.
- `lib/WebSocket/Tick.php` — record `lastTickMs` on every tick; expose getter.
- `appinfo/routes.php` — add `health#index` route.
- `docs/api.md` — document `GET /api/v1/health`.
- `docs/ws-sync-server.md` — document daemon `GET /healthz`.

## Tasks

1. **Spec docs** — this folder.
2. **Daemon `HealthController`** — pure value transform: `health(int $nowMs): array`. Iterates `RoomRegistry::all()` for room/client counts; reads `Tick::lastTickMs()` for tick freshness (`tick.running = (now - lastTick) < 5000`).
3. **Route + auth bypass** in `PresenceHttpServer`: explicit early `if ($method === 'GET' && $path === '/healthz')` *before* the HMAC verify. Single carve-out, not a general allowlist.
4. **Boot wiring** in `WsServe::execute()`: capture `$startedAtMs`, read app version via `IAppManager`, instantiate `HealthController`, hand to `PresenceHttpServer` via `setHealthController()`. Add `lastTickMs` recording in `Tick::runOnce()`.
5. **PHP `HealthClient`** — mirrors `PresenceClient` (loopback HTTP, 200 ms timeout, no exceptions to caller). No HMAC header (daemon `/healthz` is unauthenticated).
6. **PHP `HealthController` + route** — `index(): JSONResponse` annotated `#[PublicPage]` + `#[NoCSRFRequired]`. Always HTTP 200; status field reports `ok`/`degraded`.
7. **Docs** — `api.md`, `ws-sync-server.md`.
8. **Tests** — unit coverage for both controllers (counts; reachable/unreachable/non-ok daemon).

## Verification (end-to-end)

1. `composer run cs:fix && composer run psalm && composer run test:unit` — all pass.
2. Boot the dev stack; run `occ playbacksync:ws-serve` in foreground.
3. `curl -s http://127.0.0.1:8766/healthz | jq` → `status: ok`, sane counts and uptime.
4. `curl -s -X POST http://127.0.0.1:8766/healthz -i` → 405 (only GET routed).
5. `curl -s https://<nc>/index.php/apps/playbacksync/api/v1/health | jq` → `status: ok`, `daemon.reachable: true`.
6. Stop the daemon, retry the PHP route → `status: degraded`, `daemon.reachable: false`, HTTP still 200.
7. Open a room with two browser tabs, retry both endpoints → counts increment to match.
8. `grep -RIn 'X-PBSync-Admin' lib/WebSocket/Admin/PresenceHttpServer.php` — confirm the healthz path was *not* gated by the HMAC check (regression guard).

## Out of scope

- Prometheus `/metrics` (separate item in `MISSING_FEATURES.md`).
- Readiness/liveness split (`/readyz`).
- Per-room detail in the response — aggregate counts only.
- Admin-UI dashboard widget consuming the new endpoint.
- Graceful-shutdown / `SERVER_SHUTDOWN` semantics — separate item.
