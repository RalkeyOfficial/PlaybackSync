# Standards for Content Model Protocol

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

## Project-wide CLAUDE.md additions

These are repeated from [CLAUDE.md](../../../CLAUDE.md) — they apply throughout this spec:

- No `@author` / `@copyright` / `SPDX-*` headers in any file.
- Comments explain *why*, not *what*. Default to writing no comments.
- `@nextcloud/vue` components always preferred over native primitives (`NcSelect`, `NcTextField`, `NcButton`, `NcActions`, `NcDialog`, `NcLoadingIcon`, `NcEmptyContent`, `NcNoteCard`).
- camelCase prop names in templates (`:inputLabel`, not `:input-label`).
- Every new user-facing string lands in **both** `l10n/en.js` and `l10n/nl.js` with a real Dutch translation.
- Real JSDoc / PHPDoc with descriptions is welcome; empty boilerplate skeletons are not.
- PHPUnit runs inside Docker:
  ```
  docker exec -u www-data master-nextcloud-1 sh -c "cd /var/www/html/apps-extra/playbacksync && phpunit"
  ```
