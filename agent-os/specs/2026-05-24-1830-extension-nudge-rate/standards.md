# Standards for `nudge-rate` for `SYNC_ADJUST`

No standards from `agent-os/standards/index.yml` apply to this work.

The indexed standards cover:

- `backend/php-conventions` — Nextcloud PHP server-side conventions. Not applicable: this slice touches only the browser-extension TypeScript modules.
- `frontend/vue-conventions` — Vue 3 SFC / `@nextcloud/vue` patterns. Not applicable: the extension is framework-free vanilla TS.
- `tooling/build` — Vite build setup for the Nextcloud-side app. Not applicable: the extension uses WXT, not the app's Vite config.

The project-wide conventions that *do* apply are in `CLAUDE.md` at the repo root:

- **No author / license / SPDX headers in any file.** Functional JSDoc with real `@param` descriptions is welcome; "no docblock boilerplate" applies only to the author/license/SPDX kind.
- **Don't disable `jsdoc/*` ESLint rules to silence missing-description warnings; fill them in.**

These are not in the standards index but are load-bearing for the slice — every new public symbol (`setPlaybackRate`, `nudge_rate`) gets a real JSDoc paragraph that explains *why* and *how to apply*.
