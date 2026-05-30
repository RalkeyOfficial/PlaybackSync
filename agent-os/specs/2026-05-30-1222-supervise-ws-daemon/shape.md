# Supervise the WS daemon (dev + production container) — Shaping Notes

## Scope

Replace the unsupervised dev launcher for the PlaybackSync WebSocket daemon with a
supervised compose sidecar, give the daemon a graceful shutdown path, and ship a
production compose-service template so hosters get a containerized supervised daemon
instead of a bare-metal systemd process.

Three deliverables:
1. **Dev sidecar** — `docker-compose.ws.yml` in the app repo (`restart: unless-stopped`
   + `/healthz` healthcheck); `start-ws-server` rewritten to drive it.
2. **Graceful shutdown** — a SIGTERM/SIGINT handler in `lib/Command/WsServe.php` that
   stops the ReactPHP loop and exits 0 (also the prerequisite for the future admin
   "restart the WS daemon" button).
3. **Production template** — parameterized `docker-compose.ws.example.yml` + an expanded
   `docs/ws-sync-server.md` §Docker Compose section.

## Decisions

- **Dev compose lives in the app repo**, not the shared `nextcloud-docker-dev/docker-compose.yml`.
  Version-controlled with the app, survives env resets, doesn't touch shared infra.
- **SIGTERM (+ SIGINT) only this round.** No SIGHUP config-reload — deferred.
- **Production is a copy/adapt template, not a standalone image.** The daemon is an `occ`
  command and needs the full Nextcloud codebase + `config.php` (DB creds) to boot, so the
  realistic artifact reuses the hoster's own image + volumes — structurally identical to
  Nextcloud's own `cron` sidecar. A self-contained daemon image is out of scope.
- **netns-sharing is the recommended Docker topology** (`network_mode: container:` in dev,
  `service:<nc-app>` in prod). The admin bridge (`AdminKickClient` → daemon `127.0.0.1:8766`)
  requires the PHP layer and the daemon to share loopback; a standalone service on the
  network would break it unless the admin port is exposed (forbidden by the security guidance).
- **Binding stays in admin settings, not compose.** `command:` is just `playbacksync:ws-serve`
  with no `--host`/`--port`; the daemon reads `ws_host`/`ws_port` from the admin "Daemon
  binding" section (seeded by `EnsureDefaultSettings` to `127.0.0.1`/`8765`/`8766`). The old
  launcher's `--host=0.0.0.0` is dropped because it shadowed the admin setting.
- **`/healthz` healthcheck on both** dev and prod compose files.

## Context

- **Visuals:** None.
- **References:**
  - `scripts/install-ws-daemon.sh` — prior art for prod supervision (systemd unit + a
    rough Docker sidecar block it *prints*). This spec turns that into a real artifact + docs.
  - `docs/ws-sync-server.md` §"Starting the daemon" / §Docker — the operator guide updated here.
  - `lib/Service/AdminKickClient.php` + `lib/WebSocket/Admin/PresenceHttpServer.php` — the
    HMAC loopback admin bridge that dictates the netns-share requirement.
  - `lib/Command/WsServe.php` — daemon entrypoint; reads `ws_host`/`ws_port` from `IAppConfig`,
    builds the ReactPHP loop, no signal handling today.
  - `lib/Settings/SettingsDefaults.php` + `lib/Migration/EnsureDefaultSettings.php` +
    `src/views/AdminSettings.vue` §"Daemon binding" — the `ws_host`/`ws_port`/`ws_admin_port`
    source of truth, seeded on install/upgrade.
- **Product alignment:** roadmap §"Phase 2" (WebSocket sync daemon, loopback admin bridge,
  healthcheck). Supervision is the operational gap; the `EXTENSION_TODO.md` "Other changes"
  section frames it as the prerequisite for the admin restart button (Design A).

## Standards Applied

- **backend/php-conventions** — applies to the `WsServe.php` edit: `declare(strict_types=1)`
  already present, only `OCP\` imports, meaningful PHPDoc, no SPDX/author headers. This is
  the only standard that applies; the rest of the change is compose/docs.
