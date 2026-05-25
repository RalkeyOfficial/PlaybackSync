# Standards for Multi-Room / Multi-Tab Arbitration

The following standards apply to this work.

---

## tooling/build

Note: the standards file at [`agent-os/standards/tooling/build.md`](../../standards/tooling/build.md) describes the **Nextcloud-side** Vite + ESLint setup (root `package.json`). The browser extension at [`extension/`](../../../extension/) uses **WXT** with its own `package.json` and toolchain. The relevant rules for this spec:

- Keep `pnpm -C extension typecheck` green after every task (especially after the `SessionState` reshape in Task 3, which will surface most regressions mechanically).
- Keep `pnpm -C extension lint` green; do not disable rules to silence missing-description warnings (project rule from [`CLAUDE.md`](../../../CLAUDE.md)).
- Real JSDoc with meaningful descriptions is welcome on public functions whose signatures change (notably the new pool-keyed signatures in `ws.ts` and the per-tab-scoped helpers in `popupBroadcast.ts`). No author/license/SPDX headers.

---

## Not applicable

- **`frontend/vue-conventions`** — the popup is vanilla TS, not Vue. No NcSelect / NcTextField touches in this spec.
- **`backend/php-conventions`** — no PHP files are modified. The daemon already supports per-tab clients with no protocol change.
