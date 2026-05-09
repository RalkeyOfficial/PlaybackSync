# Tech Stack

## Frontend

- **Vue 3** with TypeScript
- **Vite** (via `@nextcloud/vite-config`) for bundling
- **Pinia** for state management
- **@nextcloud/vue** component library
- **@nextcloud/axios**, **@nextcloud/router**, **@nextcloud/l10n**, **@nextcloud/initial-state** for Nextcloud integration

## Backend

- **PHP** via the Nextcloud app framework (OCP)
- Controllers and app bootstrap under `lib/`
- WebSocket sync coordinator (protocol defined in OLD_CODE docs — server-authoritative, in-memory, no database for room state)

## Database

- Nextcloud's built-in ORM / database abstraction (SQLite, MySQL, or PostgreSQL depending on the Nextcloud instance)

## Platform

- **Nextcloud app** (min version 34), distributed as an installable app
- Targets Nextcloud instances self-hosted on low-bandwidth servers
