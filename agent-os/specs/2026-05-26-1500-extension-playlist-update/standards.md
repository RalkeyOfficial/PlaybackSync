# Standards for `PLAYLIST_UPDATE` API + freeform-click fix

This spec is **extension-only** — no `lib/` PHP changes, no `src/` Vue changes, no `l10n/*.js` keys. The applicable standards are narrow.

## Project-wide code style (from `CLAUDE.md`)

- No author / license / SPDX headers in any file. No `@author`, `@copyright`, `SPDX-FileCopyrightText`, `SPDX-License-Identifier`.
- Comments explain *why*, not *what*. Real JSDoc with meaningful descriptions on `sendPlaylistUpdate` and on the updated `handleCursorTrigger` JSDoc — don't disable `jsdoc/*` rules to silence missing-description warnings.

## Tooling

[`tooling/build`](../../standards/tooling/build.md) — the extension TS goes through the standard Vite/WXT build. New code must pass `tsc` and `eslint` clean with no rule disables.

## Frontend conventions — *not* engaged

[`frontend/vue-conventions`](../../standards/frontend/vue-conventions.md) governs `@nextcloud/vue` usage, `t('playbacksync', …)` localization, and `<script setup>` patterns. **Not engaged** here:

- No changes to `src/` (the Nextcloud Vue app).
- No new popup UI; the popup is framework-free vanilla TS by design (see [`extension/docs/popup.md`](../../../extension/docs/popup.md)) and we add no copy here.
- No `l10n/*.js` keys touched.

## Backend conventions — *not* engaged

[`backend/php-conventions`](../../standards/backend/php-conventions.md) is not engaged. The server-side `PlaylistUpdateHandler`, `PlaylistService`, and `CursorService` stay as-is; their existing freeform-mode behavior is what this slice now leans on.
