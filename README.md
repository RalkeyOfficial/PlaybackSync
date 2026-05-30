<p align="center">
  <img src="design/v1/logo-lockup.svg" alt="PlaybackSync" width="540">
</p>

<p align="center">
  <strong>Watch videos in sync with friends, hosted on your own Nextcloud.</strong><br>
  <sub>Coordinates timestamps and play/pause across viewers — never relays the video itself.</sub>
</p>

---

## What it is

PlaybackSync is a Nextcloud app for **synchronised video playback across a small group**. Each participant streams the video from wherever they would normally — Netflix, YouTube, a self-hosted file, anything in a browser — and PlaybackSync keeps everyone at the same timestamp.

Because the actual video bytes never pass through the server, PlaybackSync runs comfortably on a self-hosted Nextcloud with home-grade bandwidth: synchronising a play/pause/seek event is a few hundred bytes; relaying a 1080p stream to six people is not.

## Status

| Phase | Capability | Status |
|---|---|---|
| 1 | Owner-only room CRUD via the Nextcloud UI | **Shipped** |
| 1 | TTL-based room expiry + hourly prune job | **Shipped** |
| 2 | WebSocket sync server (drift correction, reconnect replay) | **Shipped** |
| 3 | Browser-extension client (drives the actual video player) | Planned |

You can use the rooms UI today. The WebSocket server is ready for a client to connect to it; the in-browser client that closes the loop is the next deliverable.

---

## Setup

PlaybackSync has two pieces an administrator installs:

1. The **Nextcloud app** (this repo) — handles the rooms UI, the database, and the REST API.
2. The **WebSocket sync daemon** — a long-running PHP process launched by `occ`, responsible for real-time playback events.

Both live in the same repository.

### Quick install (recommended)

The installer handles both bare-metal and Docker setups; pick the one that matches yours.

**Bare-metal (Debian, Ubuntu, RHEL/Rocky, openSUSE):**

```bash
cd /var/www/nextcloud/apps-extra
git clone https://github.com/RalkeyOfficial/PlaybackSync.git playbacksync
sudo bash playbacksync/scripts/install-ws-daemon.sh
```

It auto-detects the Nextcloud path, web server (nginx or Apache), vhost config, and init system, and does everything: `composer install`, `occ app:enable`, the `IAppConfig` keys, the systemd unit, the reverse-proxy snippet (idempotent, marker-bracketed), web-server reload, service start, and a WebSocket handshake to verify.

**Docker (single-container, multi-container with separate proxy, jwilder/nginx-proxy, traefik, custom):**

Clone the repo into your apps directory inside the Nextcloud container's mounted code path, then run on the host:

```bash
bash playbacksync/scripts/install-ws-daemon.sh --docker
```

It auto-detects the Nextcloud container, the reverse-proxy container, the compose project, and replicates all NC mounts into a sidecar service. It picks the right proxy strategy: `vhost.d` drop-in for nginx-proxy (no reload), edit-on-host for bind-mounted configs, `docker cp` as a last resort with a clear "this won't survive a rebuild" warning.

If detection finds multiple candidates it prompts; pass `--container NAME` / `--proxy-container NAME` to skip the prompts. If your stack is unrecognisable, the script prints the snippet and tells you exactly where to put it.

If you manage your stack with Docker Compose and prefer to wire the daemon in yourself, copy the supervised sidecar service from **[docker-compose.ws.example.yml](docker-compose.ws.example.yml)** into your compose project (it reuses your Nextcloud image + volumes, like Nextcloud's own `cron` sidecar) — see [docs/ws-sync-server.md](docs/ws-sync-server.md#docker-compose) for the topology and binding notes.

**Common flags:**

```bash
bash scripts/install-ws-daemon.sh --dry-run     # see the plan, change nothing
bash scripts/install-ws-daemon.sh --uninstall   # cleanly reverse the install
bash scripts/install-ws-daemon.sh --help        # all flags
```

### Manual install

If you'd rather do it by hand, the auto-detect doesn't fit your setup, or the script failed and you want explicit step-by-step instructions, follow **[docs/install-without-script.md](docs/install-without-script.md)**.

It covers bare-metal (Debian/Ubuntu/RHEL families with systemd) and Docker (single-container `nextcloud:latest`, multi-container with named volumes, jwilder/nginx-proxy, Caddy, Traefik), with copy-paste commands for every step and a "common failures and fixes" section.

For tunable parameters (drift thresholds, tombstone window, rate limits, etc.), see [docs/ws-sync-server.md](docs/ws-sync-server.md).

---

## How participants use it

1. A user creates a room in the Nextcloud UI. The dialog shows a one-time password and a share link — the password is **never** displayed again.
2. They share the link + password with whoever they want to watch with.
3. Each participant opens the link, presents the password, and the WebSocket sync keeps them aligned.

The browser-extension that drives the actual `<video>` element on the target site is on the roadmap (Phase 3).

---

## For developers

```bash
# Frontend (Vue 3 + Pinia)
npm install
npm run dev          # builds the bundle once
npm run watch        # rebuild on change

# Backend (PHP)
composer install
npm run test:php     # PHPUnit, runs inside the Nextcloud Docker container

# WebSocket daemon (supervised sidecar; survives crashes + container restarts)
./start-ws-server                                  # docker compose up -d the daemon
docker compose -f docker-compose.ws.yml logs -f ws # follow its log
docker compose -f docker-compose.ws.yml stop       # graceful SIGTERM stop
```

The repo is set up to work inside the [`nextcloud-docker-dev`](https://github.com/juliusknorr/nextcloud-docker-dev) workspace; the `test:php` script execs into the container directly. `start-ws-server` assumes the default `master` compose project (container `master-nextcloud-1`) — see the comments in [docker-compose.ws.yml](docker-compose.ws.yml) if yours differs.

| Document | Best for… |
|---|---|
| [docs/architecture.md](docs/architecture.md) | The system overview and how requests flow end-to-end |
| [docs/backend.md](docs/backend.md) | PHP under `lib/`: bootstrap, DB, services, controllers |
| [docs/frontend.md](docs/frontend.md) | Vue under `src/`: stores, components, l10n |
| [docs/api.md](docs/api.md) | The HTTP REST contract |
| [docs/ws-sync-server.md](docs/ws-sync-server.md) | Operator guide for the WebSocket daemon |
| [docs/ws-protocol.md](docs/ws-protocol.md) | Wire-format reference for the WebSocket protocol |
| [docs/configuration.md](docs/configuration.md) | All `IAppConfig` keys and `occ` commands |

Per-feature shaping documents live under [`agent-os/specs/`](agent-os/specs/) — read them when you've forgotten *why* a slice of the code looks the way it does.

---

## License

[AGPL-3.0-or-later](LICENSE).
