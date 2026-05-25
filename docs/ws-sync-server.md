# PlaybackSync — WebSocket Sync Server (Operator Guide)

This document is for the administrator deploying PlaybackSync. It explains how to start the WebSocket sync daemon, how to expose it to clients through the existing Nextcloud reverse proxy, and which app-config keys tune its behaviour.

For protocol-level details (message types, fields, error codes), see [`ws-protocol.md`](ws-protocol.md).

## Overview

The sync server is a long-running PHP process launched with `occ playbacksync:ws-serve`. It accepts WebSocket connections, authenticates them with the room password, and broadcasts playback events between members of the same room. State lives only in the daemon's memory — there are no DB writes during normal operation, and no schema changes beyond the existing `oc_playbacksync_rooms` table.

Clients connect to:

```
ws[s]://<nextcloud-host>/index.php/apps/playbacksync/ws/{roomUuid}
```

Internally the daemon binds to a local port (default `127.0.0.1:8765`). The Nextcloud-fronting reverse proxy (Apache or nginx — the one already serving Nextcloud) forwards just `/apps/playbacksync/ws/` to the daemon. TLS termination happens at the proxy, exactly as it already does for Nextcloud's HTTP traffic.

## Recommended: scripted install

For both bare-metal and Docker Nextcloud installs, [`scripts/install-ws-daemon.sh`](../scripts/install-ws-daemon.sh) handles the entire setup end-to-end: composer install, `occ app:enable` and config keys, daemon supervision (systemd unit on bare-metal, sidecar compose service in Docker), reverse-proxy snippet for the detected front-end, and an end-to-end WebSocket handshake check. Everything it writes is marker-bracketed and idempotent, and `--uninstall` removes it cleanly.

Preview the plan before changing anything:

```bash
sudo ./scripts/install-ws-daemon.sh --dry-run
```

Apply it (non-interactive form shown; drop `--yes` to be prompted):

```bash
sudo ./scripts/install-ws-daemon.sh --yes
```

What it auto-detects:

- **Mode** — host vs. Docker. Switches to Docker mode when a Nextcloud-looking container is running and there's no Nextcloud install at standard host paths.
- **Nextcloud path / container** — host: `/var/www/nextcloud`, `/var/www/html`, `/srv/nextcloud`, snap; Docker: any container with `occ` at `/var/www/html` or `/var/www/nextcloud`.
- **Init system** — uses systemd when present, otherwise prints sidecar instructions instead of pretending it can install a service.
- **Web server** — nginx or Apache, by process and by vhost-file inspection (looks for `DocumentRoot` / `root` matching the detected Nextcloud path).
- **Proxy strategy in Docker** — `jwilder/nginx-proxy` style `vhost.d` drop-in (preferred, no host-side reload needed); bind-mounted `conf.d` / `sites-enabled` / `conf-enabled`; or `docker cp` into the proxy container as a last resort (warns: not durable across container rebuild).
- **Refuses on Nextcloud AIO** — AIO manages its own services; the installer would conflict with it.

Common overrides (full list under `--help`):

| Flag | Purpose |
|---|---|
| `--nc-path PATH` | Force the Nextcloud root in host mode. |
| `--web-server nginx\|apache` | Override the detected web server. |
| `--vhost-config PATH` | Pick a specific vhost config when detection is ambiguous. |
| `--container NAME` | Pin the Nextcloud container in Docker mode. |
| `--proxy-container NAME` | Pin the proxy container; `--no-proxy` skips proxy edits. |
| `--host HOST` / `--port PORT` | Daemon bind. Defaults to `127.0.0.1:8765` (host) / `0.0.0.0:8765` (Docker). |
| `--user USER` | Service account for the daemon (defaults to the Nextcloud-root owner). |
| `--no-reload` / `--no-start` | Skip the web-server reload / daemon-start steps. |
| `--uninstall` | Reverse what the installer did (works in both modes). |

If the installer fails for any reason, or your environment doesn't match any of the patterns above (exotic init, multiple competing proxies, snap with locked config, …), follow [install-without-script.md](install-without-script.md) — it's the same steps the script runs, but explicit, with verification commands after each one. The remaining sections of *this* document are the operator reference for what the installer produces.

## Starting the daemon

There is exactly one daemon: `occ playbacksync:ws-serve`. It runs in the foreground, one process, until killed. Everything below — systemd, `docker exec -d`, supervisord, Kubernetes — is just a different way to *keep that one command running*. The daemon itself doesn't know or care which.

Pick the supervision strategy that matches your environment:

| Environment | Strategy | Reason |
|---|---|---|
| Local dev / quick test | Run `occ playbacksync:ws-serve` in the foreground | Simplest. Dies when you close the terminal — that's fine for "is this thing working at all?". |
| Bare-metal production (Debian/Ubuntu/RHEL) | systemd unit | Auto-restart on crash, survives reboots, log goes to `journalctl`. |
| Docker (single-container `nextcloud:*`) | Detached `docker exec -d` for now; supervisor sidecar for long-haul | The Nextcloud container has no init system, so systemd is unavailable inside it. |
| Docker Compose / Kubernetes | Separate service/pod that runs the same `occ` command | Lifecycle managed by Compose or k8s, no in-container supervisor needed. |

### Foreground (any environment)

The simplest way to start the daemon — useful for development, smoke tests, and "did the install work?" checks:

```bash
# Bare-metal
sudo -u www-data php /var/www/nextcloud/occ playbacksync:ws-serve

# Docker (interactive — Ctrl-C to stop, output streams to your terminal)
docker exec -u www-data -it <nextcloud-container> php /var/www/html/occ playbacksync:ws-serve
```

Expected first line on either:

```
PlaybackSync WS daemon listening on 127.0.0.1:8765
```

The process stays attached to the terminal. Closing the terminal kills the daemon — that's the *only* operational difference between this and the supervised forms below.

### Bare-metal: systemd

Wrap the same `occ` command in a systemd unit so it survives reboots and restarts on failure:

```ini
# /etc/systemd/system/playbacksync-ws.service
[Unit]
Description=PlaybackSync WebSocket sync server
After=network-online.target mariadb.service redis.service
Wants=network-online.target

[Service]
Type=simple
User=www-data
Group=www-data
WorkingDirectory=/var/www/nextcloud
ExecStart=/usr/bin/php /var/www/nextcloud/occ playbacksync:ws-serve
Restart=on-failure
RestartSec=5
# Recommended: a weekly graceful restart to release any accumulated memory.
RuntimeMaxSec=7d

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now playbacksync-ws.service
sudo systemctl status playbacksync-ws.service
```

Restart after a config change or upgrade:

```bash
sudo systemctl restart playbacksync-ws.service
```

### Docker

The standard `nextcloud:*` image runs PHP-FPM under `s6-overlay` and intentionally does **not** include `systemd` or `systemctl`. To keep the daemon alive in a single-container deployment, run it detached with `docker exec` and re-run on container restart:

```bash
# Start it in the background
docker exec -u www-data -d <nextcloud-container> \
  php /var/www/html/occ playbacksync:ws-serve --host=0.0.0.0 --port=8765

# Confirm it's up (this is what you want any restart command to converge to)
docker exec <nextcloud-container> pgrep -fa playbacksync:ws-serve
```

Restart (= kill + start again):

```bash
docker exec <nextcloud-container> pkill -f playbacksync:ws-serve
docker exec -u www-data -d <nextcloud-container> \
  php /var/www/html/occ playbacksync:ws-serve --host=0.0.0.0 --port=8765
```

> **Why `--host=0.0.0.0` in Docker:** the proxy lives in a different container and reaches the daemon over the docker network, not over the daemon container's loopback. Bind to all interfaces inside the daemon's container — the docker network is itself a private network, this is not equivalent to exposing it to the public internet.

A `docker exec -d` daemon dies when the Nextcloud container restarts and is **not** automatically restarted — you'll need to re-run the start command. For a long-haul deployment, prefer one of:

- **Docker Compose**: add a second service that runs `occ playbacksync:ws-serve` as its `command`, with `restart: unless-stopped` and `network_mode: "service:nextcloud"` (or its own service in the same network). Compose then owns the lifecycle.
- **Kubernetes**: a separate Deployment running the same `occ` command. The kubelet handles restarts; readiness/liveness probes can hit `GET /healthz` on the admin port.
- **`supervisord` sidecar**: drop a `supervisord` config into the container that supervises `occ playbacksync:ws-serve`. Most heavyweight option, only worth it if you can't change the deployment topology.

### Verifying the daemon is up

Regardless of how you started it:

```bash
# Bare-metal
curl -s http://127.0.0.1:8766/healthz | jq

# Docker
docker exec <nextcloud-container> curl -s http://127.0.0.1:8766/healthz | jq
```

Expected: `status: "ok"` plus aggregate counts. See [Healthcheck (`GET /healthz`)](#healthcheck-get-healthz) below for the full schema.

## Reverse-proxy snippets

The daemon does not terminate TLS or speak HTTP/HTTPS. The existing Nextcloud reverse proxy handles both, then upgrades just `/apps/playbacksync/ws/` to a WebSocket and forwards it.

### nginx

Add a `location` block inside the `server { ... }` that already serves Nextcloud, **above** the catch-all `location /` block. The order matters — nginx picks the first matching prefix.

```nginx
location ^~ /apps/playbacksync/ws/ {
    proxy_pass http://127.0.0.1:8765;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
}
```

Reload: `sudo nginx -t && sudo systemctl reload nginx`.

### Apache

Requires `mod_proxy`, `mod_proxy_http`, and `mod_proxy_wstunnel`. Enable with:

```bash
sudo a2enmod proxy proxy_http proxy_wstunnel
sudo systemctl reload apache2
```

In the existing `<VirtualHost>` for Nextcloud, add — **before** any `<Directory>` or rewrite rules that would intercept the path:

```apache
ProxyPass        "/apps/playbacksync/ws/" "ws://127.0.0.1:8765/apps/playbacksync/ws/"
ProxyPassReverse "/apps/playbacksync/ws/" "ws://127.0.0.1:8765/apps/playbacksync/ws/"
```

Reload: `sudo systemctl reload apache2`.

## Configuration keys (`IAppConfig`)

All keys live under the `playbacksync` app. Set them with:

```bash
sudo -u www-data php occ config:app:set playbacksync <key> --value <value>
```

| Key | Default | Meaning |
|---|---|---|
| `ws_host` | `127.0.0.1` | Interface to bind. Leave on loopback when fronted by a reverse proxy on the same host. Set to `0.0.0.0` only if the daemon is the public listener. |
| `ws_port` | `8765` | TCP port to bind. |
| `ws_join_timeout_ms` | `5000` | A connection that doesn't send `JOIN` within this many ms is closed. |
| `ws_idle_close_ms` | `30000` | A connection with no `HEARTBEAT` within this window is closed. |
| `ws_tombstone_ms` | `30000` | How long a disconnected client may reconnect with the same `clientId` to resume its event-replay window. |
| `ws_kick_block_ms` | `30000` | After an owner-initiated kick, how long the same `clientId` is forbidden from rejoining the room. In-memory only; cleared on daemon restart. |
| `ws_event_log_size` | `200` | Per-room ring buffer size for replaying events to reconnecting clients. |
| `ws_rate_limit_events_per_sec` | `10` | Per-connection token-bucket cap on `EVENT` / `CURSOR_CHANGE_REQUEST` messages. |
| `ws_rate_limit_playlist_per_sec` | `2` | Per-connection token-bucket cap on `PLAYLIST_UPDATE` messages (separate bucket from `ws_rate_limit_events_per_sec` so a scrape on JOIN doesn't eat the playback-event budget). |
| `ws_drift_nudge_threshold_ms` | `200` | Drift below this is ignored. Above this and below the seek threshold triggers `SYNC_ADJUST mode=nudge-rate`. |
| `ws_drift_seek_threshold_ms` | `500` | Drift at or above this triggers `SYNC_ADJUST mode=seek`. |
| `ws_drift_cooldown_ms` | `3000` | Drift correction is suppressed for this long after every explicit `EVENT` or `CURSOR_CHANGE`. |
| `ws_admin_host` | `127.0.0.1` | Interface for the loopback admin HTTP endpoint. **Keep on loopback** — never proxy this. |
| `ws_admin_port` | `8766` | TCP port for the admin HTTP endpoint. |
| `ws_admin_secret` | *(auto-generated)* | Shared secret for HMAC-signed admin requests. Auto-generated on `occ app:enable` / `occ upgrade` via a repair step — operators don't need to set this manually. If somehow empty, the daemon refuses to start the admin endpoint (the WS server itself runs regardless); re-running `occ maintenance:repair` regenerates it. |

Daemon-level options (`--host`, `--port`) override the corresponding app-config keys for the current invocation, which is useful when running multiple instances in dev.

### Admin HTTP setup

The PHP-side rooms API talks to the daemon over a small HMAC-signed HTTP endpoint co-located with the WebSocket server. Four routes today:

- `GET  /healthz` — daemon liveness + light stats. **Unauthenticated**: loopback-only, no sensitive data in the response. Single-path carve-out before HMAC verification, audited with an explicit `if` rather than a general allowlist.
- `GET  /admin/rooms/presence?uuids=<csv>` — point-in-time presence map for the rooms list / detail view.
- `POST /admin/rooms/{uuid}/clients/{clientId}/disconnect` — owner-initiated kick. Sends the targeted client a final `{type:"ERROR", code:"KICKED"}` frame, closes the socket, and records a per-room reconnect block of `ws_kick_block_ms`.
- `POST /admin/rooms/{uuid}/playback` — owner-initiated playback command. JSON body `{action: "play"|"pause"|"seek"|"reset", videoPos?: number}`. The daemon drives the same `PlaybackState::applyPlay/applyPause/applySeek` calls as a peer client's `EVENT` frame, appends to the event log so reconnecting clients replay the change, and broadcasts a `STATE` frame to every connection in the room. Returns 404 if no client has joined the room yet (no in-memory runtime to mutate), which the PHP controller maps to a 409 the dashboard renders as "no clients are connected".

The shared secret (`ws_admin_secret`) is **seeded automatically** by a repair step on `occ app:enable` and on every `occ upgrade`, so operators don't normally need to touch it.

To rotate the secret manually (e.g. after a suspected leak), then restart the daemon — pick the line matching how you supervise it:

```bash
# Bare-metal
sudo -u www-data php /var/www/nextcloud/occ config:app:delete playbacksync ws_admin_secret
sudo -u www-data php /var/www/nextcloud/occ maintenance:repair
sudo systemctl restart playbacksync-ws.service

# Docker
docker exec -u www-data <nextcloud-container> php /var/www/html/occ config:app:delete playbacksync ws_admin_secret
docker exec -u www-data <nextcloud-container> php /var/www/html/occ maintenance:repair
docker exec <nextcloud-container> pkill -f playbacksync:ws-serve
docker exec -u www-data -d <nextcloud-container> php /var/www/html/occ playbacksync:ws-serve --host=0.0.0.0 --port=8765
```

If `ws_admin_secret` is somehow unset the rooms API still works — every room just renders with `live: null` (presence/playback fields hidden in the UI). The admin port stays bound to `127.0.0.1` by default and **must never** be added to the reverse proxy: it has no public-facing surface, only the loopback API path. See [`ws-protocol.md`](ws-protocol.md) for the request/response shape.

### Healthcheck (`GET /healthz`)

The fastest way to confirm the daemon is alive and processing rooms is to hit `/healthz` on the loopback admin port:

```bash
curl -s http://127.0.0.1:8766/healthz | jq
```

Expected:

```json
{
  "status": "ok",
  "daemon_version": "0.3.0",
  "uptime_seconds": 1842,
  "timestamp_ms": 1715339000000,
  "rooms":   { "active": 4 },
  "clients": { "connected": 11 },
  "tick":    { "running": true, "last_tick_ms_ago": 982 }
}
```

The response is intentionally compact and free of identifiers — no UUIDs, no client IDs, no IPs. This is the single route on the admin port that bypasses HMAC; it's only reachable on loopback because `ws_admin_host` defaults to `127.0.0.1`.

For external monitoring (status pages, k8s probes, uptime checks) prefer the public passthrough route on the Nextcloud webroot, which surfaces the same body wrapped with a reachability envelope:

```
GET /index.php/apps/playbacksync/api/v1/health
```

See [`api.md`](api.md#websocket-sync-daemon-healthcheck) for the wrapper's full schema. Both endpoints always answer `HTTP 200`; daemon trouble surfaces as `status: "degraded"` rather than 5xx.

If `ws_admin_secret` is unset, the admin port (and therefore `/healthz`) is not bound at all. The PHP passthrough then reports `daemon.reachable: false`, which is itself a useful signal that the daemon's loopback bridge isn't configured.

## Verifying the deployment

The cheapest end-to-end check is a raw WebSocket handshake:

```bash
curl -sS -i --max-time 3 -N \
  -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Host: $(hostname)" -H "Origin: https://$(hostname)" \
  -H "Sec-WebSocket-Version: 13" \
  -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  https://$(hostname)/apps/playbacksync/ws/probe
```

Expected: an `HTTP/1.1 101 Switching Protocols` response. Anything else points at the proxy configuration, not the daemon — the daemon's own logs will be silent in that case.

For richer manual testing, install [`websocat`](https://github.com/vi/websocat):

```bash
websocat 'wss://nextcloud.example.com/apps/playbacksync/ws/<roomUuid>'
> {"type":"JOIN","password":"<plain-password-from-creation-dialog>"}
```

## Troubleshooting

### `LISTEN` shows nothing on the configured port

The daemon failed to start. Check its log:

```bash
# Bare-metal (under systemd)
sudo journalctl -u playbacksync-ws.service -n 100 --no-pager

# Docker (foreground daemon — output is on the terminal you started it in)
# Docker (detached daemon — Nextcloud's app log catches the startup line)
docker exec <nextcloud-container> tail -n 100 /var/www/html/data/nextcloud.log | grep playbacksync
```

The most common cause is another process already holding the port.

### Browser connects but immediately disconnects

The proxy is forwarding the request but the daemon is closing it. Likeliest reasons, in order:

1. The client never sent `JOIN` within `ws_join_timeout_ms`.
2. The room UUID in the URL doesn't exist or is expired (`ERROR ROOM_NOT_FOUND` / `ROOM_EXPIRED`).
3. The password in `JOIN` was wrong (`ERROR AUTH_FAILED`).

Check the daemon's stdout, `journalctl -u playbacksync-ws.service` (systemd), or `docker exec <nextcloud-container> tail -n 100 /var/www/html/data/nextcloud.log` (Docker) — every refusal is logged with the path and reason.

### Browser reports `WebSocket handshake failed: Unexpected response code: 200`

Apache or nginx is treating the URL as a normal Nextcloud path and routing it to PHP-FPM. The proxy rule is missing or placed too low. Make sure the `/apps/playbacksync/ws/` rule is matched **before** any catch-all PHP location/rewrite.

### Browser reports `WebSocket handshake failed: Unexpected response code: 404`

The proxy is rejecting the path entirely instead of forwarding it. Three causes, in order of likelihood:

1. **The proxy snippet was never installed**, or it was installed and got reverted (container rebuild, `docker compose down && up --force-recreate`, manual edit that wiped the marker block, image upgrade replacing `conf-available/`). Re-run `scripts/install-ws-daemon.sh` — it's idempotent and will reinstate everything it manages.
2. **The proxy snippet is there but the proxy didn't reload** after it was added. `nginx -s reload` / `systemctl reload apache2`. In Docker: `docker exec <proxy-container> nginx -s reload` or `docker exec <proxy-container> apachectl graceful`.
3. **Apache only: the required modules aren't enabled.** `mod_proxy`, `mod_proxy_http`, and `mod_proxy_wstunnel` must all be loaded — without `mod_proxy_wstunnel` Apache returns 404 for the upgrade request even though the directive is in the config. This is the most common cause when running Apache *inside* a container, because most container Apache images ship with only the bare-minimum module set.

To enable them by hand (recovery path for when the installer can't run, or when you've just rebuilt a container and need the daemon back up before anything else):

```bash
# Bare-metal
sudo a2enmod proxy proxy_http proxy_wstunnel
sudo systemctl reload apache2

# Docker (substitute your container name)
docker exec -u root <nextcloud-container> a2enmod proxy proxy_http proxy_wstunnel
docker exec -u root <nextcloud-container> apachectl graceful
```

If you also need to re-add the `ProxyPass` directives by hand (e.g. the conf file got wiped along with the modules):

```bash
docker exec -u root <nextcloud-container> sh -c 'cat > /etc/apache2/conf-available/playbacksync-ws.conf <<EOF
ProxyPass        "/apps/playbacksync/ws/" "ws://127.0.0.1:8765/apps/playbacksync/ws/"
ProxyPassReverse "/apps/playbacksync/ws/" "ws://127.0.0.1:8765/apps/playbacksync/ws/"
EOF'
docker exec -u root <nextcloud-container> a2enconf playbacksync-ws
docker exec -u root <nextcloud-container> apachectl graceful
```

This is a **temporary fix inside the container**: a container rebuild will wipe it. The durable answer is to either let the installer mount the conf from the host (its `bind-mount` strategy) or bake the directives into your image. Diagnose which case you're in with `docker exec <nextcloud-container> apache2ctl -M | grep proxy` — you should see `proxy_module`, `proxy_http_module`, and `proxy_wstunnel_module` all listed.

### Logs are flooded with PHP deprecation warnings

The bundled Ratchet 0.4.4 has implicit-nullable parameter declarations that PHP 8.4 deprecates. They are warnings, not errors — the daemon works correctly. To silence them in production, set in your php.ini:

```ini
error_reporting = E_ALL & ~E_DEPRECATED
```

## Operational notes

- **Memory accumulation.** A long-running PHP process slowly grows even with no leaks (interned strings, opcache state). The systemd unit above includes `RuntimeMaxSec=7d` to force a weekly graceful restart. For Docker deployments, schedule an equivalent: a host cron entry that runs the Docker restart sequence weekly, or — if you use Docker Compose / Kubernetes — a healthcheck that fails after a memory threshold so the orchestrator restarts the container. Connected clients reconnect automatically within a second.
- **Daemon restart wipes playback state.** This is by design — `state` is in-memory only, and reconnects re-establish it from the first client to send a heartbeat. The user-visible effect is a one- to two-second hiccup.
- **The daemon never writes to the database.** Room identity (uuid, password, expiry) is read from `oc_playbacksync_rooms` on each `JOIN`. Room cleanup is the responsibility of the existing hourly `PruneExpiredRoomsJob`.
