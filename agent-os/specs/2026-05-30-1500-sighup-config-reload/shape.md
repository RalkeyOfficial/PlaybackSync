# SIGHUP config-reload — Shaping Notes

## Scope

Let the WebSocket daemon re-read its tunable parameters from `IAppConfig` **in place** —
no socket teardown, no client reconnect — so changing drift thresholds / timeouts /
rate limits / `max_clients_per_room` doesn't require the ~1–2 s restart blip. Two triggers:
`SIGHUP` (ops/CLI) and a `POST /admin/reload` admin route (web-native, so the admin
settings UI can apply tuning changes on save). Last open item in `EXTENSION_TODO.md`.

## Decisions

- **Both triggers** (user-confirmed): `SIGHUP` handler in `WsServe` **and** `POST /admin/reload`
  on the daemon's admin server, both funnelling through one daemon-side `ReloadController`.
- **`maxClientsPerRoom` refactored to live-read** from `WsConfig` (user-confirmed) so it
  reloads too.
- **Restart-only (documented, not hot-reloaded):** binding keys (`ws_host`/`ws_port`/
  `ws_admin_*`) and `ws_admin_secret` (can't rebind a live socket); `ws_event_log_size`
  (baked into each `RoomRuntime` at creation). Rate-limit changes apply to **new
  connections only** (per-client `RateLimiter` is built at JOIN).
- **Mechanism:** `WsConfig` keeps its positional 11-int constructor (4 test files build it
  that way) — drop `readonly`, add `reloadFrom(IAppConfig): array` returning the changed-keys
  map. It's a DI singleton, and the hot-path consumers (`MessageRouter`, `Tick`,
  `HeartbeatHandler`, `KickController`) already read live off it, so refreshing that one
  instance updates them all.
- **Apply-on-save:** the admin UI fires `reloadDaemon()` after a successful `wsTuning` or
  `rooms` save (the sections with daemon-read keys), best-effort — never blocks the save.
  Daemon binding keeps its existing restart prompt.
- **Event log:** record a `daemon_config_reloaded` admin event (safe — reload does **not**
  wipe the in-memory log, unlike restart).

## Context

- **Visuals:** None.
- **References:** the restart-button feature (commit a9c57f2) — `AdminRestartClient`,
  `AdminSettingsController::restartDaemon()`, `PresenceHttpServer` `POST /admin/restart`,
  the admin-settings store/UI flow — is the direct template. `WsConfig` consumers traced in
  `references.md`.
- **Product alignment:** roadmap §"Phase 2" (daemon + loopback admin bridge); the TODO's
  optional `SIGHUP` companion to the supervision/restart work.

## Standards Applied

- **backend/php-conventions** — `WsConfig`, `ReloadController`, `AdminReloadClient`,
  `DaemonReloadFailedException`, the controller action: strict types, `OCP\` imports,
  meaningful PHPDoc, no SPDX/author headers.
- **frontend/vue-conventions** — the `reloadDaemon()` store action + apply-on-save wiring;
  every string via `t('playbacksync', …)` in both `l10n/en.js` and `l10n/nl.js`.
