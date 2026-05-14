# Standards for Content Model Default Mode

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

## Project-specific layered rules (from CLAUDE.md)

In addition to the above:

- **No author / license / SPDX headers** in any file (`@author`, `@copyright`, `SPDX-FileCopyrightText`, `SPDX-License-Identifier`, …).
- Comments explain *why*, not *what*. Real JSDoc / PHPDoc descriptions are welcome — never leave empty `/** */` skeletons. Don't disable `jsdoc/*` ESLint rules; fill in the descriptions.
- **Always use `@nextcloud/vue` components** when one exists — `NcSelect`, `NcTextField`, `NcInputField`, `NcButton`, `NcActions` + `NcActionButton`, `NcDialog`, `NcLoadingIcon`, `NcEmptyContent`, `NcNoteCard`, `NcCheckboxRadioSwitch`. No native `<select>`, `<input>`, or hand-rolled `<label>` wrappers.
- **Pass labels via the component prop** (`:label`, `:inputLabel`). Don't wrap an Nc form component in a manual `<label>`.
- **camelCase prop names** in templates (`:inputLabel`, `:helperText`). The hyphenated form (`:input-label`) triggers eslint errors.
- **Localize every user-facing string.** `t('playbacksync', '…')`; add the key to **both** `l10n/en.js` and `l10n/nl.js`. Real Dutch translation, not a copy of the English.
