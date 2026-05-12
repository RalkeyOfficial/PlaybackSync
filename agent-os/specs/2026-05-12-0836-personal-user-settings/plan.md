# Personal User Settings — Auto-Refresh Interval

## Context

Today the rooms dashboard polls every 15 seconds via a hardcoded `:intervalMs="15_000"` prop on `AutoRefreshRing` in [src/components/RoomsPanel.vue:7](../../../src/components/RoomsPanel.vue#L7). Users can pause/resume polling (the toggle persists in `localStorage`) but cannot change the cadence — which is too aggressive for some installs and too slow for others.

This change introduces a **personal user settings** surface, opened from a gear button in a new footer row on the rooms panel, that exposes an editable **auto-refresh interval (seconds)** as the first setting. Storage is server-side via Nextcloud's `IConfig` user values so the preference syncs across devices. The dialog and store are built to scale — additional per-user settings can land in the same modal later without restructuring.

The local `localStorage` flag that drives the on/off toggle (`playbacksync:rooms:auto-refresh`) stays untouched — that is ephemeral UI state, not a preference worth syncing.

---

## Task 1 — Save Spec Documentation

Create `agent-os/specs/2026-05-12-0836-personal-user-settings/` containing this `plan.md`, plus `shape.md`, `standards.md`, and `references.md`.

---

## Task 2 — Backend: UserSettingsController

Create `lib/Controller/UserSettingsController.php` mirroring `lib/Controller/AdminSettingsController.php`, with these differences:

- **No** admin gate — annotate the methods with `#[NoAdminRequired]` so any logged-in user can call them. CSRF middleware stays on by default.
- Inject `IConfig` (user-scoped) and `IUserSession` instead of `IAppConfig`. Reject calls when no user is logged in with `Http::STATUS_UNAUTHORIZED`.
- Use the user's UID with `IConfig::getUserValue` / `setUserValue` against `Application::APP_ID`.
- `INT_RULES` contains a single entry for now:
  - `auto_refresh_interval_ms`: min `2_000`, max `600_000` (2s–10min, stored in ms to match admin-tuning conventions)
- `INT_DEFAULTS`:
  - `auto_refresh_interval_ms` → `15_000`
- `index()` returns `DataResponse(['autoRefreshIntervalMs' => int])` — flat shape, no nesting needed for one field, but build it as a `snapshot()` method so adding sections later is trivial.
- `update(array $values = [])` validates, persists, and returns the refreshed snapshot. Reuse the `coerceInt` pattern from the admin controller.

Add two routes in `appinfo/routes.php` after the `admin_settings#*` block:

```php
['name' => 'user_settings#index', 'url' => '/api/v1/user/settings', 'verb' => 'GET'],
['name' => 'user_settings#update', 'url' => '/api/v1/user/settings', 'verb' => 'PUT'],
```

---

## Task 3 — Frontend: types, service, store

- **Types** — `src/types/userSettings.ts` exporting `UserSettingsSnapshot` (`{ autoRefreshIntervalMs: number }`) and `UserSettingsPatch` (partial flat map of server keys, e.g. `{ auto_refresh_interval_ms?: number }`).
- **Service** — `src/services/userSettingsApi.ts` mirroring `src/services/adminSettingsApi.ts`: `apiUrl()`, `fetchUserSettings()`, `updateUserSettings(patch)`. Hit `/apps/playbacksync/api/v1/user/settings`.
- **Store** — `src/stores/userSettings.ts` Pinia store (`useUserSettingsStore`) mirroring `src/stores/adminSettings.ts`: state `{ autoRefreshIntervalMs, loaded, loading, saving }`, actions `load()` and `save(patch)`. Reuse the `extractErrorMessage` and `showError`/`showSuccess` pattern. On `load()` failure, keep the in-memory default `15_000` — log the error but don't show a toast.

---

## Task 4 — Frontend: UserSettingsDialog component

Create `src/components/UserSettingsDialog.vue`:

- `NcDialog` with `v-model:open`, `size="normal"`, name `t('playbacksync', 'Personal settings')`.
- Inside: one `NcSettingsSection` with name `t('playbacksync', 'Dashboard')` and a short helper description.
- One `NcTextField` of `type="number"`, bound to a **seconds** computed mirror of the store's ms value. Props: `:label` "Auto-refresh interval (seconds)", `min="2"`, `max="600"`, `step="1"`, `inputmode="numeric"`, `:helperText` "How often the rooms list refreshes automatically."
- Footer Save button (`NcButton variant="primary"`) calls `store.save(...)`. Show `NcLoadingIcon` while `store.saving` is true. Close on success.
- Cancel button (`NcButton variant="tertiary"`) closes without saving — discard local edits via a local `ref` reset on open.
- All strings localized via `t('playbacksync', …)`.

---

## Task 5 — Frontend: RoomsPanel footer button and reactive interval

Modify `src/components/RoomsPanel.vue`:

1. **Footer row** — add a new `<footer class="rooms-panel__footer">` below the body. Inside it, an `NcButton` with `variant="tertiary"` and a cog icon, label `t('playbacksync', 'Settings')`. Style with `display: flex; justify-content: flex-start;` so it sits bottom-left.
2. **Reactive interval** — change `:intervalMs="15_000"` to `:intervalMs="userSettings.autoRefreshIntervalMs"`. Also set `:key="userSettings.autoRefreshIntervalMs"` on `AutoRefreshRing` so the composable re-initializes cleanly when the value changes.
3. **Load on mount** — call `userSettings.load()` alongside `store.load()` and `wsStatus.load()`.
4. **Dialog mount** — render `<UserSettingsDialog v-model:open="settingsDialogOpen" />`.
5. Add `const settingsDialogOpen = ref(false)` and `const userSettings = useUserSettingsStore()` in `<script setup>`.

---

## Task 6 — Localization

Add every new user-facing string to both `l10n/en.js` and `l10n/nl.js` — real Dutch translations:

- "Settings" → "Instellingen"
- "Personal settings" → "Persoonlijke instellingen"
- "Dashboard" → "Dashboard"
- "Auto-refresh interval (seconds)" → "Interval voor automatisch verversen (seconden)"
- "How often the rooms list refreshes automatically." → "Hoe vaak de kamerlijst automatisch wordt vernieuwd."
- "Cancel" already present, reuse.
- "Saved" / "Could not save settings." already present, reuse.

---

## Verification

1. `npm run build` and `composer dump-autoload` produce no errors.
2. Type checks pass (`vue-tsc --noEmit`).
3. `npm run lint` passes.
4. Manual end-to-end: open rooms page, change interval, Save, verify ring cadence, persistence across reload, error toasts on out-of-range, 401 when logged out.
5. Admin settings page unchanged.
