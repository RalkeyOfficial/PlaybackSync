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
