# Admin Settings Page for PlaybackSync

## Context

PlaybackSync currently exposes its backend tunables only via `IAppConfig` keys — there is no UI to inspect or change them. WebSocket sync timeouts, daemon host/port bindings, room defaults, and the auto-generated admin shared secret all live in config but have no admin entry point. Today's only ways to change them are `occ config:app:set` or editing values directly.

This change adds a Nextcloud-style **Administration settings page** at `/index.php/settings/admin/playbacksync` (mirroring the openregister pattern) so an instance admin can configure every backend tunable from the Nextcloud admin UI. The page is registered as an admin settings section — it is *not* added to the regular app navigation. Two values currently hardcoded as PHP constants (`MAX_TTL_SECONDS`, `MAX_CLIENTS_PER_ROOM`) are promoted to `IAppConfig` so they become tunable too.

User-locked decisions:
- Scope: WS sync tuning (9 keys) + daemon binding (4 keys) + room defaults (2 keys) + secret rotation, all on one page.
- Promote `MAX_TTL_SECONDS` and `MAX_CLIENTS_PER_ROOM` into config.
- Hydrate the Vue page via API on mount (no `IInitialState`).
- No mockups; just match the existing app aesthetic with `NcSettingsSection` groupings.

## Plan

### Task 1 — Save spec documentation

Create `agent-os/specs/2026-05-10-1520-admin-settings-page/` with `plan.md`, `shape.md`, `standards.md`, `references.md`, `visuals/`.

### Task 2 — Promote hardcoded constants to config

- `lib/Service/RoomService.php`: drop `MAX_TTL_SECONDS` constant; add private `getMaxTtlSeconds()` reading `max_ttl_seconds` (default 86400). Replace usages.
- Extend `lib/WebSocket/WsConfig.php` with `public readonly int $maxClientsPerRoom`, populated via `getValueInt($app, 'max_clients_per_room', 50)`.
- `lib/WebSocket/Admin/PresenceController.php`: convert `MAX_CLIENTS_PER_ROOM` from `public const` to a constructor `int`. Update DI in `lib/AppInfo/Application.php`.

### Task 3 — Backend settings classes + registration

- `lib/Sections/AdminSection.php` implementing `IIconSection` (id `'playbacksync'`, priority 75, app-dark.svg icon).
- `lib/Settings/AdminSettings.php` implementing `ISettings` (section `'playbacksync'`, priority 50, returns `TemplateResponse('playbacksync', 'settings/admin', [], 'admin')`).
- Register in `appinfo/info.xml` via `<settings>` block.

### Task 4 — Admin secret service

- `lib/Service/AdminSecretService.php`: `generate()`, `peekMasked()`, `rotate()`.
- Refactor `lib/Migration/EnsureAdminSecret.php` to delegate.

### Task 5 — Controller + routes

- `lib/Controller/AdminSettingsController.php` extends `OCP\AppFramework\Controller`. Default attrs (admin-required, CSRF-required).
- Methods: `index()`, `update(array $values)`, `regenerateAdminSecret()`.
- Routes: `admin_settings#index` GET, `admin_settings#update` PUT, `admin_settings#regenerateAdminSecret` POST under `/api/v1/admin/settings`.
- Server-side validation rules per field (see plan).

### Task 6 — Template

`templates/settings/admin.php` enqueues `playbacksync-adminSettings` script + `main` style; renders `<div id="playbacksync-admin-settings"></div>`.

### Task 7 — Vite entry + Vue bootstrap

`vite.config.ts` adds `adminSettings: 'src/adminSettings.ts'` second entry. `src/adminSettings.ts` mounts the root view.

### Task 8 — Pinia store + API service

- `src/services/adminSettingsApi.ts`: `fetchAdminSettings`, `updateAdminSettings`, `regenerateAdminSecret`.
- `src/stores/adminSettings.ts`: state + actions (per-section save).

### Task 9 — Vue components

`src/views/AdminSettings.vue` with four `NcSettingsSection` blocks: WS Tuning, Daemon Binding, Rooms, Security.

### Task 10 — Localization

Add new keys to both `l10n/en.js` and `l10n/nl.js` with real Dutch translations.

### Task 11 — Build & verify

`npm run build`, `occ upgrade`, manual end-to-end checks.

## Critical files

**To create**
- lib/Sections/AdminSection.php
- lib/Settings/AdminSettings.php
- lib/Service/AdminSecretService.php
- lib/Controller/AdminSettingsController.php
- templates/settings/admin.php
- src/adminSettings.ts
- src/views/AdminSettings.vue
- src/services/adminSettingsApi.ts
- src/stores/adminSettings.ts

**To modify**
- appinfo/info.xml
- appinfo/routes.php
- lib/AppInfo/Application.php
- lib/WebSocket/WsConfig.php
- lib/WebSocket/Admin/PresenceController.php
- lib/Service/RoomService.php
- lib/Migration/EnsureAdminSecret.php
- vite.config.ts
- l10n/en.js, l10n/nl.js

## Pitfalls

- No SPDX/author/license headers in any new PHP file.
- All visible strings via `t('playbacksync', …)`, present in both `en.js` and `nl.js`.
- `@nextcloud/vue` only — no native form elements.
- camelCase prop names.
- Admin entry is additive; don't replace `main`.
- Confirm-before-rotate is mandatory.
- Server-side validation is the security boundary.
