# Standards for Admin "restart the WS daemon" button

Two standards apply.

---

## backend/php-conventions

> Applies to: the daemon `POST /admin/restart` route, `AdminRestartClient`,
> `DaemonRestartFailedException`, and the `restartDaemon()` controller action.

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
- Annotate actions with `@NoAdminRequired` and `@NoCSRFRequired` where appropriate
- Use `Util::addScript('playbacksync', 'playbacksync-main')` to enqueue the compiled bundle
- Return `TemplateResponse` for page routes

> Note for this work: `AdminSettingsController` is admin+CSRF by **default** (no
> `#[NoAdminRequired]`), so `restartDaemon()` adds no attributes. Services auto-wire by
> type-hint (no explicit DI registration), like the existing admin clients. Per CLAUDE.md:
> no SPDX/author headers; comments explain *why*.

---

## frontend/vue-conventions

> Applies to: the Restart button, confirm dialog, post-save prompt, the store action,
> and the API function.

- Component structure: `<script setup lang="ts">` (Composition API). No Options API.
- `@nextcloud/vue` components (this app imports per-component, e.g.
  `import NcButton from '@nextcloud/vue/components/NcButton'`).
- Translations: every user-facing string through `t('playbacksync', …)`; keys added to
  **both** `l10n/en.js` and `l10n/nl.js`. Never hardcode UI text.
- Icons: `vue-material-design-icons/*.vue` with `:size` (20 for inline/buttons).
- State: Pinia stores in `src/stores/`.
- Styles: `<style scoped>` in every SFC.
