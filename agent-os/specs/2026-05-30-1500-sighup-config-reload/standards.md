# Standards for SIGHUP config-reload

Two standards apply.

---

## backend/php-conventions

> Applies to: `WsConfig` (refresh), `PresenceController` (live-read), the new
> `ReloadController`, `AdminReloadClient`, `DaemonReloadFailedException`, and
> `AdminSettingsController::reloadDaemon()`.

All PHP files start with:
```php
<?php
declare(strict_types=1);
```

### Application bootstrap
- `Application` extends `App` and implements `IBootstrap`
- Always define `APP_ID` as a constant — use it everywhere the app slug is needed
- Register services/listeners in `register()`, perform boot logic in `boot()`

### Namespaces and imports
- Only import from `OCP\` — never `OC\` (internal, unstable Nextcloud API)
- App namespace: `OCA\PlaybackSync\`

### Controllers
- Annotate actions with `@NoAdminRequired` / `@NoCSRFRequired` where appropriate
- `AdminSettingsController` is admin+CSRF by default → `reloadDaemon()` needs no attributes

> Daemon-side services (`ReloadController`) auto-wire by type-hint. Per CLAUDE.md: no
> SPDX/author headers; comments explain *why* (e.g. why binding keys are intentionally
> not reloaded).

---

## frontend/vue-conventions

> Applies to: the `reloadDaemon()` Pinia action and the apply-on-save wiring in
> `AdminSettings.vue`.

- `<script setup lang="ts">` (Composition API).
- Per-component `@nextcloud/vue` imports.
- Every user-facing string through `t('playbacksync', …)`; keys added to **both**
  `l10n/en.js` and `l10n/nl.js`.
- Pinia store actions in `src/stores/`; toasts via `@nextcloud/dialogs`
  (`showSuccess` / `showWarning`).
