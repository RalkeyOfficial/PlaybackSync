# Tech Stack

## Frontend (Nextcloud dashboard)

- **Vue 3** with TypeScript
- **Vite** via `@nextcloud/vite-config` for bundling
- **Pinia** for state management
- **@nextcloud/vue** component library — always prefer Nc components over native primitives (see [`CLAUDE.md`](../../CLAUDE.md))
- **@nextcloud/axios**, **@nextcloud/router**, **@nextcloud/l10n**, **@nextcloud/initial-state** for Nextcloud integration
- **EventSource** API for SSE-driven event log streaming

## Backend (Nextcloud app)

- **PHP** via the Nextcloud app framework (OCP) — controllers, services, repair steps, settings sections, background jobs under [`lib/`](../../lib/)
- **PHPUnit** for the test suite (runs inside the Nextcloud Docker dev environment)
- **`IAppConfig`** for sensitive app configuration (room secrets, HMAC shared secret) — auto-rotated by `IRepairStep` on enable/upgrade
- **`IThrottler`** rate-limiting for the public share endpoint
- **Argon2id** password hashing for rooms

## WebSocket sync daemon

- Long-running daemon via [`occ playbacksync:ws-serve`](../../lib/Command/WsServe.php) (Symfony Console command)
- **Ratchet** (WebSocket server) on top of **ReactPHP** (event loop) — single process, in-memory runtime, persisted state lives in the Nextcloud DB
- Wire-format contract documented canonically in [`docs/ws-protocol.md`](../../docs/ws-protocol.md) (v2 — playlist + cursor data substrate)
- **Loopback admin HTTP** (default `127.0.0.1:8766`) for PHP ↔ daemon coordination, HMAC-SHA256 signed (`X-PBSync-Admin: t=…,sig=…`) over `(method, path, ts)` with a ±30 s replay window
- **SSE** streams (`/admin/events/stream`, `/admin/rooms/{uuid}/events/stream`) backed by per-room and global in-memory ring buffers

## Browser extension

- **WXT** (Vite-based extension framework) — file-based entrypoints, HMR, single source → both Chromium MV3 and Firefox MV2 manifests
- **TypeScript** (extends WXT's generated `.wxt/tsconfig.json`)
- **ESLint 9** flat config: `@eslint/js` recommended + `typescript-eslint` recommended + WXT auto-imports module
- Targets Chromium-based browsers and Firefox; per-machine browser binary overrides via a gitignored `web-ext.config.ts`
- Owns one authoritative WebSocket connection per browser profile in its background service worker; content scripts are pure executors

## Database

- Nextcloud's built-in ORM (`QBMapper` / `IDBConnection`) — SQLite, MySQL, or PostgreSQL depending on the host instance
- Migrations live under [`lib/Migration/`](../../lib/Migration/)
- Persisted state: rooms, playlist entries, cursor; ephemeral state (presence, runtime cache, event log ring) stays in daemon memory

## Platform

- **Nextcloud app** (min version 34), distributed as an installable app
- Targets self-hosted Nextcloud instances on low-bandwidth servers (no media relay — only coordination)
- Reverse proxy forwards `/apps/playbacksync/ws/{uuid}` to the daemon's WS port
