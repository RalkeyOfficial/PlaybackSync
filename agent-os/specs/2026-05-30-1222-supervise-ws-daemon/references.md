# References for Supervise the WS daemon

## Prior art

### Production install script

- **Location:** `scripts/install-ws-daemon.sh`
- **Relevance:** Already handles host-mode supervision (writes a systemd unit,
  `Restart=on-failure`/`RestartSec=5`) and, in Docker mode, *prints* a rough sidecar
  block (`restart: unless-stopped`, `network_mode: service:nextcloud`).
- **Key patterns:** the netns-share (`network_mode: service:nextcloud`) and
  `restart: unless-stopped` shape this spec turns into a complete, version-controlled
  `docker-compose.ws.example.yml`.

### Operator guide

- **Location:** `docs/ws-sync-server.md` §"Starting the daemon", §Docker, §"Operational notes"
- **Relevance:** Documents the four supervision strategies and explicitly flags bare
  `docker exec -d` as temporary. The §Docker and §Docker Compose subsections are expanded here.

## Architectural constraints

### Loopback admin bridge

- **Location:** `lib/Service/AdminKickClient.php`, `lib/WebSocket/Admin/PresenceHttpServer.php`
- **Relevance:** The PHP request layer reaches the daemon's HMAC admin HTTP at
  `ws_admin_host:ws_admin_port` (default `127.0.0.1:8766`). The docs forbid exposing that
  port. → daemon + PHP-FPM must share loopback → netns-share is the required Docker topology.

### Daemon entrypoint

- **Location:** `lib/Command/WsServe.php`
- **Relevance:** Builds `React\EventLoop\Loop::get()` + Ratchet `IoServer`, calls
  `$server->run()` (blocks). No signal handling today. The SIGTERM/SIGINT handler is added
  to `execute()`. `Tick` (`lib/WebSocket/Tick.php`) has no `stop()`; `$loop->stop()` halts
  its periodic timer, so no `Tick` change is needed.

### Binding configuration (source of truth)

- **Location:** `lib/Settings/SettingsDefaults.php`, `lib/Migration/EnsureDefaultSettings.php`,
  `src/views/AdminSettings.vue` §"Daemon binding"
- **Relevance:** `ws_host` (`127.0.0.1`), `ws_port` (`8765`), `ws_admin_port` (`8766`) are
  set in the admin UI and seeded on install/upgrade. `WsServe.php` falls back to these when
  `--host`/`--port` aren't passed — which is why the compose `command:` omits the flags.

## Environment facts (dev)

- Container `master-nextcloud-1`, compose project `master`, volumes `master_config` / `master_data`.
- `.env`: `PHP_VERSION=84` → image `ghcr.io/juliusknorr/nextcloud-dev-php84:latest`.
- The dev image's `bootstrap.sh` entrypoint is destructive → the sidecar overrides `entrypoint`.
- `react/event-loop` v1.6.0 + `ext-pcntl` present → `$loop->addSignal()` is supported.
