# Standards for Credential Pickup from the Share URL

The standards registered in [`agent-os/standards/index.yml`](../../standards/index.yml) cover the PHP backend, Vue/Pinia frontend, and Vite-based tooling. None of those apply directly to this slice — the work is entirely inside the WXT-based browser extension, which has its own stack (TypeScript, MV3 service worker, content scripts).

What does apply are the project-level rules from [`CLAUDE.md`](../../../CLAUDE.md) and the documentation policy seeded by the WS-client spec ([`2026-05-24-1230-extension-ws-client/plan.md`](../../2026-05-24-1230-extension-ws-client/plan.md) §"Documentation policy"):

## No author / license / SPDX headers

Quote from `CLAUDE.md`:

> No author, license, or SPDX headers in any file. Ever. This includes `@author`, `@copyright`, `SPDX-FileCopyrightText`, `SPDX-License-Identifier`, and the like.

**Applies to:** every new and modified `.ts` file in this slice.

## Real JSDoc with meaningful descriptions

Quote from `CLAUDE.md`:

> "No docblock boilerplate" applies **only** to the author/license/SPDX kind of header. Real JSDoc / PHPDoc with meaningful descriptions is welcome — write proper `@param` descriptions, don't leave empty `/** */` skeletons.

**Applies to:**

- The new `'credentials'` arm of `ContentToBackground` — needs a paragraph explaining what triggers it and why it lacks `adapterId`.
- The new `saveCreds` export — needs a real description, including the *why* of dropping `clientId`.
- The new `entrypoints/credentials.content.ts` — needs a module-level JSDoc covering trigger, lifecycle, and the "URL left untouched" decision.

## Per-feature documentation in `extension/docs/`

The WS-client spec established that "all extension code and features must be documented … per-feature markdown under `extension/docs/`". This slice doesn't warrant a new doc page — it's a small extension to the storage flow — but it does require:

- [`extension/docs/storage.md`](../../../extension/docs/storage.md) §"Future tightening" updated to reflect implementation, plus a new §"Share-URL pickup" describing the end-to-end flow.
- [`extension/docs/architecture.md`](../../../extension/docs/architecture.md) entrypoint table updated to include `credentials.content.ts`.
- [`extension/README.md`](../../../extension/README.md) smoke-test section updated with the easier share-link path.

## ESLint cleanliness

The codebase enables `jsdoc/*` rules and existing extension code passes them. New files must not disable rules to silence missing-description warnings — fill the descriptions in.
