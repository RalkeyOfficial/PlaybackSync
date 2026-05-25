# Multi-Room / Multi-Tab Arbitration — Shaping Notes

## Scope

Refactor the browser extension so each tab is its own WebSocket client. Today the extension owns one socket browser-wide, and "active tab" = "whoever called `recordStatus()` most recently" ([`extension/src/background/tabs.ts:73-84`](../../../extension/src/background/tabs.ts#L73-L84)). Opening a second synced page silently steals control from the first; two rooms cannot coexist in the same browser.

After this spec: one WS per `chrome.tabs.id`, per-tab credentials, per-tab session state, popup scoped to the current tab.

## Decisions

- **Each tab is its own user.** Multiple WebSockets per browser; server already keys clients by `clientId`, so no protocol change is needed.
- **Credentials are per-tab**, keyed by `chrome.tabs.id`, stored under `pbsync.tab.<tabId>`. Ephemeral.
- **Auto-connect** when the content runtime activates an adapter and the per-tab creds slot is populated.
- **Share-URL pickup binds to the capturing tab.** No more global `pbsync` first-write-wins.
- **Popup shows the current tab only** (derived via `chrome.tabs.query({active: true, currentWindow: true})`).
- **Browser restart wipes** all per-tab slots via a `chrome.storage.session` sentinel.
- **Roadmap patch:** Phase 2 paragraph was claiming "a single authoritative WebSocket connection"; that line is wrong post-spec and gets rewritten in Task 1.

## Considered & deferred

- **Browser-wide persistent `clientId` shared across rooms (for admin "one identity" view).** Backend supports it cleanly cross-room (`clientId` scope is per-room in `RoomRuntime`), but the "two tabs in the same room" case the server rejects with `CLIENT_ID_IN_USE` ([`lib/WebSocket/Handler/JoinHandler.php:247-248`](../../../lib/WebSocket/Handler/JoinHandler.php#L247-L248)). Resolving that cleanly probably means pivoting from per-tab WS to **per-room WS** (one socket serves all tabs of one room) — which then revives the within-room arbitration problem we sidestepped by going per-tab. Parked for a future spec.

## Context

- **Visuals:** None. Popup keeps its current look; only the snapshot's source changes.
- **References:** [`extension/src/background/ws.ts`](../../../extension/src/background/ws.ts) (singleton runtime to be pooled), [`extension/src/background/session.ts`](../../../extension/src/background/session.ts) (per-tab maps collapse to scalars), [`extension/src/background/popupBroadcast.ts`](../../../extension/src/background/popupBroadcast.ts) (global mirror → tab-keyed mirrors). Foundation specs in [`agent-os/specs/2026-05-24-*`](../) — see `references.md`.
- **Product alignment:** Phase 2 of the roadmap. The "single authoritative WS" framing predates the per-tab-as-user decision; roadmap patched as part of Task 1.

## Standards applied

- **`tooling/build`** — ESLint / Vite touches are minimal (no new config). Refactor must keep `pnpm -C extension typecheck` and `pnpm -C extension lint` green.
- **`frontend/vue-conventions`** — Not applicable; the popup is vanilla TS, not Vue.
- **`backend/php-conventions`** — Not applicable; no PHP change.
