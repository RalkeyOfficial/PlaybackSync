# Supervise the WS daemon (dev + production container)

## Context

The PlaybackSync WebSocket daemon is launched today by [start-ws-server](../../../start-ws-server) — a bare `docker exec -u www-data -d master-nextcloud-1 … occ playbacksync:ws-serve`. It has **no supervision**: if it crashes or the container restarts, it stays dead until someone re-runs the command by hand (this is why the daemon was down after a `down -v`). The daemon also has **no signal handling at all**, so any stop is an abrupt SIGKILL.

This work:
1. Replaces the bare dev launcher with a **supervised sidecar** (`restart: unless-stopped` + `/healthz` healthcheck) so the dev daemon survives crashes and container restarts.
2. Adds a **graceful SIGTERM/SIGINT shutdown** to the daemon (also the prerequisite for the future admin "restart the WS daemon" button — Design A in `EXTENSION_TODO.md`).
3. Ships a **production compose service template** (`docker-compose.ws.example.yml`) so hosters get a supervised, containerized daemon instead of a bare-metal systemd process — plus an expanded `docs/ws-sync-server.md` §Docker Compose section.

### Why the daemon is a *sidecar*, not a standalone image
`playbacksync:ws-serve` is an `occ` command: it boots through Nextcloud's DI container and reads all config from `IAppConfig` (the Nextcloud DB), so it needs the **full Nextcloud codebase + `config.php`** to run. A self-contained daemon image pointed at "just a DB" is not feasible without major decoupling. The realistic, idiomatic artifact is a second compose service that **reuses the hoster's own Nextcloud image and volumes** — structurally identical to Nextcloud's own `cron` sidecar.

### The loopback constraint (drives the networking choice)
The PHP request layer (`lib/Service/AdminKickClient.php`) reaches the daemon's admin HTTP at `ws_admin_host:ws_admin_port` (default `127.0.0.1:8766`), and the docs state that port must **never** be exposed on the network. So the daemon and the PHP-FPM process must **share loopback**. In Docker that means the daemon shares the Nextcloud app container's network namespace — `network_mode: "container:…"` (dev, non-compose-managed target) or `network_mode: "service:<nc-app>"` (prod compose). A standalone daemon service on the network would break the admin bridge unless `8766` is exposed (against the security guidance) — so netns-sharing is the recommended topology, and it makes both an in-app proxy (`127.0.0.1:8765`) and a separate proxy container (`<nc-service>:8765`) work.

### Decisions (confirmed with user)
- Ship a self-contained `docker-compose.ws.yml` **inside the app repo** for dev; rewrite `start-ws-server` to drive it. Do **not** edit the shared `/home/ralkey/nextcloud-docker-dev/docker-compose.yml`.
- Add a **SIGTERM** (+ SIGINT for foreground) graceful-drain handler to the daemon. No SIGHUP this round.
- Production delivered as a **parameterized `docker-compose.ws.example.yml`** (placeholders for image/volumes/app-service-name, netns-share default, `/healthz` healthcheck, both proxy topologies as comments) **plus expanded docs**. No standalone daemon image.
- Add the `/healthz` Docker healthcheck to **both** the dev and prod compose files.

### Key facts (verified)
- Container `master-nextcloud-1`, compose project `master`; named volumes `master_config`, `master_data`.
- `.env`: `PHP_VERSION=84` → image `ghcr.io/juliusknorr/nextcloud-dev-php84:latest` (NOT 82). The sidecar image tag **must** match so `occ` + extensions (incl. `ext-pcntl`) behave identically.
- The image's `bootstrap.sh` entrypoint is **destructive** (rewrites Apache, `chown -R`s shared volumes, can trigger auto-install) → the sidecar **must override `entrypoint`** and run only `php occ`.
- Apache's `mod_proxy_wstunnel` rule forwards `/apps/playbacksync/ws/` → `127.0.0.1:8765` (loopback inside the NC container's netns) → the daemon **must** run in that netns, so `network_mode: "container:master-nextcloud-1"` is mandatory (and forbids `ports:`/`networks:` on the sidecar).
- Admin server only binds if `ws_admin_secret` is set (auto-generated on enable) — `/healthz` is its single unauthenticated route, so the healthcheck needs no secret but does need the admin server up.
- `react/event-loop` v1.6.0 + `ext-pcntl` present → `$loop->addSignal()` works; do not use raw `pcntl_signal`.
- `Tick` (`lib/WebSocket/Tick.php`) has no `stop()`; `$loop->stop()` halts its periodic timer — sufficient for clean exit.
- An old `docker exec -d` daemon may still hold `8765`/`8766` in the shared netns → must be killed before the sidecar can bind.
- `scripts/install-ws-daemon.sh` (Docker mode) already *prints* a rough sidecar block — the gap this fills is a complete, version-controlled artifact + full docs.

---

## Task 1: Save spec documentation

Create `agent-os/specs/2026-05-30-1222-supervise-ws-daemon/` with `plan.md`, `shape.md`, `standards.md`, `references.md` (no visuals).

## Task 2: Add graceful SIGTERM/SIGINT handler to the daemon

Edit `lib/Command/WsServe.php` `execute()`. After `$loop = Loop::get();` (and before `$server->run()`), register a shared shutdown closure on both signals:

```php
$shutdown = function (int $signal) use ($loop, $output): void {
    $name = $signal === SIGINT ? 'SIGINT' : 'SIGTERM';
    $output->writeln(sprintf('<info>Received %s, shutting down WS daemon...</info>', $name));
    $this->logger->info('[playbacksync ws] received ' . $name . ', stopping event loop');
    $loop->stop(); // halts Tick's periodic timer + IoServer; $server->run() returns
};
$loop->addSignal(SIGTERM, $shutdown);
$loop->addSignal(SIGINT, $shutdown);
```

`$loop->stop()` lets `$server->run()` return so `execute()` returns `Command::SUCCESS` (exit 0). No new imports; no `Tick` change.

## Task 3: Add `docker-compose.ws.yml` at the app root (dev sidecar)

`entrypoint` override, `network_mode: container:master-nextcloud-1`, no `ports:`/`networks:`, external `master_*` volumes, `stop_signal: SIGTERM` + `stop_grace_period`, `/healthz` healthcheck. `command:` is just `playbacksync:ws-serve` (binding from admin settings, not flags).

## Task 4: Rewrite `start-ws-server`

Supervised launcher: kill any leftover `docker exec -d` daemon (holds the ports in the shared netns), then `docker compose -f docker-compose.ws.yml up -d`. Keep a commented foreground smoke-test line.

## Task 5: Add `docker-compose.ws.example.yml` (production template)

Parameterized: `${NEXTCLOUD_IMAGE}`, reuse the hoster's html volume(s), `network_mode: "service:app"` (placeholder for the NC app service), `/healthz` healthcheck, binding via admin settings (`ws_host=127.0.0.1` in-app proxy / `0.0.0.0` separate proxy).

## Task 6: Documentation

- `docs/ws-sync-server.md` §Docker (dev-only note) + §Docker Compose (full template, netns-share rationale, `ws_host` topology choice, healthcheck).
- `README.md`: dev line → compose launcher; ops line → `docker-compose.ws.example.yml`.

---

## Verification

Dev: up + bound on configured `ws_host`; `/healthz` ok; proxy handshake `101`; log shows `listening on 127.0.0.1:8765` (from admin settings, not a flag); healthcheck `healthy`; crash → `RestartCount` increments; `compose stop` → "Received SIGTERM" + exit 0, stays stopped; `docker restart master-nextcloud-1` → self-heals; foreground SIGINT exits clean.

Prod: `docker compose -f docker-compose.ws.example.yml config` parses with placeholders filled (documentation-grade; not a runnable drop-in).

## Standards
- `backend/php-conventions` — applies to the `WsServe.php` edit (strict types present; meaningful PHPDoc; no SPDX/author headers).
