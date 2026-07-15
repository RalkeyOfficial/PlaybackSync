# PlaybackSync

A Nextcloud app for synchronized video playback across groups.

## Code Style

- No author, license, or SPDX headers in any file. Ever. This includes `@author`, `@copyright`, `SPDX-FileCopyrightText`, `SPDX-License-Identifier`, and the like.
- Comments are fine when they explain the *why*, not the *what*.
- "No docblock boilerplate" applies **only** to the author/license/SPDX kind of header. Real JSDoc / PHPDoc with meaningful descriptions is welcome — write proper `@param` descriptions, don't leave empty `/** */` skeletons. Functional PHPDoc like `@method` hints on `Entity` subclasses is not boilerplate.
- Don't disable `jsdoc/*` ESLint rules to silence missing-description warnings; fill in the descriptions.

## Frontend (Vue)

- **Always use `@nextcloud/vue` components when one fits.** Never use native `<select>`, `<input>`, or hand-rolled `<label><span>…</span>…</label>` wrappers when an Nc equivalent exists. Native primitives bypass Nextcloud's theming, accessibility, dark-mode, and validation styling.
  - Dropdowns → `NcSelect` (props: `:inputLabel`, `:options`, `:reduce`, `:clearable`)
  - Single-line inputs (text, url, number, password, …) → `NcTextField` — supports `type="number"` and forwards `min` / `max` / `step` / `inputmode` to the underlying input
  - Lower-level field primitive → `NcInputField` (NcTextField wraps it)
  - Buttons → `NcButton`; action menus → `NcActions` + `NcActionButton`; dialogs → `NcDialog`; loading → `NcLoadingIcon`; empty states → `NcEmptyContent`; info/warning → `NcNoteCard`
- **Pass labels via the component's prop** (`:label`, `:inputLabel`). Don't wrap an Nc form component in a manual `<label>` to attach a label.
- **Use camelCase prop names** in templates (`:inputLabel`, `:helperText`) — eslint-plugin-vue is configured to flag hyphenated forms (`:input-label`) as errors.
- **Localize every user-facing string.** Wrap with `t('playbacksync', '…')` and add the key to **both** `l10n/en.js` and `l10n/nl.js` in the same change. Provide a real Dutch translation, not a copy of the English. Drop keys that no longer have a referrer in `src/`.

## Browser Extension (WXT)

The extension under `extension/` is built with WXT and ships to both Chrome and Firefox from one codebase. Before touching anything under `extension/entrypoints/` or `extension/src/`, read the rules in @extension/WXT-AND-BROWSERS.md — use `browser.*` (never `chrome.*`), Chrome=MV3 / Firefox=MV2 (don't force a global `manifestVersion`), write manifest-version-agnostic code, and build both targets before committing.

## Old Code

This is a refactor / recode of the old (incomplete) version of this project to become a nextcloud app instead of a standalone app. Old code, alongside documentation, can be read in `./OLD_CODE`, which may give proper insight.
