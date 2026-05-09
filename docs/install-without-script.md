# PlaybackSync — Manual WebSocket daemon install

This is the long-form, step-by-step reference for installing the WebSocket
sync daemon **without** `scripts/install-ws-daemon.sh`. Use it when the
installer fails, when your environment is non-standard (custom paths,
unusual init system, an exotic reverse proxy), or when you want to
understand exactly what the script does.

Every step lists the concrete commands and values for both **bare-metal**
and **Docker** Nextcloud installs. After each step there's a one-line
verification you can run to confirm it worked.

## Contents

1. [Reference values](#1-reference-values)
2. [Prerequisites](#2-prerequisites)
3. [Step 1 — Get the code in place](#3-step-1--get-the-code-in-place)
4. [Step 2 — Install Composer dependencies](#4-step-2--install-composer-dependencies)
5. [Step 3 — Enable the app and set config keys](#5-step-3--enable-the-app-and-set-config-keys)
6. [Step 4 — Smoke-test the daemon in the foreground](#6-step-4--smoke-test-the-daemon-in-the-foreground)
7. [Step 5 — Keep the daemon alive (bare-metal: systemd)](#7-step-5--keep-the-daemon-alive-bare-metal-systemd)
8. [Step 6 — Keep the daemon alive (Docker: sidecar service)](#8-step-6--keep-the-daemon-alive-docker-sidecar-service)
9. [Step 7 — Configure the reverse proxy](#9-step-7--configure-the-reverse-proxy)
10. [Step 8 — Verify end-to-end](#10-step-8--verify-end-to-end)
11. [Common failures and fixes](#11-common-failures-and-fixes)
12. [Reverse: how to undo all of this](#12-reverse-how-to-undo-all-of-this)

---

## 1. Reference values

These appear over and over. Set them up front and substitute through the rest of the document.

| Name | Default | Notes |
|---|---|---|
| App ID | `playbacksync` | Nextcloud app slug. Don't change. |
| Daemon listen host | `127.0.0.1` (bare-metal), `0.0.0.0` (Docker) | Bare-metal: keep on loopback, the reverse proxy lives on the same host. Docker: bind to all interfaces inside the container so the proxy on the docker network can reach you. |
| Daemon listen port | `8765` | Anything unused will work. Match the port in every config. |
| Service user | `www-data` (Debian/Ubuntu), `apache`/`nginx`/`http` (RHEL family) | Owner of the Nextcloud directory. |
| systemd service name | `playbacksync-ws` | Used as `playbacksync-ws.service`. |
| Sidecar container name | `playbacksync-ws` | And `<compose-project>-playbacksync-ws` in compose. |
| WebSocket URL clients hit | `ws[s]://<host>/index.php/apps/playbacksync/ws/{roomUuid}` | The `/apps/playbacksync/ws/` prefix is what gets reverse-proxied to the daemon. |

### IAppConfig keys (set in step 3)

| Key | Default | Meaning |
|---|---|---|
| `ws_host` | `127.0.0.1` | What the daemon binds to. |
| `ws_port` | `8765` | Same. |
| `ws_join_timeout_ms` | `5000` | Connection closed if no `JOIN` within this many ms. |
| `ws_idle_close_ms` | `30000` | Connection closed if no `HEARTBEAT` within this window. |
| `ws_tombstone_ms` | `30000` | Reconnect-with-replay grace window. |
| `ws_event_log_size` | `200` | Per-room ring buffer size. |
| `ws_rate_limit_events_per_sec` | `10` | Per-connection cap on `EVENT` / `EPISODE_CHANGE_REQUEST`. |
| `ws_drift_nudge_threshold_ms` | `200` | Drift below this is ignored. |
| `ws_drift_seek_threshold_ms` | `500` | Drift at or above this triggers a seek correction. |
| `ws_drift_cooldown_ms` | `3000` | No drift correction for this long after every explicit event. |

You only need to set `ws_host` and `ws_port` in step 3 — the rest have built-in defaults you only override if you want to tune.

---

## 2. Prerequisites

- A working Nextcloud install at version 34 or later.
- PHP 8.1 or newer.
- Composer 2.x available wherever you'll run `composer install` (host or inside the NC container).
- `curl` for verification.
- Bare-metal: root access, plus systemd and either nginx (with `mod_http_proxy`) or Apache (with `mod_proxy_wstunnel`).
- Docker: the `docker` CLI working for your user, and ideally `docker compose`.

Check before starting:

```bash
# Bare-metal
sudo -u www-data php /var/www/nextcloud/occ status

# Docker
docker exec <nextcloud-container> php /var/www/html/occ status
```

You should see `installed: true` and a version. Fix anything else before continuing.

---

## 3. Step 1 — Get the code in place

The repo must live under your Nextcloud's apps directory.

### Bare-metal

```bash
cd /var/www/nextcloud/apps-extra            # or apps/, both work
sudo git clone https://github.com/RalkeyOfficial/PlaybackSync.git playbacksync
sudo chown -R www-data:www-data playbacksync
```

### Docker

The repo needs to be visible inside the NC container. Two paths:

- **If `apps-extra/` is bind-mounted from the host** (typical of dev stacks): clone on the host into the bind-mount source.
- **If the apps directory is in a named volume**: clone somewhere on the host, then `docker cp` the directory into the container, **or** mount the host directory into the container.

```bash
git clone https://github.com/RalkeyOfficial/PlaybackSync.git ./playbacksync
docker cp ./playbacksync <nextcloud-container>:/var/www/html/apps-extra/
docker exec <nextcloud-container> chown -R www-data:www-data /var/www/html/apps-extra/playbacksync
```

### Verify

```bash
# Bare-metal
ls /var/www/nextcloud/apps-extra/playbacksync/appinfo/info.xml

# Docker
docker exec <nextcloud-container> ls /var/www/html/apps-extra/playbacksync/appinfo/info.xml
```

Either should print the full path. If not, the code isn't where Nextcloud expects it.

---

## 4. Step 2 — Install Composer dependencies

The daemon needs `cboden/ratchet` and its ReactPHP transitive deps. The repo's `composer.json` declares them; `composer install` populates `vendor/`.

### Bare-metal

```bash
cd /var/www/nextcloud/apps-extra/playbacksync
sudo -u www-data composer install --no-dev --no-interaction --prefer-dist
```

### Docker

```bash
docker exec -u www-data <nextcloud-container> sh -c \
  'cd /var/www/html/apps-extra/playbacksync && composer install --no-dev --no-interaction --prefer-dist'
```

If the NC container doesn't have Composer, install it inside or run `composer install` on a host with PHP and copy `vendor/` into the container:

```bash
# On the host
cd ./playbacksync && composer install --no-dev
docker cp ./vendor <nextcloud-container>:/var/www/html/apps-extra/playbacksync/
```

### Verify

```bash
# Bare-metal
test -f /var/www/nextcloud/apps-extra/playbacksync/vendor/autoload.php && echo OK

# Docker
docker exec <nextcloud-container> test -f /var/www/html/apps-extra/playbacksync/vendor/autoload.php && echo OK
```

---

## 5. Step 3 — Enable the app and set config keys

### Bare-metal

```bash
sudo -u www-data php /var/www/nextcloud/occ app:enable playbacksync
sudo -u www-data php /var/www/nextcloud/occ config:app:set playbacksync ws_host --value 127.0.0.1
sudo -u www-data php /var/www/nextcloud/occ config:app:set playbacksync ws_port --value 8765
```

### Docker

```bash
docker exec -u www-data <nextcloud-container> php /var/www/html/occ app:enable playbacksync
docker exec -u www-data <nextcloud-container> php /var/www/html/occ config:app:set playbacksync ws_host --value 0.0.0.0
docker exec -u www-data <nextcloud-container> php /var/www/html/occ config:app:set playbacksync ws_port --value 8765
```

> **Why `0.0.0.0` in Docker:** the proxy lives in a different container and reaches the daemon over the docker network, not over loopback. Bind to all interfaces inside the daemon's container.

### Verify

The migration ran and the table exists. Bare-metal:

```bash
sudo -u www-data php /var/www/nextcloud/occ app:list | grep playbacksync
```

Output includes `- playbacksync: 0.2.0` (or higher).

---

## 6. Step 4 — Smoke-test the daemon in the foreground

Before configuring services and proxies, confirm the daemon runs at all.

### Bare-metal

```bash
sudo -u www-data php /var/www/nextcloud/occ playbacksync:ws-serve
```

Expect:

```
PlaybackSync WS daemon listening on 127.0.0.1:8765
```

In another terminal:

```bash
curl -sS -i --max-time 3 -N \
  -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" \
  -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  http://127.0.0.1:8765/probe
```

Expect:

```
HTTP/1.1 101 Switching Protocols
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=
X-Powered-By: Ratchet/0.4.4
```

`Ctrl-C` to stop the daemon. If the handshake didn't return 101, fix that here before moving on; everything downstream depends on this working.

### Docker

```bash
docker exec -u www-data <nextcloud-container> php /var/www/html/occ playbacksync:ws-serve --host=0.0.0.0 --port=8765
```

In another terminal:

```bash
docker exec <nextcloud-container> curl -sS -i --max-time 3 -N \
  -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" \
  -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  http://127.0.0.1:8765/probe
```

Same expected response.

> **Deprecation noise:** PHP 8.4 floods stderr with deprecation warnings from cboden/ratchet 0.4.4. The daemon works correctly; quiet the noise with `php -d error_reporting='E_ALL & ~E_DEPRECATED'` or `error_reporting = E_ALL & ~E_DEPRECATED` in `php.ini`.

---

## 7. Step 5 — Keep the daemon alive (bare-metal: systemd)

Skip to step 6 if you're on Docker.

Write the unit file:

```bash
sudo tee /etc/systemd/system/playbacksync-ws.service >/dev/null <<'EOF'
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
# Suppress PHP 8.4 deprecation warnings from cboden/ratchet:
Environment=PHP_INI_SCAN_DIR=
# Force a graceful weekly restart to release any accumulated memory:
RuntimeMaxSec=7d

[Install]
WantedBy=multi-user.target
EOF
```

Edit if any of these differ on your host:

- `User`/`Group`: the user that owns your Nextcloud directory.
- `WorkingDirectory`: your Nextcloud root.
- `ExecStart`: full path to `php` (use `which php` to confirm) and to `occ`.

Activate:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now playbacksync-ws.service
```

### Verify

```bash
sudo systemctl status playbacksync-ws.service
sudo ss -lntp | grep 8765
```

The status should be `active (running)` and `ss` should show the daemon listening on `127.0.0.1:8765`.

If it's failing, look at the journal:

```bash
sudo journalctl -u playbacksync-ws.service -n 50 --no-pager
```

---

## 8. Step 6 — Keep the daemon alive (Docker: sidecar service)

Skip to step 7 if you set up systemd above.

The pattern is the same regardless of your stack: **one extra container that runs the same NC image, mounts the same volumes, and runs the daemon command instead of the web server**.

### 8.1 Find what to replicate

The sidecar must mount **every volume the NC container has at or under `/var/www/html`**, otherwise occ can't init.

```bash
docker inspect <nextcloud-container> \
  --format '{{range .Mounts}}{{.Type}}|{{.Source}}|{{.Name}}|{{.Destination}}{{println}}{{end}}'
```

Example output (jwilder-style dev stack):

```
bind|/home/me/nc-dev/workspace/server|...|/var/www/html
bind|/home/me/nc-dev/workspace/server/apps-extra|...|/var/www/html/apps-extra
bind|/home/me/nc-dev/data/additional.config.php|...|/var/www/html/config/additional.config.php
volume|/var/lib/docker/volumes/master_config/_data|master_config|/var/www/html/config
volume|/var/lib/docker/volumes/master_data/_data|master_data|/var/www/html/data
volume|/var/lib/docker/volumes/master_apps-writable/_data|master_apps-writable|/var/www/html/apps-writable
```

You also need:

- The container's primary network name: `docker inspect <nc> --format '{{range $k,$_ := .NetworkSettings.Networks}}{{$k}}{{println}}{{end}}' | head -1`
- The image: `docker inspect <nc> --format '{{.Config.Image}}'`
- The compose project name (if any): `docker inspect <nc> --format '{{index .Config.Labels "com.docker.compose.project"}}'`

### 8.2 Single-container `nextcloud:latest`

If your stack is just one container running `nextcloud:latest`, write `docker-compose.playbacksync.yml` next to your existing compose file:

```yaml
services:
  playbacksync-ws:
    image: nextcloud:latest                    # match your existing nextcloud service
    container_name: playbacksync-ws
    restart: unless-stopped
    user: "www-data"
    working_dir: /var/www/html
    entrypoint: []                             # crucial: skip the image's webserver bootstrap
    command: ["php", "/var/www/html/occ", "playbacksync:ws-serve", "--host=0.0.0.0", "--port=8765"]
    volumes_from:
      - <nextcloud-container>                  # inherit every mount the NC container has
    network_mode: "service:<nextcloud-service-name>"  # share the NC container's network namespace
```

Bring it up:

```bash
docker compose -f docker-compose.yml -f docker-compose.playbacksync.yml up -d playbacksync-ws
```

### 8.3 Multi-container with named volumes (most production stacks)

This is the most common shape. Replicate every NC mount and join the NC network. Write `docker-compose.playbacksync.override.yml`:

```yaml
services:
  playbacksync-ws:
    image: nextcloud:latest
    container_name: ${COMPOSE_PROJECT_NAME:-myproject}-playbacksync-ws
    restart: unless-stopped
    user: "www-data"
    working_dir: /var/www/html
    entrypoint: []
    command: ["php", "/var/www/html/occ", "playbacksync:ws-serve", "--host=0.0.0.0", "--port=8765"]
    networks:
      - default
    volumes:
      - nextcloud_aio_nextcloud:/var/www/html      # whatever named volume holds your NC code
      - nextcloud_aio_data:/var/www/html/data
      - nextcloud_aio_config:/var/www/html/config
      # ...one line per mount you saw in step 8.1
networks:
  default:
    external: true
    name: <your_compose_project>_default
volumes:
  nextcloud_aio_nextcloud:
    external: true
  nextcloud_aio_data:
    external: true
  nextcloud_aio_config:
    external: true
```

The `external: true` flag tells compose **don't create these — reuse the ones the NC container is already using**.

Bring up:

```bash
docker compose -f docker-compose.yml -f docker-compose.playbacksync.override.yml up -d playbacksync-ws
```

### 8.4 jwilder/nginx-proxy + nextcloud-fpm

Same shape as 8.3. Make sure the sidecar joins the same network as both the NC container and the nginx-proxy container, so the proxy can resolve `playbacksync-ws` by name.

### Verify (any Docker shape)

```bash
docker ps --filter name=playbacksync-ws --format '{{.Names}}\t{{.Status}}'
docker logs <playbacksync-ws-container> 2>&1 | tail -5
docker exec <playbacksync-ws-container> sh -c 'cat /proc/net/tcp | head -5'
```

You want to see `Up <n>s` and `PlaybackSync WS daemon listening on 0.0.0.0:8765` in the logs.

If the container restarts in a loop with `Cannot write into "config" directory!`, you missed a volume in step 8.1 — almost always the named volume that holds `/var/www/html/config`. Run the inspect command again and add anything you skipped.

---

## 9. Step 7 — Configure the reverse proxy

Pick the section that matches your proxy.

### 9.1 nginx (bare-metal, single host)

Edit your existing Nextcloud server block (typically in `/etc/nginx/sites-available/nextcloud` or `/etc/nginx/conf.d/nextcloud.conf`). Add **above** the catch-all `location / { ... }`:

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

> **Order matters.** nginx picks the first matching location prefix. If `^~ /apps/playbacksync/ws/` comes after a regex-matching block that swallows `/apps/`, your block is unreachable.

Reload:

```bash
sudo nginx -t && sudo systemctl reload nginx
```

### 9.2 Apache (bare-metal)

Enable the WebSocket tunnel module, then add the directives to your `<VirtualHost>`:

```bash
sudo a2enmod proxy proxy_http proxy_wstunnel        # Debian/Ubuntu
sudo systemctl reload apache2
```

Inside the `<VirtualHost *:443>` (or `<VirtualHost *:80>`) for Nextcloud, **before** any `<Directory>` block, add:

```apache
<IfModule mod_proxy_wstunnel.c>
    ProxyPass        "/apps/playbacksync/ws/" "ws://127.0.0.1:8765/apps/playbacksync/ws/"
    ProxyPassReverse "/apps/playbacksync/ws/" "ws://127.0.0.1:8765/apps/playbacksync/ws/"
</IfModule>
```

Reload:

```bash
sudo apache2ctl configtest && sudo systemctl reload apache2     # Debian/Ubuntu
sudo apachectl configtest && sudo systemctl reload httpd        # RHEL family
```

### 9.3 jwilder/nginx-proxy (Docker)

This is the easiest case. nginx-proxy includes per-vhost snippets from `/etc/nginx/vhost.d/<VIRTUAL_HOST>` automatically.

Find the bind-mount on the host:

```bash
docker inspect <nginx-proxy-container> \
  --format '{{range .Mounts}}{{if eq .Destination "/etc/nginx/vhost.d"}}{{.Source}}{{end}}{{end}}'
```

Find the NC container's `VIRTUAL_HOST` value (this is the file name to write):

```bash
docker inspect <nextcloud-container> \
  --format '{{range .Config.Env}}{{println .}}{{end}}' | grep ^VIRTUAL_HOST=
```

Write the snippet (substitute `<vhost.d-source>` and `<vhost-name>`):

```bash
sudo tee <vhost.d-source>/<vhost-name> >/dev/null <<'EOF'
location ^~ /apps/playbacksync/ws/ {
    proxy_pass http://playbacksync-ws:8765;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
}
EOF
```

> **Service name in `proxy_pass`** is whatever you named the sidecar service in step 8 (and what's resolvable on the docker network). With the compose name `playbacksync-ws`, it's `playbacksync-ws`.

nginx-proxy detects the file change and reloads automatically.

### 9.4 nginx in a separate container (with bind-mounted config)

If your proxy container has a directory like `/etc/nginx/conf.d/` bind-mounted from the host:

```bash
docker inspect <proxy-container> \
  --format '{{range .Mounts}}{{if eq .Destination "/etc/nginx/conf.d"}}{{.Source}}{{end}}{{end}}'
```

Drop a file at `<that-source>/playbacksync-ws.conf` containing the **same `location` block** as 9.1 — but with `proxy_pass http://playbacksync-ws:8765;` (the docker service name) instead of `127.0.0.1`.

Reload via:

```bash
docker exec <proxy-container> nginx -t && docker exec <proxy-container> nginx -s reload
```

### 9.5 Apache in a separate container (with bind-mounted config)

Same idea: drop a `playbacksync-ws.conf` in the bind-mounted `conf.d`-style directory, with the directives from 9.2 but `ws://playbacksync-ws:8765/...` as the upstream.

Reload via:

```bash
docker exec <proxy-container> apache2ctl configtest
docker exec <proxy-container> apache2ctl graceful
```

### 9.6 Caddy

In your `Caddyfile`, inside the site block for Nextcloud:

```caddy
nextcloud.example.com {
    @ws path /apps/playbacksync/ws/*
    reverse_proxy @ws playbacksync-ws:8765      # or 127.0.0.1:8765 on bare-metal

    # ...your existing reverse_proxy / file_server / php_fastcgi here
}
```

Reload:

```bash
caddy reload --config /etc/caddy/Caddyfile
# or, in Docker: docker exec <caddy-container> caddy reload --config /etc/caddy/Caddyfile
```

### 9.7 Traefik (Docker labels)

Add labels to the **sidecar service** in your compose override (step 8):

```yaml
services:
  playbacksync-ws:
    # ...rest from step 8...
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.playbacksync-ws.rule=Host(`nextcloud.example.com`) && PathPrefix(`/apps/playbacksync/ws`)"
      - "traefik.http.routers.playbacksync-ws.entrypoints=websecure"
      - "traefik.http.routers.playbacksync-ws.tls=true"
      - "traefik.http.services.playbacksync-ws.loadbalancer.server.port=8765"
      # If your existing NC router has higher priority, give this one priority too:
      - "traefik.http.routers.playbacksync-ws.priority=1000"
```

Restart the sidecar with the new labels:

```bash
docker compose -f docker-compose.yml -f docker-compose.playbacksync.override.yml up -d --force-recreate playbacksync-ws
```

---

## 10. Step 8 — Verify end-to-end

The cheapest test that exercises the **entire path** (browser → proxy → daemon).

```bash
# Substitute your real Nextcloud hostname.
HOST=nextcloud.example.com

curl -sS -i --max-time 4 \
  -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" \
  -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  "https://${HOST}/apps/playbacksync/ws/probe"
```

Expected: `HTTP/1.1 101 Switching Protocols`. Anything else → see the next section.

For a fuller test with a real WebSocket client, install [`websocat`](https://github.com/vi/websocat) and:

```bash
websocat "wss://${HOST}/apps/playbacksync/ws/<a-real-room-uuid>"
> {"type":"JOIN","password":"<plaintext-password-from-creation-dialog>"}
< {"type":"ROOM_STATE","clientId":"...","playerState":"paused",...}
```

If you get `ROOM_STATE` back: every layer is working.

---

## 11. Common failures and fixes

### `HTTP/1.1 503 Service Unavailable` from the proxy

The proxy is reaching upstream but the upstream is down or unreachable.

- **vhost-aware proxy (nginx-proxy, Traefik):** check the `Host:` header you sent matches the proxy's expected vhost. Try adding `-H "Host: nextcloud.example.com"` to the curl.
- **Daemon not actually listening:** `docker logs <playbacksync-ws>` or `journalctl -u playbacksync-ws.service`. Look for a startup failure (most often missing volumes in Docker, or a config-write permission denial).
- **Wrong service name in the proxy upstream:** `docker exec <proxy> getent hosts playbacksync-ws` should resolve. If not, the sidecar isn't on the same docker network as the proxy.

### `HTTP/1.1 404 Not Found` from the proxy

The proxy got the request but isn't matching your `location` / `ProxyPass` / route rule.

- **nginx:** your `location ^~ /apps/playbacksync/ws/` block is below another block that catches `/apps/...` first.
- **Apache:** an `Alias` or `RewriteRule` is rewriting the path before it reaches `ProxyPass`. Move the proxy directives **above** anything else in the vhost.
- **Traefik:** missing `traefik.enable=true` label, or another router has the same path with higher priority.

### `Cannot write into "config" directory!` from the daemon (Docker)

The sidecar is missing the named volume that holds `/var/www/html/config`. Re-run the inspect command in [8.1](#81-find-what-to-replicate) and ensure every named volume the NC container has is also mounted on the sidecar.

### `cp: cannot stat '/root/installing.html': Permission denied` and friends

The sidecar is trying to run the image's `bootstrap.sh` ENTRYPOINT, which expects root and tries to set up a webserver. **Set `entrypoint: []`** in the sidecar service definition (step 8) so the container runs the daemon command directly.

### Sidecar restarts in a loop with no obvious error

Often a missing volume, sometimes a bad `command:`. Try running the same command interactively:

```bash
docker run --rm -it \
  --user www-data --entrypoint sh \
  -v <repeat the same volumes here> \
  <image> -c 'php /var/www/html/occ playbacksync:ws-serve --host=0.0.0.0 --port=8765'
```

The error will usually be obvious without the restart loop hiding it.

### `Address already in use` on bare-metal

Another process holds port 8765. Find it: `sudo ss -lntp | grep 8765`. Either stop it, or change `ws_port` in step 3 (and update the proxy snippet to match).

### PHP deprecation warnings flood the daemon log

Cosmetic — Ratchet 0.4.4 hasn't been updated for PHP 8.4. The daemon works. To silence:

- systemd: `Environment="PHP_INI_SCAN_DIR="` and a tiny `/etc/php/<ver>/cli/conf.d/zz-playbacksync.ini` containing `error_reporting = E_ALL & ~E_DEPRECATED`.
- Docker sidecar: add `command: ["php", "-d", "error_reporting=E_ALL & ~E_DEPRECATED", "/var/www/html/occ", "playbacksync:ws-serve", "--host=0.0.0.0", "--port=8765"]`.

### `WebSocket handshake failed: Unexpected response code: 200`

The proxy didn't recognise the URL as a WebSocket upgrade and routed it to PHP-FPM, which returned the Vue dashboard. Same fix as the 404 above: get the `/apps/playbacksync/ws/` rule matched **before** any catch-all.

### Client connects but immediately disconnects

The handshake works, the upgrade succeeds, then the daemon closes you. Almost always one of:

1. **Didn't send `JOIN` within 5 seconds.** Send it as the very first frame after the upgrade.
2. **Wrong room password.** The daemon returns `ERROR AUTH_FAILED` and closes.
3. **Room expired.** TTL passed; create a new one.

`docker logs <playbacksync-ws>` shows the reason for every refusal.

---

## 12. Reverse: how to undo all of this

### Bare-metal

```bash
sudo systemctl disable --now playbacksync-ws.service
sudo rm /etc/systemd/system/playbacksync-ws.service
sudo systemctl daemon-reload

# Remove the proxy snippet you added in step 7 (edit the file by hand).
sudo nginx -t && sudo systemctl reload nginx               # or apache2ctl configtest && systemctl reload apache2

# Optional: remove the app entirely
sudo -u www-data php /var/www/nextcloud/occ app:disable playbacksync
sudo rm -rf /var/www/nextcloud/apps-extra/playbacksync
```

### Docker

```bash
docker compose -f docker-compose.yml -f docker-compose.playbacksync.override.yml rm -sf playbacksync-ws
rm docker-compose.playbacksync.override.yml

# Remove the proxy snippet you wrote in step 9 (edit / delete the file).
docker exec <proxy-container> nginx -s reload              # or apache2ctl graceful

# Optional: remove the app entirely
docker exec -u www-data <nextcloud-container> php /var/www/html/occ app:disable playbacksync
```

The `IAppConfig` keys (`ws_host`, `ws_port`, etc.) and the existing `oc_playbacksync_rooms` table are intentionally left alone — disable the app first if you want to clean those up too:

```bash
sudo -u www-data php /var/www/nextcloud/occ config:app:delete playbacksync ws_host
sudo -u www-data php /var/www/nextcloud/occ config:app:delete playbacksync ws_port
```
