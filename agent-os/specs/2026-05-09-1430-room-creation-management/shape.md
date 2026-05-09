# Room Creation & Management — Shaping Notes

## Scope

The first MVP feature for PlaybackSync as a Nextcloud app: owner-only Room CRUD via the Nextcloud UI.

In scope:
- Logged-in Nextcloud users can create, list, and delete sync rooms.
- Rooms persist in a Nextcloud DB table (`oc_playbacksync_rooms`).
- Auto-generated 16-character password, hashed with `IHasher`, returned once at creation.
- `targetUrl` stored from day one (avoids future migration when the browser extension lands).
- Default 24h TTL, max 24h.
- Background job prunes expired rooms.

Out of scope (deferred):
- Public share/join endpoint with password gate.
- WebSocket sync server / drift correction.
- `last_state` column.
- Admin settings UI panel (use `occ` for now).
- Browser extension integration.
- Test suite (no infra exists yet).

## Decisions

- **Persistence:** DB table — PHP has no long-running process, so in-memory state from the OLD_CODE design doesn't fit.
- **Permissions:** Any logged-in user can create rooms by default. An admin can flip an `IAppConfig` toggle (`restrict_to_admins`) to limit creation to admins only.
- **Passwords:** Auto-generated 16-char alphanumeric using cryptographically random bytes; hashed with `OCP\Security\IHasher` (bcrypt). Plaintext is shown to the owner exactly once on creation and never retrievable thereafter.
- **TTL:** Default 24h, max 24h, owner can pick shorter (1h / 6h / 12h / 24h presets in the UI).
- **Share flow:** Deferred. The API returns a `shareLink` string for display/copy, but no public join endpoint exists yet.
- **API style:** Plain `Controller` returning `DataResponse`. Consumed only by this app's own frontend; the OCS envelope is unnecessary.
- **No vue-router:** App is a single page. Components mount directly inside `App.vue`'s `NcAppContent`.
- **Cleanup:** `TimedJob` runs hourly to prune expired rooms; controllers also filter expired rows on read.

## Context

- **Visuals:** None. UI uses Nextcloud defaults (`@nextcloud/vue` components).
- **References:** OLD_CODE/server/docs/ROOMS_API.md (legacy API surface), apps/user_status (Entity/Mapper/Migration/Controller pattern), apps/twofactor_backupcodes (IHasher pattern), apps/settings (Pinia store pattern). See [references.md](references.md).
- **Product alignment:** Matches Phase 1 MVP in [agent-os/product/roadmap.md](../../product/roadmap.md). Aligns with the mission of a Nextcloud-native, decentralized watch-party tool for low-bandwidth self-hosted setups.

## Standards Applied

- **backend/php-conventions** — applies because this introduces new PHP backend code (Application bootstrap, controllers, mapper, service, background job).
- **frontend/vue-conventions** — applies because this introduces new Vue 3 SFCs, Pinia stores, and l10n strings.

See [standards.md](standards.md) for full content.
