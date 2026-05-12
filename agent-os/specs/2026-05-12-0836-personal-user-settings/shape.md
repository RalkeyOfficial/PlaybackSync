# Personal User Settings — Shaping Notes

## Scope

A user-scoped personal settings surface for the PlaybackSync rooms dashboard. Entry point is a gear button in the bottom-left footer of the rooms panel, opening an `NcDialog`-based modal. The first (and currently only) setting is the auto-refresh interval for the rooms list, in seconds. The dialog and store are structured to grow — additional per-user settings drop in without restructuring.

## Decisions

- **Storage**: Server-side via Nextcloud's `IConfig::setUserValue` / `getUserValue` so preferences sync across devices. App-key namespace is `playbacksync` (= `Application::APP_ID`). Stored as integer milliseconds for symmetry with the admin tuning constants.
- **Validation**: `auto_refresh_interval_ms` in `[2_000, 600_000]` (2s–10min). Out-of-range patches rejected `400` with no values written. Mirrors `AdminSettingsController::validate`.
- **Auth**: Methods annotated `#[NoAdminRequired]`; `IUserSession` injected to fetch the UID. If no user is logged in, return `401` (defensive — Nextcloud middleware should already gate this).
- **Modal style**: `NcDialog` containing `NcSettingsSection` — matches `AdminSettings.vue` look and scales with more settings.
- **Button placement**: Footer row appended to the existing `.rooms-panel` flex column, left-aligned. Stays in document flow, no overlay/absolute positioning.
- **Dynamic interval wiring**: `useAutoRefresh` captures `intervalMs` once at setup. Rather than refactor it to accept a `Ref`, we set `:key` on `AutoRefreshRing` so the component remounts cleanly when the user saves a new value. The change happens only on Save, so the remount cost is irrelevant.
- **localStorage on/off toggle untouched**: The existing `playbacksync:rooms:auto-refresh` flag is ephemeral UI state, not a synced preference. Out of scope here.
- **Failed loads stay silent**: On a `load()` failure the store keeps the in-memory `15_000` default and logs the error. The UI was not initiated by the user (it's mount-time fetch), so a toast would be noise.

## Context

- **Visuals**: None provided. Implementation follows the existing `AdminSettings.vue` look-and-feel.
- **References**: The admin-settings flow (`AdminSettingsController` → `adminSettingsApi.ts` → `adminSettings.ts` store → `AdminSettings.vue` view) is the working template — same pattern, scoped to user values instead of app values, surfaced via a modal instead of a settings page.
- **Product alignment**: PlaybackSync targets low-end self-hosted groups (per `agent-os/product/mission.md`). Letting users dial back the polling cadence is friendly to under-resourced servers and battery-constrained clients.

## Standards Applied

- `backend/php-conventions` — strict types, `OCP\` imports only, controller annotations, `Application::APP_ID` constant
- `frontend/vue-conventions` — `<script setup lang="ts">`, `@nextcloud/vue` components, `t('playbacksync', …)`, Pinia store, scoped styles
- Project `CLAUDE.md` — no SPDX/author headers, real PHPDoc/JSDoc with descriptions, no hyphenated prop names, l10n keys in both `en.js` and `nl.js`
