# Standards for `currentlyShowing` + `catalogFragment` on JOIN

The standards indexed at [agent-os/standards/index.yml](../../standards/index.yml) cover:

- `backend/php-conventions` — Nextcloud PHP conventions (strict types, OCP imports, annotations).
- `frontend/vue-conventions` — Vue 3 / `@nextcloud/vue` / l10n / Pinia patterns.
- `tooling/build` — Vite + Nextcloud build / npm scripts / ESLint.

**None apply to this work.** Every file touched lives under `extension/` (browser-extension TypeScript) or `extension/docs/` (in-tree authoring docs). No PHP, no Vue, no Vite-app code is modified.

The local conventions that DO apply:

- [CLAUDE.md](../../../CLAUDE.md) — repo-wide rules: no SPDX / author / license headers; comments explain *why*, not *what*; no empty docblocks; fill in JSDoc descriptions rather than disabling `jsdoc/*` ESLint rules.
- [extension/README.md](../../../extension/README.md) and the existing `extension/docs/adapter-contract.md` — adapter-authoring conventions: JSDoc with meaningful descriptions, no `@author`/`@copyright`, behavior-focused doc style.

This matches the standards posture of the two most recent adapter-touching specs ([nudge-rate](../2026-05-24-1830-extension-nudge-rate/standards.md), [multi-tab-arbitration](../2026-05-25-1530-extension-multi-tab-arbitration/standards.md)), which arrived at the same conclusion.
