# WS daemon healthcheck — Shaping Notes

## Scope

Add a daemon-side `GET /healthz` and a PHP-side `GET /api/v1/health` passthrough so operators (and external probes via Nextcloud) can confirm the WebSocket sync daemon is alive and processing rooms. Closes the highest-value parity gap from `MISSING_FEATURES.md`.

## Decisions

- **Mount point**: daemon `/healthz` lives on the existing admin HTTP server (`PresenceHttpServer`, loopback-only on `ws_admin_port`). Mirrors the precedent set by the kick endpoint — one extra HTTP server beside the WS port would be needless.
- **Auth**: `/healthz` is **unauthenticated** as a single-path carve-out before `AdminAuthMiddleware::verify()`. Safe because the admin port is loopback-bound. The carve-out is explicit (`if ($method === 'GET' && $path === '/healthz')`), not an allowlist mechanism — easier to audit later.
- **Existing admin-server gate stays**: the daemon's admin port still only binds when `ws_admin_secret` is configured. When the secret is unset, `/healthz` is unreachable and PHP `/api/v1/health` reports `daemon.reachable=false` — that's an honest signal, not a regression.
- **Response body**: counts and timings only. No room UUIDs, no client IDs, no IPs, no secrets, no event-log content. The PHP layer wraps it with a reachability probe (`reachable`, `latency_ms`, `error`).
- **HTTP semantics**: PHP `/api/v1/health` always returns 200. Non-2xx from a healthcheck is a worse signal than a 200 with `status: degraded` — load balancers and humans alike misread it.
- **PHP route auth**: `#[PublicPage]` + `#[NoCSRFRequired]`. The body contains no sensitive data, and probes can't be expected to authenticate.
- **Daemon version**: read from `IAppManager::getAppVersion('playbacksync')` once at daemon boot, captured in `WsServe::execute()`. Avoids re-reading on every request.
- **Tick liveness**: `Tick` records the wall-clock ms at the end of each periodic run. `tick.running = (now - lastTick) < 5000` (5× the 1 s tick interval — generous for a logger I/O hiccup, tight enough to flag a stuck loop).

## Context

- **Visuals:** None.
- **References studied:**
  - `lib/Command/WsServe.php` — daemon bootstrap & admin-server gate.
  - `lib/WebSocket/Admin/PresenceHttpServer.php` — existing HTTP dispatcher.
  - `lib/WebSocket/Admin/KickController.php` — structural precedent (pure value transform).
  - `lib/Service/PresenceClient.php` — structural precedent for the PHP-side loopback client (graceful failure, 200 ms timeout).
  - `lib/Service/AdminKickClient.php` — sibling pattern, but raises exceptions; we follow `PresenceClient`'s graceful-degradation style instead because healthcheck callers don't want exceptions either.
- **Product alignment:** `MISSING_FEATURES.md` recommendation §1 ("Healthcheck on the WS daemon — useful regardless, trivial to add"). No conflict with `agent-os/product/roadmap.md`.

## Standards Applied

- `backend/php-conventions` — strict types, OCP-only imports, attribute-style controller annotations (`#[PublicPage]`, `#[NoCSRFRequired]`).

## Non-goals

- Prometheus `/metrics`.
- `/readyz` split.
- Admin-UI dashboard widget.
- Surfacing per-room or per-client identifiers in the response body.
