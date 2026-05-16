# Standards for Single Mode

The following standards apply to this work.

---

## backend/php-conventions

# PHP Backend Conventions

All PHP files start with:
```php
<?php
declare(strict_types=1);
```

## Application bootstrap

- `Application` extends `App` and implements `IBootstrap`
- Always define `APP_ID` as a constant — use it everywhere the app slug is needed
- Register services/listeners in `register()`, perform boot logic in `boot()`

## Namespaces and imports

- Only import from `OCP\` — never `OC\` (internal, unstable Nextcloud API)
- App namespace: `OCA\PlaybackSync\`

## Controllers

- Annotate actions with `@NoAdminRequired` and `@NoCSRFRequired` where appropriate (PHPDoc block above the method)
- Use `Util::addScript('playbacksync', 'playbacksync-main')` to enqueue the compiled frontend bundle
- Return `TemplateResponse` for page routes

---

## frontend/vue-conventions

# Vue Frontend Conventions

## Component structure

Use `<script setup lang="ts">` (Composition API). No Options API.

## @nextcloud/vue imports

Import components from the package root:

```ts
import { NcContent, NcAppNavigation } from '@nextcloud/vue'
```

## Translations

```ts
import { translate as t } from '@nextcloud/l10n'
// usage
t('playbacksync', 'My string')
```

All user-facing strings must go through `t()`. Never hardcode UI text.

## Icons

```ts
import IconSync from 'vue-material-design-icons/Sync.vue'
// usage
<IconSync :size="20" />
```

Use `:size` in pixels. Navigation icons: 20. Hero/empty-state icons: 64.

## State

Use Pinia for global state. Create stores in `src/stores/`.

## Styles

Use `<style scoped>` in every SFC. No global styles from components.

---

## Additional per-project rules (from `CLAUDE.md`)

- No author / license / SPDX headers in any file.
- Comments explain the *why*, not the *what*.
- **Always use `@nextcloud/vue` components** when one fits. Dropdowns → `NcSelect`; single-line inputs → `NcTextField`; buttons → `NcButton`; action menus → `NcActions` + `NcActionButton`; dialogs → `NcDialog`; loading → `NcLoadingIcon`; empty states → `NcEmptyContent`; info / warning → `NcNoteCard`.
- Pass labels via the component prop (`:label`, `:inputLabel`). Do not wrap an Nc form component in a manual `<label>`.
- Use camelCase prop names in templates (`:inputLabel`, `:helperText`); hyphenated forms are flagged by ESLint.
- Localize every user-facing string. Add the key to **both** `l10n/en.js` and `l10n/nl.js` with a real Dutch translation. Drop dead keys.
- PHP testing requires Docker: `docker exec -u www-data master-nextcloud-1 sh -c "cd /var/www/html/apps-extra/playbacksync && phpunit"`.
