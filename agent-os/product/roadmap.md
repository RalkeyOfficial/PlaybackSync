# Product Roadmap

## Phase 1: MVP

- **Room creation & management** — Nextcloud users can create, join, and delete sync rooms via the Nextcloud UI.
- **WebSocket sync server** — Backend coordinator embedded in the Nextcloud app that relays play/pause/seek events between connected clients.
- **Drift correction** — Periodic server-driven reconciliation to keep all clients' playback position aligned, using server-authoritative time.

## Phase 2: Post-Launch

- **Browser extension** — Extension that hooks into external video players on supported streaming sites and syncs state through the Nextcloud WebSocket server.
