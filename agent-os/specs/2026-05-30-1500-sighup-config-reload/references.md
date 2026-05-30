# References for SIGHUP config-reload

## Direct template — the restart-button feature (commit a9c57f2)

The reload path mirrors the restart path almost 1:1:

- `lib/Service/AdminRestartClient.php` + `lib/Service/Exceptions/DaemonRestartFailedException.php`
  → mirror as `AdminReloadClient` + `DaemonReloadFailedException` (HMAC `POST /admin/reload`).
- `lib/WebSocket/Admin/PresenceHttpServer.php` `POST /admin/restart` branch (responds, then
  acts) → add a `POST /admin/reload` branch that calls `ReloadController::reload()`.
- `lib/Command/WsServe.php` SIGTERM/SIGINT `$loop->addSignal(...)` block → add `SIGHUP`.
- `lib/Controller/AdminSettingsController.php::restartDaemon()` + route
  `admin_settings#restartDaemon` → mirror as `reloadDaemon()` + `admin_settings#reloadDaemon`.
- `src/services/adminSettingsApi.ts::restartDaemon()`, `src/stores/adminSettings.ts`
  `restartDaemon()` (flag + toasts), `src/views/AdminSettings.vue` restart wiring → mirror
  for reload (but apply-on-save, no confirm dialog — reload is non-disruptive).

## Config plumbing (what reload must touch)

- `lib/WebSocket/WsConfig.php` — the singleton tunables snapshot. Make refreshable
  (`reloadFrom`). Consumers reading **live** (pick up changes for free): `MessageRouter`
  (`joinTimeoutMs`, `tombstoneMs`), `Tick` (`idleCloseMs`), `HeartbeatHandler` (drift ×3),
  `KickController` (`kickBlockMs`).
- `lib/WebSocket/Admin/PresenceController.php` — captures `maxClientsPerRoom` as a boot
  scalar; refactor to read `$this->config->maxClientsPerRoom` live. DI registration in
  `lib/AppInfo/Application.php`; tests in `tests/Unit/WebSocket/Admin/PresenceControllerTest.php`.
- `lib/WebSocket/RoomRegistry.php` / `RoomRuntime` — `eventLogSize` baked per-room at
  creation → **restart-only**, do not attempt to hot-apply.
- `lib/WebSocket/Handler/JoinHandler.php` — builds per-client `RateLimiter`s at JOIN →
  rate-limit changes apply to **new connections only**.

## Docs to update

- `docs/ws-sync-server.md` §"Admin HTTP setup" (route list), the systemd unit (`ExecReload`),
  and a new reload-vs-restart subsection.
- `docs/configuration.md` — which keys hot-apply vs need a restart.
