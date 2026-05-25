# Multi-Room / Multi-Tab Arbitration — Browser Extension

## Context

The PlaybackSync browser extension currently owns one WebSocket browser-wide. Only one tab can be "the source"; arbitration is "whoever called `recordStatus()` most recently wins" ([`extension/src/background/tabs.ts:73-84`](extension/src/background/tabs.ts#L73-L84)). Opening a second synced page in the same browser silently steals control from the first, and there is no way for two tabs to be in different rooms simultaneously.

**Decision: each tab is its own user.** Multiple WebSockets per browser, one per `chrome.tabs.id`. The server already treats each WS as a distinct client by `clientId`, so no protocol or daemon change is needed — the entire change is extension-side: pool the runtime by tab, scope creds + session state per-tab, retarget the popup at the current tab.

Closes the loop on the EXTENSION_TODO Deferred bullet "Multi-room / multi-tab arbitration" and unblocks the "watch together with two laptops on one account" workflow.

## Decisions (locked from shaping)

- **Connection model:** per-tab `WebSocket`, pooled in the background worker by `tabId`. No more singleton runtime.
- **Credentials scope:** per-tab, stored under `pbsync.tab.<tabId>` in `chrome.storage.local`. No more global `pbsync` first-write-wins.
- **Connect trigger:** automatic when the content runtime activates an adapter AND the per-tab creds slot is populated.
- **Lifecycle:** tear down on `chrome.tabs.onRemoved`, on `fail`, on explicit leave from popup. Browser restart wipes all per-tab slots (sentinel-driven cold-boot reset).
- **Share-URL pickup:** binds to the capturing tab. The existing `credentials.content.ts` already carries `sender.tab.id`; `handleCredentials` just writes to that tab's slot.
- **Popup scope:** current tab only. Popup derives its target via `chrome.tabs.query({active: true, currentWindow: true})` on open and `subscribe`s to that tab's snapshot stream.
- **ClientId / reconnect identity:** ephemeral per tab id; server-side tombstone replay covers continuity within a session.
- **Roadmap:** the Phase 2 line claiming "a single authoritative WebSocket connection" is now wrong and gets patched as part of Task 1.

## Spec folder

`agent-os/specs/2026-05-25-1530-extension-multi-tab-arbitration/`

## Critical files

- [`extension/src/background/ws.ts`](extension/src/background/ws.ts) — module singleton runtime → `Map<tabId, WsRuntime>` pool
- [`extension/src/background/session.ts`](extension/src/background/session.ts) — `SessionState` loses its per-tab maps (`recentCommandsByTab`, `convergedTabs`, `settleUntilByTab`, `pendingConvergence`) since each session is now scoped to one tab
- [`extension/src/background/storage.ts`](extension/src/background/storage.ts) — global `pbsync` key → per-tab `pbsync.tab.<tabId>` slots; add `loadAllCreds()`, cold-boot sentinel
- [`extension/src/background/tabs.ts`](extension/src/background/tabs.ts) — delete `pickActiveTab` and `allTabIds`; keep `recordStatus` / `recordIdentity` / `forgetTab` / `getTab` (used by `fireHeartbeat`)
- [`extension/src/background/popupBroadcast.ts`](extension/src/background/popupBroadcast.ts) — state mirror keyed by tab; `port → tabId` subscription map; per-tab snapshots
- [`extension/src/messages.ts`](extension/src/messages.ts) — extend `PopupToBackground` with `{ kind: 'subscribe'; tabId }`; add `tabId` to `leave_room`; add `tabId: number | null` to `PopupSnapshot`
- [`extension/entrypoints/background.ts`](extension/entrypoints/background.ts) — `routeMessage` becomes tab-scoped; new helper `ensureConnected(tabId)`; `recomputeActiveIcon` → per-tab `setColored(tabId, on)`
- [`extension/entrypoints/popup/main.ts`](extension/entrypoints/popup/main.ts) — query active tab on connect, send `subscribe`, stash tabId for `leave_room`
- [`agent-os/product/roadmap.md`](agent-os/product/roadmap.md) — Phase 2 paragraph (lines 19–24) rewritten
- [`extension/docs/architecture.md`](extension/docs/architecture.md) — drop the "deferred" multi-tab note (line 108) and document the per-tab model
- [`extension/docs/storage.md`](extension/docs/storage.md) — update creds-key documentation

## Tasks

### Task 1 — Save spec documentation

Create `agent-os/specs/2026-05-25-1530-extension-multi-tab-arbitration/` with:

- `plan.md` — this plan
- `shape.md` — scope, locked decisions, context (incl. the roadmap-contradiction note)
- `standards.md` — `tooling/build` (ESLint / Vite touches only); no `frontend/vue-conventions` since popup is vanilla TS; no `backend/php-conventions` since there is no PHP change
- `references.md` — pointers to the foundation specs studied: `2026-05-24-0959-extension-plugin-foundation`, `2026-05-24-1230-extension-ws-client`, `2026-05-24-1423-extension-share-url-creds`, `2026-05-24-2031-extension-toolbar-popup`
- `visuals/` — omitted (popup keeps current look)

Patch [`agent-os/product/roadmap.md:19-24`](agent-os/product/roadmap.md#L19-L24) so Phase 2 reads:

> Goal: a browser extension that runs on supported streaming sites, opens one authoritative WebSocket per syncing tab from its background worker (each tab is a distinct client; multi-room and multi-tab joins are supported in the same browser), observes and controls the page's `<video>` element from a content script, and applies server commands deterministically without feedback loops. The extension is the second first-class client (alongside the dashboard) and closes the loop on the "watch together on Crunchyroll/etc." workflow.

### Task 2 — Per-tab creds storage

Refactor [`storage.ts`](extension/src/background/storage.ts) first; it's a pure data-layer change with no consumers yet.

- Replace the singleton `pbsync` key. New keys: `pbsync.tab.<tabId>` → `{ syncUrl, syncPassword, clientId? }`.
- New signatures: `loadCreds(tabId)`, `saveCreds(tabId, creds)`, `saveClientId(tabId, clientId)`, `clearCreds(tabId)`, plus `loadAllCreds(): Promise<Map<number, PbSyncCreds>>` for the boot path (use `chrome.storage.local.get(null)` filtered by the `pbsync.tab.` prefix).
- Cold-boot sentinel: on service-worker init, check `chrome.storage.session['pbsync.booted']`. If absent, wipe all `pbsync.tab.*` keys (the "restart wipes" rule from shaping), then set the sentinel. `chrome.storage.session` is MV3-only — acceptable for the current Chromium build target; a Firefox port will need an alternate cold-boot flag.
- Update [`storage.md`](extension/docs/storage.md) to document the new key shape.

### Task 3 — Session shape: per-tab → scalar

In [`session.ts`](extension/src/background/session.ts), collapse the per-tab maps inside `SessionState` to scalars now that one session belongs to one tab:

- `recentCommandsByTab: Map<number, RecentCommand[]>` → `recentCommands: RecentCommand[]`
- `convergedTabs: Set<number>` → `converged: boolean`
- `settleUntilByTab: Map<number, number>` → `settleUntil: number | null`
- Delete `pendingConvergence` entirely — see Task 4 (no "no tab reported yet, hold the command" race once each runtime is created in response to a tab that's already reporting).

Drop the `tabId` parameter from `markConverged`, `inSettleWindow`, `hasConverged`, `resetConvergence`, `recordCommand`, `shouldSuppress`. Pure type-substitution refactor; touches every call site in `ws.ts` and `background.ts`.

### Task 4 — WS runtime pool

Refactor [`ws.ts`](extension/src/background/ws.ts):

- Replace module global `let runtime: WsRuntime | null = null` (line 96) with `const pool = new Map<number, WsRuntime>()`.
- Add `tabId: number` field to `WsRuntime`; the runtime captures it in its callback closures so command-dispatch and lifecycle events don't need it threaded.
- Rewrite signatures: `connect(tabId, creds, session, cb)`, `disconnect(tabId)`, `sendEvent(tabId, intent)`, `sendBuffer(tabId, kind, videoPos)`.
- `dispatchAll` becomes `dispatchToOwner(r, cmds)` — always sends to `r.tabId`; the `pickActiveTab` branch and the "defer until a tab reports" branch are deleted.
- `fireHeartbeat` (lines ~328–335) reads `getTab(r.tabId)` instead of `pickActiveTab()`.
- `scheduleInitialClockPings` staleness check (~lines 344–350) switches from `runtime !== r` to `pool.get(r.tabId) !== r`.
- `onTerminal` (e.g. KICKED) and `fail` paths call `pool.delete(r.tabId)` plus the per-tab cleanup; no shared singleton to nuke.

### Task 5 — Background routing

In [`entrypoints/background.ts`](extension/entrypoints/background.ts):

- New helper `ensureConnected(tabId)`: lazy WS bootstrap — if `pool.has(tabId)` skip; else read `loadCreds(tabId)`, create a fresh `SessionState`, call `connect(tabId, …)`.
- `routeMessage(tabId, msg)`:
  - `credentials` arm: drop the first-write-wins check; route is `saveCreds(tabId, …)` → `setPopupCreds(tabId, …)` → `ensureConnected(tabId)`. Moves *after* the `tabId === undefined` guard (creds must have a sender tab).
  - `status` arm: after `recordStatus`, call `ensureConnected(tabId)`.
  - `intent` arm: `hasConverged` / `inSettleWindow` / `shouldSuppress` / `sendEvent` look up the per-tab runtime via a `getRuntime(tabId)` helper. Drop intents if no runtime.
  - `fail` arm: `disconnect(tabId)` + `clearCreds(tabId)`.
- `chrome.tabs.onRemoved` handler (lines ~126–133): add `disconnect(tabId)` and `void clearCreds(tabId)`.
- `recomputeActiveIcon` (lines ~90–97): rewrite as per-tab `setColored(tabId, on)` invoked from each runtime's `onLifecycleChange` (joined → colored, anything else → grey). No more global icon state.
- Boot path: on service-worker init, after the cold-boot sentinel check (Task 2), iterate `loadAllCreds()`. For each `(tabId, creds)`: try `chrome.tabs.get(tabId)` — if the tab still exists, `ensureConnected(tabId)`; otherwise `clearCreds(tabId)` (orphan slot).

### Task 6 — Tab cache trim

In [`tabs.ts`](extension/src/background/tabs.ts):

- Delete `pickActiveTab` (lines 73–84) and `allTabIds` (lines 98–100). Grep the codebase first to confirm `allTabIds` is truly unreferenced.
- Keep `recordStatus`, `recordIdentity`, `forgetTab`, `getTab` — `fireHeartbeat` still wants the last-reported `VideoState` per tab.
- Delete `flushPendingConvergence` from `background.ts` (referenced only because the singleton runtime needed it; per-tab runtimes don't).

### Task 7 — Popup retargeting

In [`popupBroadcast.ts`](extension/src/background/popupBroadcast.ts):

- Replace the module-global mirror with `const mirrors = new Map<number, { socketState, creds, session }>()`.
- Add `port → tabId` map: `const ports = new Map<chrome.runtime.Port, number>()`.
- Notify functions take `tabId` first: `notifyConnecting(tabId, url)`, `notifyOpen(tabId)`, `notifyDisconnected(tabId, reason?, code?)`, `notifyRoomStateChanged(tabId)`, `notifyCursorChanged(tabId)`. Each updates only its mirror and re-broadcasts to ports whose bound tabId matches.
- `getDerivedStatus(tabId)` and `buildSnapshot(tabId)`.

In [`messages.ts`](extension/src/messages.ts):

- Extend `PopupToBackground` with `{ kind: 'subscribe'; tabId: number }`.
- `leave_room` carries `tabId`: `{ kind: 'leave_room'; tabId: number }`.
- `PopupSnapshot` gains `tabId: number | null` (null for `no_credentials`).

In [`entrypoints/popup/main.ts`](extension/entrypoints/popup/main.ts):

- On `connect()`, `await chrome.tabs.query({ active: true, currentWindow: true })`, grab `tabs[0].id`, post `{ kind: 'subscribe', tabId }`.
- Stash that tabId; `leave_room` button sends `{ kind: 'leave_room', tabId }`.
- No `chrome.tabs.onActivated` listener needed — switching tabs closes the popup.

### Task 8 — Docs

- [`extension/docs/architecture.md`](extension/docs/architecture.md): drop the "deferred" multi-tab paragraph at line 108; replace with a section describing the per-tab pool, lifecycle, and cold-boot wipe.
- [`extension/docs/popup.md`](extension/docs/popup.md): note the per-tab snapshot subscription model and that `leave_room` is scoped to the popup-opening tab.
- [`extension/docs/storage.md`](extension/docs/storage.md): document `pbsync.tab.<tabId>` keys and the cold-boot sentinel.
- Move the EXTENSION_TODO "Deferred → Multi-room / multi-tab arbitration" bullet up into "Already shipped" with a link to this spec.

## Verification

End-to-end against a live daemon (Docker dev environment). Recall: `docker exec -u www-data master-nextcloud-1 sh -c "cd /var/www/html/apps-extra/playbacksync && phpunit"` is the PHP test command (no PHP touched here, but the WS daemon must be up — confirm the proxy_wstunnel rule per the [WS proxy memory](file:///home/ralkey/.claude/projects/-home-ralkey-nextcloud-docker-dev-workspace-server-apps-extra-playbacksync/memory/project_ws_proxy_setup.md) is still in place).

1. Build extension (`pnpm -C extension build`) and load unpacked. Open Nextcloud dashboard, create **room A**, copy share link.
2. **Tab 1** on `https://miruro.tv/...`, paste share link → adapter activates → popup shows `joined` with room-A cursor. Dashboard "Connected clients" lists one client.
3. **Tab 2** on `https://miruro.tv/...`, paste the **same** share link → switch to tab 2, popup shows `joined` (distinct snapshot from tab 1). Dashboard now lists **two** clients with different `clientId`s.
4. Create **room B** in the dashboard; **Tab 3** with room B's share link → tab 3 joins room B. Room A's tabs unaffected.
5. **Cross-room isolation:** pause in tab 1 → tab 2 follows (same room), tab 3 unchanged. Pause in tab 3 → tabs 1–2 unchanged.
6. **Close tab 1** → dashboard for room A drops one client; tab 2 still `joined`.
7. **Reload tab 2** (`Ctrl+R`) → tabId is preserved; per-tab creds slot survives; runtime tears down + reconnects with the persisted `clientId` for tombstone replay. Confirm no duplicate-client flash in the dashboard.
8. **Browser restart** → all per-tab slots wiped via the cold-boot sentinel; no tab auto-rejoins. Re-paste a share link to verify the fresh path still works.
9. **Service-worker idle eviction** (Chrome devtools → Application → Service Workers → Stop) → on next message, worker wakes, `loadAllCreds()` enumerates surviving tabs, reconnects them. Orphan slots (tabIds with no live `chrome.tabs.get`) are wiped.
10. **Popup subscription:** open popup over tab 1, then over tab 3 → each shows its own room's cursor; no cross-talk.

Code-level checks: `pnpm -C extension typecheck`, `pnpm -C extension lint`. No new unit-test scaffolding required — the existing modules don't have a Vitest harness — but the typecheck after the `SessionState` reshape will catch most regressions mechanically.

## Open questions / risks

- **Tab-id reuse within a browser session:** Chromium *can* reuse a recently-closed tab's id. `chrome.tabs.onRemoved` fires synchronously before the id is reused, so the cleanup ordering is safe; worth a one-line comment at the cleanup handler.
- **Firefox MV2 port:** the cold-boot sentinel relies on `chrome.storage.session` (MV3-only). When the Firefox build branches off, replace with a global-scope `let booted = false` set on first `defineBackground` invocation.
- **Popup race on first open:** if popup connects before the tab has reported `status`, the mirror is absent → derived status is `no_credentials`. Matches today's behavior; acceptable.
