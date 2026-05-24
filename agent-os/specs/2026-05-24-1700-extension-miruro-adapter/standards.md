# Standards for First Real Site Adapter (miruro)

The standards registered in [`agent-os/standards/index.yml`](../../standards/index.yml) cover the PHP backend, Vue/Pinia frontend, and Vite-based tooling. None of those apply directly to this slice — the work is entirely inside the WXT-based browser extension, which has its own stack (TypeScript, MV3 service worker, content scripts).

What does apply are the project-level rules from [`CLAUDE.md`](../../../CLAUDE.md) and the documentation policy seeded by the WS-client spec ([`2026-05-24-1230-extension-ws-client/plan.md`](../../2026-05-24-1230-extension-ws-client/plan.md) §"Documentation policy").

## No author / license / SPDX headers

Quote from `CLAUDE.md`:

> No author, license, or SPDX headers in any file. Ever. This includes `@author`, `@copyright`, `SPDX-FileCopyrightText`, `SPDX-License-Identifier`, and the like.

**Applies to:** every new and modified `.ts` / `.md` file in this slice.

## Real JSDoc with meaningful descriptions

Quote from `CLAUDE.md`:

> "No docblock boilerplate" applies **only** to the author/license/SPDX kind of header. Real JSDoc / PHPDoc with meaningful descriptions is welcome — write proper `@param` descriptions, don't leave empty `/** */` skeletons.

**Applies to:**

- The new `MiruroAdapter` class — module-level JSDoc describing supported hosts, the URL parsing rule, and the manual-load-button quirk.
- Every non-trivial private helper (waiter for the video element, manual-load trigger, identity parser) — JSDoc that explains *why* it exists, not just what it does.

## Per-feature documentation in `extension/docs/`

The WS-client spec established that "all extension code and features must be documented … per-feature markdown under `extension/docs/`". This slice requires:

- A new [`extension/docs/adapter-miruro.md`](../../../extension/docs/adapter-miruro.md): supported hosts, URL shape, video selector, the manual-load-button quirk, two-video disambiguation. This is the per-site doc anticipated by [`adapter-contract.md`](../../../extension/docs/adapter-contract.md) step 11 ("Document it. Add a short note under `extension/docs/adapter-<site>.md` … Per the documentation policy, this is non-optional.").
- An update to [`extension/docs/architecture.md`](../../../extension/docs/architecture.md) §"Out-of-scope" — the bullet "Real site adapters. Only `_template` exists …" needs to flip since miruro now ships.
- An update to [`extension/README.md`](../../../extension/README.md) — add a miruro smoke-test recipe alongside the existing `template-test.html` one.

## ESLint cleanliness

The codebase enables `jsdoc/*` rules and existing extension code passes them. New files must not disable rules to silence missing-description warnings — fill the descriptions in. Per `CLAUDE.md`:

> Don't disable `jsdoc/*` ESLint rules to silence missing-description warnings; fill in the descriptions.

## Adapter-contract rules (project-internal)

From [`extension/docs/adapter-contract.md`](../../../extension/docs/adapter-contract.md), the contract has hard rules that apply specifically to this work:

- **`canHandlePage` is pure.** URL inspection only — no DOM, no `chrome.*`.
- **No silent fallback in `init`.** If the page looks supportable but the video element can't be found or identity can't be parsed, call `ctx.fail` rather than degrading.
- **Identity must not contain a hostname.** Workshop §7; `miruro.tv` and `miruro.to` must produce the same `normalizedUrl`.
- **`onCommand` applies verbatim.** `play` is `video.play()`, full stop. No interpretation, no transformation.
- **`destroy` removes every listener.** No partial state inherited by the next activation.
