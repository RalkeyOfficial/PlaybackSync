# Standards for Toolbar Popup

The standards registered in [`agent-os/standards/index.yml`](../../standards/index.yml) cover the PHP backend, Vue/Pinia frontend, and Vite-based tooling. None of those apply directly to this slice — the work is entirely inside the WXT-based browser extension, which has its own stack (TypeScript, MV3 service worker, popup HTML).

What does apply are the project-level rules from [`CLAUDE.md`](../../../CLAUDE.md) and the documentation policy seeded by the WS-client spec ([`2026-05-24-1230-extension-ws-client/plan.md`](../../2026-05-24-1230-extension-ws-client/plan.md) §"Documentation policy").

## No author / license / SPDX headers

Quote from `CLAUDE.md`:

> No author, license, or SPDX headers in any file. Ever. This includes `@author`, `@copyright`, `SPDX-FileCopyrightText`, `SPDX-License-Identifier`, and the like.

**Applies to:** every new and modified `.ts` / `.html` / `.md` file in this slice.

## Real JSDoc with meaningful descriptions

Quote from `CLAUDE.md`:

> "No docblock boilerplate" applies **only** to the author/license/SPDX kind of header. Real JSDoc / PHPDoc with meaningful descriptions is welcome — write proper `@param` descriptions, don't leave empty `/** */` skeletons.

**Applies to:**

- The new exports in [`extension/src/messages.ts`](../../../extension/src/messages.ts) — `PopupStatus`, `PopupSnapshot`, `PopupToBackground`, `BackgroundToPopup` each get a real description that explains the popup ↔ background contract.
- The new module [`extension/src/background/popupBroadcast.ts`](../../../extension/src/background/popupBroadcast.ts) — module-level JSDoc explaining the Port lifecycle, broadcast trigger points, and the deliberate per-tick-suppression. Every export gets a `@param`-bearing JSDoc that explains *why* it exists, not just what it does.
- The popup entrypoint files — module-level JSDoc on `main.ts` explaining the Port lifecycle and re-render model.

## No `@nextcloud/vue` in the extension

Quote from `CLAUDE.md`:

> **Always use `@nextcloud/vue` components when one fits.**

That rule explicitly governs the **Nextcloud-app frontend** (under `src/`). The extension is a separate WXT bundle with no access to Nextcloud's runtime: no `OC.*` globals, no theme variables, no Nextcloud CSS. The popup must use plain HTML and CSS only. This is *not* a violation of the rule — the rule simply doesn't apply outside the Nextcloud app frontend.

## No `l10n/en.js` / `l10n/nl.js` for popup strings

Quote from `CLAUDE.md`:

> **Localize every user-facing string.** Wrap with `t('playbacksync', '…')` and add the key to **both** `l10n/en.js` and `l10n/nl.js`…

Same scope caveat — that rule governs Nextcloud-app strings. The extension has no `t()` helper and no `l10n/` directory. English-only is the existing posture for all extension copy; the popup matches it. A future spec can wire `chrome.i18n` if multi-language is required.

## Per-feature documentation in `extension/docs/`

The WS-client spec established that "all extension code and features must be documented … per-feature markdown under `extension/docs/`". This slice requires:

- A new [`extension/docs/popup.md`](../../../extension/docs/popup.md): the popup ↔ background messaging contract (`PopupSnapshot` schema, `PopupStatus` state machine, broadcast trigger points), the Port lifecycle, the credentials-are-share-URL-only design, the Leave Room semantics.
- An update to [`extension/docs/architecture.md`](../../../extension/docs/architecture.md) — the popup currently appears in §"Entrypoints" as "stub today; covered by a future spec" and in §"Out-of-scope" as "Popup UI for connection status, current room, manual disconnect." Both lines flip in this slice. The three-layer diagram gets a popup row.
- An update to [`extension/README.md`](../../../extension/README.md) — add a popup smoke-test step under §"Smoke test against a real sync daemon".

## ESLint cleanliness

The codebase enables `js.configs.recommended` and `tseslint.configs.recommended` ([`eslint.config.mjs`](../../../extension/eslint.config.mjs)). New files must pass without disabling rules. Per `CLAUDE.md`:

> Don't disable `jsdoc/*` ESLint rules to silence missing-description warnings; fill in the descriptions.

`jsdoc/*` is not currently enabled in the extension's ESLint config, but the spirit of the rule (don't silence rather than fix) applies to every rule.

## Personal-project naming

The popup must not surface the user's email domain (`conduction.nl`) anywhere — PlaybackSync is a personal project. The popup copy uses "PlaybackSync" only. The share link guidance text references "a PlaybackSync room owner" rather than any specific org.
