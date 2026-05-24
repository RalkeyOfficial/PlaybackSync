# Standards for Extension WS Client

## Applicable standards

**None** from `agent-os/standards/index.yml`. The existing entries (`backend/php-conventions`, `frontend/vue-conventions`, `tooling/build`) cover the Nextcloud-app side. The extension is a separate WXT/TypeScript project under `extension/` with its own `package.json`, `tsconfig.json`, and `eslint.config.mjs`.

## Project-local guidance that applies

From the project root `CLAUDE.md`:

- No author / license / SPDX headers in any file.
- Comments explain *why*, not *what*; default to no comments.
- "No docblock boilerplate" applies **only** to the author/license kind of header. **Real JSDoc with meaningful descriptions is welcome and expected** — fill in `@param` / `@returns` properly; never leave skeleton blocks.
- Don't disable `jsdoc/*` ESLint rules to silence missing-description warnings.

## New project-wide policy from this spec

**All extension code and features must be documented.** See `shape.md` "Documentation policy" and `plan.md` Task 12 for the concrete rules:

- Every TS file under `extension/src/` and every `entrypoints/*.ts` starts with a module-level JSDoc block.
- Every exported symbol carries a JSDoc with a real description.
- Every architecturally significant feature gets a markdown doc under `extension/docs/`, mirroring the shape of the project-level `docs/` directory.
- Applies retroactively; the foundation slice files get a JSDoc top-up in this spec's Task 12.

ESLint enforcement (`jsdoc/require-description` etc.) is a future tightening, not in this slice.

## Note for future extension specs

When the extension grows enough to warrant its own standards entries (WXT entrypoint conventions, content/background message envelope rules, adapter-implementation checklist, MV3 vs MV2 packaging), add an `extension/` namespace to `agent-os/standards/index.yml`. Until then, the working agreements live in `CLAUDE.md`, in the per-spec `shape.md` files, and (starting with Task 12) in `extension/docs/`.
