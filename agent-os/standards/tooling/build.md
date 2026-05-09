# Build Tooling

## Vite

Use `@nextcloud/vite-config`'s `createAppConfig` — do not use raw `defineConfig`:

```ts
import { createAppConfig } from '@nextcloud/vite-config'

export default createAppConfig({ main: 'src/index.ts' }, {
  inlineCSS: false,
  thirdPartyLicense: undefined,
  createEmptyCSSEntryPoints: true,
  emptyOutputDirectory: { additionalDirectories: ['css'] },
})
```

CSS is emitted as separate files (not inlined). The entry `main` compiles to `playbacksync-main`.

## Scripts

| Command | Purpose |
|---|---|
| `npm run build` | Production build |
| `npm run dev` | Development build (one-shot) |
| `npm run watch` | Development build + watch |
| `npm run lint` / `lint:fix` | ESLint |
| `npm run stylelint` / `stylelint:fix` | Stylelint |

## Engine requirements

Node `^24.0.0`, npm `^11.3.0` (enforced via `engines` in package.json).

## ESLint

Extends `@nextcloud/eslint-config` recommended — no additional rules needed.
