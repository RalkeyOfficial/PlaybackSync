# Standards for Playback Notifications

This slice spans **both** stacks: the PHP WebSocket daemon and the WXT browser extension. The
standards registered in [`agent-os/standards/index.yml`](../../standards/index.yml) that apply
are `backend/php-conventions` (server changes) and `tooling/build` (extension build discipline).
`frontend/vue-conventions` does **not** apply — none of the work touches the Nextcloud Vue
frontend. Project-level rules from [`CLAUDE.md`](../../../CLAUDE.md) and
[`extension/WXT-AND-BROWSERS.md`](../../../extension/WXT-AND-BROWSERS.md) apply throughout.

---

## backend/php-conventions

Applies to every modified PHP file (`MessageEncoder.php`, `RoomRuntime.php`, the four handlers,
`MessageRouter.php`, `RoomBroadcastController.php`).

> All PHP files start with:
> ```php
> <?php
> declare(strict_types=1);
> ```
> ## Namespaces and imports
> - Only import from `OCP\` — never `OC\` (internal, unstable Nextcloud API)
> - App namespace: `OCA\PlaybackSync\`

The new `notice()` encoder and `broadcastNotice()` helper follow the existing typed-signature
style of their neighbours (`encode()`, `roomState()`, `activeConnectionsExcept()`); no new OCP
imports are needed (the WS layer is plain PHP, not controllers).

---

## tooling/build

Applies to the extension half. The relevant discipline is the **cross-browser build check**, not
just the typecheck:

> | `npm run build` | Production build |
> | `npm run lint` / `lint:fix` | ESLint |
>
> Node `^24.0.0`, npm `^11.3.0` (enforced via `engines`).

Extended by [`extension/WXT-AND-BROWSERS.md`](../../../extension/WXT-AND-BROWSERS.md): the
extension ships Chrome MV3 + Firefox MV2 from one codebase, so `npm run compile` (typecheck only)
is **not** sufficient — build **both** targets (`npm run build && npm run build:firefox`) before
committing, because manifest-version / runtime-API drift surfaces at build/runtime, not typecheck.

---

## No author / license / SPDX headers

Quote from [`CLAUDE.md`](../../../CLAUDE.md):

> No author, license, or SPDX headers in any file. Ever. This includes `@author`, `@copyright`,
> `SPDX-FileCopyrightText`, `SPDX-License-Identifier`, and the like.

**Applies to:** every new and modified `.php` / `.ts` / `.md` file in this slice, including the
new `extension/src/ui/notifications.ts` and `extension/docs/notifications.md`.

---

## Real PHPDoc / JSDoc with meaningful descriptions

Quote from [`CLAUDE.md`](../../../CLAUDE.md):

> Real JSDoc / PHPDoc with meaningful descriptions is welcome — write proper `@param`
> descriptions, don't leave empty `/** */` skeletons.

**Applies to:** `MessageEncoder::notice()` and `RoomRuntime::broadcastNotice()` (document the
peer-fan-out and actor-exclusion semantics); the new `Notice` / `NoticeFrame` / `NoticeEvent`
types in `messages.ts` and `protocol.ts`; and the `notifications.ts` module (module-level JSDoc
explaining the lazy shadow-root mount, the two UI surfaces, and the copy mapping).

---

## Cross-browser rules (extension)

From [`extension/WXT-AND-BROWSERS.md`](../../../extension/WXT-AND-BROWSERS.md):

- Use the `browser.*` global — never `chrome.*`. The new `dispatchNotice(tabId, notice)` uses
  `browser.tabs.sendMessage(...).catch(...)`, mirroring `dispatchCommand`.
- Do **not** set a global `manifestVersion`. `createShadowRootUi` and `ContentScriptContext` are
  WXT-provided and manifest-version-agnostic.
- Fire-and-forget `onMessage` listeners return `undefined` — the `{ kind:'notice' }` branch in
  `content.ts` must not return a promise/`true`.
- Guard content-script sends/handlers with the `browser.runtime?.id` context-invalidation probe.
- Build both targets before committing.

---

## No `l10n/` for extension strings

The `CLAUDE.md` "localize every user-facing string" rule governs the **Nextcloud-app** frontend
(`t('playbacksync', …)` + `l10n/en.js` / `l10n/nl.js`). The extension has no `t()` helper and no
`l10n/` directory; English-only is the existing posture for all extension copy (see the toolbar
popup). The notification strings match it. A future spec can wire `browser.i18n` if needed.

---

## Per-feature documentation in `extension/docs/`

Established by prior extension specs: extension features are documented as per-feature markdown
under `extension/docs/`. This slice adds `extension/docs/notifications.md` (the `NOTICE` wire
frame, the background→content `notice` message, the two UI surfaces and their lifecycles) and
updates `extension/docs/architecture.md` (an injected on-page UI layer now exists — previously
the content script rendered nothing).

---

## Personal-project naming

PlaybackSync is a personal project. No user-facing copy (toasts, welcome badge, docs) surfaces
the user's email domain (`conduction.nl`) or any org name — only "PlaybackSync".
