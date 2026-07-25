# Standards for the Cross-Frame Media Adapter

The following standards apply to this work.

---

## tooling/build

Note: the standards file at [`agent-os/standards/tooling/build.md`](../../standards/tooling/build.md) describes the **Nextcloud-side** Vite + ESLint setup (root `package.json`). The browser extension at [`extension/`](../../../extension/) uses **WXT** with its own `package.json`. The relevant rules for this spec:

- Keep `npm run compile` (`tsc --noEmit`) green after every task — the `types.ts` role split surfaces most regressions mechanically.
- Keep `npm run lint` green; do not disable `jsdoc/*` rules to silence missing-description warnings (project rule from [`CLAUDE.md`](../../../CLAUDE.md)). Fill in real descriptions.
- **Build both targets** — `npm run build && npm run build:firefox`. Manifest-version and cross-frame API differences (`all_frames`, `frameId` on `tabs.sendMessage`/`sender.frameId`) surface at build/runtime, not always at typecheck. Both are supported on Chrome MV3 and Firefox MV2, but the built manifests must be inspected to confirm `all_frames`/`host_permissions` landed.
- Use the `browser.*` global, never `chrome.*` (see [`extension/WXT-AND-BROWSERS.md`](../../../extension/WXT-AND-BROWSERS.md)). The new `media.content.ts` and the frameId routing in `background.ts` all go through `browser.*`.
- Real JSDoc with meaningful descriptions on new/changed exports (the two role interfaces, the two contexts, `MediaBaseAdapter`, the media runtime bridge). No author/license/SPDX headers.

---

## Not applicable

- **`frontend/vue-conventions`** — no Vue touched; the popup is untouched.
- **`backend/php-conventions`** — no PHP change. The daemon is frame-agnostic: both frames of a tab are one WS client, so the protocol is unchanged.
