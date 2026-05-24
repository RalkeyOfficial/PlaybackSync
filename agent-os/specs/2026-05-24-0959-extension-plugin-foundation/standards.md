# Standards for Extension Plugin Foundation

## Applicable standards

**None.** The existing entries in `agent-os/standards/index.yml` are:

- `backend/php-conventions` — Nextcloud PHP conventions (strict types, IBootstrap, OCP imports, controller annotations). Not relevant: no PHP changes in this slice.
- `frontend/vue-conventions` — Vue 3 SFC patterns (`@nextcloud/vue` components, l10n, Pinia). Not relevant: the extension is not a Vue app and the Nextcloud Vue dashboard isn't touched.
- `tooling/build` — Vite setup, npm scripts, engine requirements, ESLint config for the Nextcloud-app side. Not relevant: the extension is a separate **WXT** project with its own `package.json`, `tsconfig.json`, and `eslint.config.mjs` under `extension/`.

## Project-local guidance that does apply

These come from the project root `CLAUDE.md` and the extension scaffold itself, not from `agent-os/standards/`:

- **No author / license / SPDX headers** in any file.
- **Comments explain the *why*, not the *what*.** Default to no comments.
- **TypeScript strict mode.** Already enforced by the WXT-generated `tsconfig.json`.
- **ESLint as the lint authority** — `extension/eslint.config.mjs` is the source of truth for the extension; don't disable rules to silence warnings.

## Note for future extension specs

When the extension grows enough to warrant its own standards (WXT entrypoint conventions, content/background message envelope rules, adapter-implementation checklist, MV3 vs MV2 packaging), add an `extension/` namespace to `agent-os/standards/index.yml` and write the docs there. Until then, the working agreements live in `CLAUDE.md` and in the per-spec `shape.md` files.
