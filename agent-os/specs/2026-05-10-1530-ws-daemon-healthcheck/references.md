# References for WS daemon healthcheck

## Similar Implementations

### Daemon admin route (the kick endpoint)

- **Location:** `lib/WebSocket/Admin/KickController.php`, `lib/WebSocket/Admin/PresenceHttpServer.php`
- **Relevance:** The existing admin HTTP server is exactly where `/healthz` mounts. `KickController` is the structural template for `HealthController` — small class, one public method, no I/O of its own.
- **Key patterns:** controller takes the registry/runtime in the constructor, returns a small result struct (or array) the HTTP layer maps to a response.

### Loopback admin bridge (PHP → daemon), graceful-failure variant

- **Location:** `lib/Service/PresenceClient.php`
- **Relevance:** New `HealthClient` is a sibling. Same `IClientService`, same `'nextcloud' => ['allow_local_address' => true]` flag, same `200 ms` timeout. The healthcheck must NOT raise exceptions to its caller — `PresenceClient`'s warn-and-return-empty pattern is exactly the right shape, and `AdminKickClient`'s exception-raising sibling is explicitly the wrong fit.
- **Key patterns:** read `ws_admin_host` / `ws_admin_port` from `IAppConfig`; one warn-log per failure mode; do not throw.

### Public PHP route + attribute-style controller annotations

- **Location:** `lib/Controller/RoomController.php`, `lib/Controller/WsStatusController.php`
- **Relevance:** Confirms in-repo precedent uses `#[NoAdminRequired]` etc. as PHP 8 attributes (not PHPDoc tags). New `HealthController::index` uses `#[PublicPage]` and `#[NoCSRFRequired]` for the same reason — probes can't authenticate.

### Periodic loop with timestamp recording

- **Location:** `lib/WebSocket/Tick.php`
- **Relevance:** `Tick` already runs once per second. Adding a `lastTickMs` field + getter is a one-line change; `HealthController` reads it to set `tick.running`.

### Daemon-only services constructed in `WsServe::execute()`

- **Location:** `lib/Command/WsServe.php` `maybeStartAdminServer()`
- **Relevance:** Precedent for instantiating daemon-scoped objects (sockets, HTTP servers) inside `execute()` rather than via container auto-wiring. `HealthController` is built the same way so we can capture the daemon's `startedAtMs` accurately.
