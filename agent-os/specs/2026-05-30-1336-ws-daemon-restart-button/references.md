# References for Admin "restart the WS daemon" button

## Backend — mirror these

### Loopback admin client + exception
- **Location:** `lib/Service/AdminKickClient.php`, `lib/Service/Exceptions/KickFailedException.php`
- **Relevance:** `AdminRestartClient` + `DaemonRestartFailedException` are direct siblings.
- **Key patterns:** read `ws_admin_secret`/`ws_admin_host`/`ws_admin_port`; canonical
  `"POST\n{path}\n{nowMs}"`, HMAC-SHA256, header `X-PBSync-Admin: t=…,sig=…`;
  `IClientService::newClient()->post()` with `nextcloud => ['allow_local_address' => true]`,
  `http_errors => false`; `200` → return, else/transport → throw domain exception.
  (`AdminRestartClient` uses a ~1 s timeout vs the kick client's 0.2 s for connect margin.)

### Daemon route dispatch
- **Location:** `lib/WebSocket/Admin/PresenceHttpServer.php::onOpen()`
- **Relevance:** add `POST /admin/restart` after the `AdminAuthMiddleware::verify()` HMAC check.
- **Key patterns:** exact-path match (cf. `HEALTH_ROUTE`), `respond($conn, 200, ['result' => …])`
  (JSON, `Connection: close`, closes). The handler also `Loop::get()->addTimer(0.25, fn => Loop::get()->stop())` —
  `Loop::get()` is the same singleton `WsServe` runs (see `lib/Command/WsServe.php`).

### Controller precedent
- **Location:** `lib/Controller/AdminSettingsController.php::regenerateAdminSecret()`
- **Relevance:** `restartDaemon()` mirrors a destructive admin action. Maps transport failure
  to `Http::STATUS_BAD_GATEWAY` (precedent: `RoomController` kick handling). Admin+CSRF by default.
- **Route:** `appinfo/routes.php` (cf. `admin_settings#regenerateAdminSecret → POST /api/v1/admin/settings/secret`).

### Poll target
- **Location:** `lib/Controller/WsStatusController.php` → `GET /api/v1/ws/status`
- **Relevance:** returns `{available: bool, reason}`; frontend polls until `available === true`.

## Frontend — mirror these

### Destructive-action button + confirm + spinner
- **Location:** `src/views/AdminSettings.vue` (regenerate-secret: button lines ~167–177,
  `NcDialog` ~207–227, `confirmRegenerate`/`onConfirmOpenChange` ~431–449).
- **Relevance:** the Restart button + confirm dialog copy this shape; `store.restarting`
  drives the spinner like `store.regenerating`.

### Store action + API + status store
- **Locations:** `src/stores/adminSettings.ts` (`regenerateSecret()`/`saveSection()`,
  `showSuccess`/`showError`, flag pattern), `src/services/adminSettingsApi.ts` (axios +
  `generateUrl`), `src/stores/wsStatus.ts` (`load()`), `src/services/wsStatusApi.ts`
  (`fetchWsStatus`).
- **Relevance:** `restartDaemon()` lives in the admin store, POSTs via a new `restartDaemonWs()`,
  then polls `fetchWsStatus()` and refreshes the wsStatus store so the badge updates.
