# SIGHUP config-reload for the WS daemon

## Context

Changing a WebSocket tuning value today only takes effect after a full daemon restart (a ~1–2 s reconnect blip). This adds a **zero-downtime config reload**: the daemon re-reads its tunables from `IAppConfig` in place. Two triggers: `SIGHUP` (ops/CLI) and `POST /admin/reload` (web-native, reusing the `/admin/restart` plumbing so the admin UI can apply tuning on save). Sibling to the restart button (commit a9c57f2).

### Why it's cheap (verified)
`WsConfig` is a single DI-singleton; hot-path consumers (`MessageRouter`, `Tick`, `HeartbeatHandler`, `KickController`) already read live off it, so refreshing that one instance updates them. Exceptions: `PresenceController` captures `maxClientsPerRoom` at boot (→ refactor to live-read); `eventLogSize` is baked per-room (→ restart-only); per-client `RateLimiter`s are built at JOIN (→ new connections only); binding keys + `ws_admin_secret` need a restart (→ not reloaded).

### Mechanism
`WsConfig` keeps its positional 11-int constructor (4 test files use it) — drop `readonly`, add `reloadFrom(IAppConfig): array` (changed-keys map). Both triggers funnel through one daemon-side `ReloadController`.

## Tasks

1. **Spec docs** — this folder.
2. **WsConfig refreshable** — `lib/WebSocket/WsConfig.php`: drop `readonly`; private static `read(IAppConfig): array` shared by `fromAppConfig` (positional ctor unchanged) and a new `reloadFrom(IAppConfig): array` (reassign props, return changed map).
3. **maxClients live-read** — `lib/WebSocket/Admin/PresenceController.php` ctor takes `WsConfig`, reads `$this->config->maxClientsPerRoom` live. Update `Application.php` registration + `PresenceControllerTest` (pass a `WsConfig`).
4. **Daemon reload** — new `lib/WebSocket/Admin/ReloadController.php` (`reload(): array` → `WsConfig::reloadFrom` + log changed); `PresenceHttpServer` `POST /admin/reload` (`RELOAD_ROUTE`); `WsServe` `$loop->addSignal(SIGHUP, …)`.
5. **PHP client/controller/route** — `AdminReloadClient` + `DaemonReloadFailedException` (mirror restart); `AdminSettingsController::reloadDaemon()` (502 on failure, record `daemon_config_reloaded` event, return `{status, changed}`); route `admin_settings#reloadDaemon → POST /api/v1/admin/ws/reload`.
6. **Frontend apply-on-save** — `reloadDaemon()` api + store action (best-effort: success toast / restart-may-be-needed warning); fire after a successful `wsTuning` and `rooms` save. Binding keeps its restart prompt.
7. **l10n** — applied-success toast + restart-may-be-needed warning in `en.js` + `nl.js`.
8. **Docs** — `ws-sync-server.md` (route list → seven; reload-vs-restart subsection; SIGHUP via `docker kill -s HUP`/`kill -HUP`; systemd `ExecReload`); `configuration.md` (hot-apply vs restart-only).

## Verification
- PHP `php -l` + `phpunit` (new tests: `WsConfig::reloadFrom` change detection + binding keys untouched, `ReloadController`, `AdminSettingsController::reloadDaemon` 200/502, updated `PresenceControllerTest`).
- `npx eslint` + `npm run dev`.
- E2E: `occ config:app:set … ws_drift_nudge_threshold_ms 400` → `docker kill -s HUP playbacksync-ws` → log shows `config reloaded (changed: …)`, `/healthz uptime_seconds` keeps climbing (not restarted). HMAC `POST /admin/reload` → 200 `{changed}`. UI tuning Save → "applied" toast, no reconnect.

## Standards
- backend/php-conventions, frontend/vue-conventions (see `standards.md`).

## Non-goals
- Hot-reloading binding keys / `ws_admin_secret` / `ws_event_log_size`; refreshing existing clients' rate limiters.
