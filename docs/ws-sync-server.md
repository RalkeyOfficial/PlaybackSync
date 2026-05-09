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

## Starting the daemon

In a development setup:

```bash
sudo -u www-data php occ playbacksync:ws-serve
```

In production, run the daemon under `systemd` so it stays alive across reboots and restarts on failure. A sample unit:

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
| `ws_event_log_size` | `200` | Per-room ring buffer size for replaying events to reconnecting clients. |
| `ws_rate_limit_events_per_sec` | `10` | Per-connection token-bucket cap on `EVENT` / `EPISODE_CHANGE_REQUEST` messages. |
| `ws_drift_nudge_threshold_ms` | `200` | Drift below this is ignored. Above this and below the seek threshold triggers `SYNC_ADJUST mode=nudge-rate`. |
| `ws_drift_seek_threshold_ms` | `500` | Drift at or above this triggers `SYNC_ADJUST mode=seek`. |
| `ws_drift_cooldown_ms` | `3000` | Drift correction is suppressed for this long after every explicit `EVENT` or `EPISODE_CHANGE`. |
| `ws_admin_host` | `127.0.0.1` | Interface for the loopback admin HTTP endpoint. **Keep on loopback** — never proxy this. |
| `ws_admin_port` | `8766` | TCP port for the admin HTTP endpoint. |
| `ws_admin_secret` | *(auto-generated)* | Shared secret for HMAC-signed admin requests. Auto-generated on `occ app:enable` / `occ upgrade` via a repair step — operators don't need to set this manually. If somehow empty, the daemon refuses to start the admin endpoint (the WS server itself runs regardless); re-running `occ maintenance:repair` regenerates it. |

Daemon-level options (`--host`, `--port`) override the corresponding app-config keys for the current invocation, which is useful when running multiple instances in dev.

### Admin HTTP setup

The PHP-side rooms API queries the daemon for live presence and playback state via a small HMAC-signed HTTP endpoint co-located with the WebSocket server. The shared secret (`ws_admin_secret`) is **seeded automatically** by a repair step on `occ app:enable` and on every `occ upgrade`, so operators don't normally need to touch it.

To rotate the secret manually (e.g. after a suspected leak):

```bash
sudo -u www-data php occ config:app:delete playbacksync ws_admin_secret
sudo -u www-data php occ maintenance:repair
sudo systemctl restart playbacksync-ws.service   # or pkill -f ws-serve
```

If `ws_admin_secret` is somehow unset the rooms API still works — every room just renders with `live: null` (presence/playback fields hidden in the UI). The admin port stays bound to `127.0.0.1` by default and **must never** be added to the reverse proxy: it has no public-facing surface, only the loopback API path. See [`ws-protocol.md`](ws-protocol.md) for the request/response shape.

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

The daemon failed to start. Check the systemd journal:

```bash
sudo journalctl -u playbacksync-ws.service -n 100 --no-pager
```

The most common cause is another process already holding the port.

### Browser connects but immediately disconnects

The proxy is forwarding the request but the daemon is closing it. Likeliest reasons, in order:

1. The client never sent `JOIN` within `ws_join_timeout_ms`.
2. The room UUID in the URL doesn't exist or is expired (`ERROR ROOM_NOT_FOUND` / `ROOM_EXPIRED`).
3. The password in `JOIN` was wrong (`ERROR AUTH_FAILED`).

Check the daemon's stdout (or `journalctl -u playbacksync-ws.service`) — every refusal is logged with the path and reason.

### Browser reports `WebSocket handshake failed: Unexpected response code: 200`

Apache or nginx is treating the URL as a normal Nextcloud path and routing it to PHP-FPM. The proxy rule is missing or placed too low. Make sure the `/apps/playbacksync/ws/` rule is matched **before** any catch-all PHP location/rewrite.

### Logs are flooded with PHP deprecation warnings

The bundled Ratchet 0.4.4 has implicit-nullable parameter declarations that PHP 8.4 deprecates. They are warnings, not errors — the daemon works correctly. To silence them in production, set in your php.ini:

```ini
error_reporting = E_ALL & ~E_DEPRECATED
```

## Operational notes

- **Memory accumulation.** A long-running PHP process slowly grows even with no leaks (interned strings, opcache state). The systemd unit above includes `RuntimeMaxSec=7d` to force a weekly graceful restart. Connected clients reconnect automatically within a second.
- **Daemon restart wipes playback state.** This is by design — `state` is in-memory only, and reconnects re-establish it from the first client to send a heartbeat. The user-visible effect is a one- to two-second hiccup.
- **The daemon never writes to the database.** Room identity (uuid, password, expiry) is read from `oc_playbacksync_rooms` on each `JOIN`. Room cleanup is the responsibility of the existing hourly `PruneExpiredRoomsJob`.
