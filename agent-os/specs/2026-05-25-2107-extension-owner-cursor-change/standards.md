# Standards for Owner-driven CURSOR_CHANGE_REQUEST

This spec is **extension-only** (no `lib/` PHP changes, no Vue/Nextcloud frontend changes). The applicable standards are narrow.

## Project-wide code style (from `CLAUDE.md`)

- No author / license / SPDX headers in any file. No `@author`, `@copyright`, `SPDX-FileCopyrightText`, `SPDX-License-Identifier`.
- Comments explain *why*, not *what*. The "no header boilerplate" rule does not apply to real JSDoc / PHPDoc with meaningful descriptions — those are welcome and required (don't disable `jsdoc/*` ESLint rules to silence missing-description warnings; fill them in).
- New methods on the `Adapter` contract get real `@param` / `@returns` descriptions.

## Frontend conventions — *not* engaged by this spec

The [`frontend/vue-conventions`](../../standards/frontend/vue-conventions.md) standard governs `@nextcloud/vue` usage, `t('playbacksync', …)` localization in `l10n/en.js` + `l10n/nl.js`, and `script setup` patterns. **None of this applies here** because:

- The extension popup is framework-free vanilla TS (intentional — see [`extension/docs/popup.md`](../../../extension/docs/popup.md)). No `NcButton`, no Vue, no Pinia.
- No changes to `src/` (the Nextcloud-app Vue tree).
- No changes to `l10n/*.js`.

If the popup adds new copy strings for the Rejoin button, follow whatever convention the existing popup uses for its current Leave Room copy.

## Tooling

[`tooling/build`](../../standards/tooling/build.md) — extension code runs through the same Vite build as the rest of the project. New files must pass `eslint` and `tsc` clean with no rule disables.

## Backend conventions — *not* engaged by this spec

[`backend/php-conventions`](../../standards/backend/php-conventions.md) is not engaged. The server-side `CursorChangeHandler`, `CursorService`, and `CursorTarget` DTO stay as-is.
