# Standards for Event Log (SSE)

The following standards from `agent-os/standards/` apply to this work.

---

## backend/php-conventions

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

- Annotate actions with `@NoAdminRequired` and `@NoCSRFRequired` where appropriate (PHPDoc block above the method)
- Use `Util::addScript('playbacksync', 'playbacksync-main')` to enqueue the compiled frontend bundle
- Return `TemplateResponse` for page routes

### Additional project rules from CLAUDE.md

- **No SPDX / `@author` / `@copyright` headers anywhere** — applies to every new PHP/TS/Vue file in this spec.
- Real PHPDoc with meaningful `@param` descriptions where they help — never empty `/** */` skeletons.

---

## frontend/vue-conventions

### Component structure

Use `<script setup lang="ts">` (Composition API). No Options API.

### @nextcloud/vue imports

Import components from the package root:

```ts
import { NcContent, NcAppNavigation } from '@nextcloud/vue'
```

### Translations

```ts
import { translate as t } from '@nextcloud/l10n'
// usage
t('playbacksync', 'My string')
```

All user-facing strings must go through `t()`. Never hardcode UI text.

### Icons

```ts
import IconSync from 'vue-material-design-icons/Sync.vue'
// usage
<IconSync :size="20" />
```

Use `:size` in pixels. Navigation icons: 20. Hero/empty-state icons: 64.

### State

Use Pinia for global state. Create stores in `src/stores/`.

### Styles

Use `<style scoped>` in every SFC. No global styles from components.

### Additional project rules from CLAUDE.md

- **Always use `@nextcloud/vue` components when one fits.** Never use native `<select>`, `<input>`, or hand-rolled `<label>` wrappers when an Nc equivalent exists.
- Dropdowns → `NcSelect`. Single-line inputs → `NcTextField`. Buttons → `NcButton`. Action menus → `NcActions` + `NcActionButton`. Dialogs → `NcDialog`. Loading → `NcLoadingIcon`. Empty states → `NcEmptyContent`. Info/warning → `NcNoteCard`. Settings → `NcSettingsSection`.
- **Pass labels via the component's prop** (`:label`, `:inputLabel`).
- **camelCase prop names** in templates (`:inputLabel`, not `:input-label`).
- **Localize every user-facing string** — wrap with `t('playbacksync', '…')` and add the key to **both** `l10n/en.js` and `l10n/nl.js` in the same change. Real Dutch translations, not English copies.

---

## tooling/build

### Vite multi-entry

Both compiled bundles receive new code:
- `src/index.ts` → `playbacksync-main` (dashboard) — picks up the new `useEventSource` composable, `RoomEventLog`, modified `RoomDetailDialog`.
- `src/adminSettings.ts` → `playbacksync-admin-settings` (admin) — picks up the new "Recent activity" section.

`vite.config.ts` `relativeCSSInjection: true` already handles multi-entry CSS, no config change needed.
