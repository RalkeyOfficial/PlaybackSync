<p align="center">
  <img src="design/v1/logo-lockup.svg" alt="PlaybackSync" width="540">
</p>

<p align="center">
  <strong>Watch videos in sync with friends, hosted on your own Nextcloud.</strong><br>
  <sub>Coordinates timestamps and play/pause across viewers — never relays the video itself.</sub>
</p>

---

## What it is

PlaybackSync keeps a small group watching the same video **in lockstep** — when one person plays, pauses, or seeks, everyone else follows within a few hundred milliseconds. Each participant streams the video from their own browser; PlaybackSync only shuttles around the *timing*.

Because the video bytes never touch the server, PlaybackSync runs comfortably on a self-hosted Nextcloud with home-grade bandwidth. Synchronising a play/pause/seek is a few hundred bytes — relaying a 1080p stream to six people is not.

It has three parts:

| Part | What it does | Who installs it |
|---|---|---|
| **Nextcloud app** | Rooms UI, database, REST API, admin settings | Server admin |
| **WebSocket daemon** | Long-running PHP process that relays real-time playback events | Server admin |
| **Browser extension** | Drives the `<video>` element on the site you're watching | Each participant |

The first two live in this repo and are installed once per server. The extension is installed per-person, in each viewer's browser.

## What works today

- **Rooms** — create, share, and auto-expire rooms from the Nextcloud UI, with a one-time password per room and a TTL prune job.
- **Real-time sync** — the WebSocket daemon handles join/leave, play/pause/seek, heartbeat-based drift correction, and reconnect-with-replay so a viewer who drops out catches back up.
- **Room modes** — Default, Single, and Freeform, with a mode suggestion from the pasted video URL.
- **Browser extension** — connects from a share link, drives the player, arbitrates across multiple tabs, and exposes a toolbar popup with live room status.
- **Admin controls** — tune drift thresholds, rate limits, and room defaults from the admin settings page, and restart or hot-reload the daemon without touching a terminal.

### Supported sites

Driving a real video player is site-specific, so the extension ships **per-site adapters**. Today it includes:

- **[miruro](https://www.miruro.to)** — full adapter (play/pause/seek sync, episode-aware cursor changes).
- **`_template`** — a baseline adapter + smoke-test page for building new ones.

Adding a site is writing one adapter against a small contract — see [extension/docs/](extension/docs/) for the adapter guide.

---

## Setup

### Server (admin)

The server side is the Nextcloud app plus the WebSocket daemon. An installer handles both bare-metal and Docker setups; pick the one that matches yours.

**Bare-metal (Debian, Ubuntu, RHEL/Rocky, openSUSE):**

```bash
cd /var/www/nextcloud/apps-extra
git clone https://github.com/RalkeyOfficial/PlaybackSync.git playbacksync
sudo bash playbacksync/scripts/install-ws-daemon.sh
```

It auto-detects the Nextcloud path, web server (nginx or Apache), vhost config, and init system, then does everything: `composer install`, `occ app:enable`, the `IAppConfig` keys, the systemd unit, the reverse-proxy snippet (idempotent, marker-bracketed), web-server reload, service start, and a WebSocket handshake to verify.

**Docker (single-container, multi-container with separate proxy, jwilder/nginx-proxy, traefik, custom):**

Clone the repo into your apps directory inside the Nextcloud container's mounted code path, then run on the host:

```bash
bash playbacksync/scripts/install-ws-daemon.sh --docker
```

It auto-detects the Nextcloud container, the reverse-proxy container, and the compose project, and replicates all NC mounts into a sidecar service. It picks the right proxy strategy: `vhost.d` drop-in for nginx-proxy (no reload), edit-on-host for bind-mounted configs, `docker cp` as a last resort with a clear "this won't survive a rebuild" warning.

If detection finds multiple candidates it prompts; pass `--container NAME` / `--proxy-container NAME` to skip the prompts. If your stack is unrecognisable, the script prints the snippet and tells you exactly where to put it.

Prefer to wire the daemon in yourself? Copy the supervised sidecar service from **[docker-compose.ws.example.yml](docker-compose.ws.example.yml)** into your compose project (it reuses your Nextcloud image + volumes, like Nextcloud's own `cron` sidecar) — see [docs/ws-sync-server.md](docs/ws-sync-server.md#docker-compose) for the topology and binding notes.

**Common flags:**

```bash
bash scripts/install-ws-daemon.sh --dry-run     # see the plan, change nothing
bash scripts/install-ws-daemon.sh --uninstall   # cleanly reverse the install
bash scripts/install-ws-daemon.sh --help         # all flags
```

If the auto-detect doesn't fit your setup, or you'd rather do it by hand, follow **[docs/install-without-script.md](docs/install-without-script.md)** — step-by-step bare-metal and Docker instructions with a "common failures and fixes" section. For tunable parameters (drift thresholds, tombstone window, rate limits), see [docs/ws-sync-server.md](docs/ws-sync-server.md).

### Browser extension (each participant)

The extension is distributed as an unpacked build you load yourself — there's no store listing to wait on, and installing it takes a minute.

```bash
cd extension
npm install
npm run build           # → .output/chrome-mv3/
npm run build:firefox   # → .output/firefox-mv2/   (Firefox)
```

Then load it:

- **Chrome / Edge / Brave** — open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select `extension/.output/chrome-mv3/`.
- **Firefox** — open `about:debugging#/runtime/this-firefox`, click **Load Temporary Add-on**, and select any file inside `extension/.output/firefox-mv2/`.

See [extension/README.md](extension/README.md) for development builds (HMR), the layout, and an end-to-end smoke test.

---

## How a watch session works

1. **Create a room.** A user creates a room in the Nextcloud UI and pastes the video URL. The dialog shows a one-time password and a share link — the password is **never** shown again.
2. **Share it.** Send the link + password to whoever you're watching with. Everyone needs the browser extension installed.
3. **Join.** Each participant opens the share link and, at the browser's login prompt, enters the password while **leaving the username field empty**, then lands on the video. The extension picks up the credentials from the link, connects to the daemon, and from then on play/pause/seek stays in sync for everyone in the room.

---

## For developers

```bash
# Frontend (Vue 3 + Pinia)
npm install
npm run dev          # build the bundle once (development mode)
npm run watch        # rebuild on change
npm run build        # production build
npm run lint         # ESLint over src/   (lint:fix to autofix)
npm run stylelint    # style lint over src/

# Backend (PHP)
composer install
npm run test:php          # PHPUnit, runs inside the Nextcloud Docker container
npm run test:php:testdox  # same, human-readable output

# Browser extension (WXT — builds Chromium MV3 + Firefox MV2 from one source)
npm run dev:extension          # HMR dev build (Chromium)
npm run build:extension        # production build
npm run build:extension:firefox

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
| [extension/README.md](extension/README.md) | The browser extension: build, layout, adapter contract |

Per-feature shaping documents live under [`agent-os/specs/`](agent-os/specs/) — read them when you've forgotten *why* a slice of the code looks the way it does.

---

## License

[AGPL-3.0-or-later](LICENSE).
