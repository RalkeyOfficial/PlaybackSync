# Credential Pickup from the Share URL — Shaping Notes

## Scope

The dashboard's "share room" link lands the visitor on `/apps/playbacksync/r/{uuid}`, prompts for the one-time password via Basic Auth, then 302s to `room.bootstrapUrl` with `?sync_url=…&sync_password=…` appended. The PHP side is already wired; the extension side ignores those params today. This slice teaches the extension to pick them up: content script reads them, background writes them to `chrome.storage.local.pbsync`, WS client connects — closing the "join a room via the dashboard link" loop end-to-end.

## Decisions

- **Sniffer location: dedicated entrypoint.** New `entrypoints/credentials.content.ts` rather than inlining inside `entrypoints/content.ts`. Reasons: the adapter runtime is long-lived per page while credential pickup is one-shot at navigation; `runAt: document_start` for pickup vs `document_idle` for the runtime; easier to disable the feature without touching the runtime.
- **Leave the URL untouched.** No `history.replaceState` stripping in this slice. The password is already in the URL bar at the moment the browser performs the 302 — defending against that requires changes to the PHP-side redirect (fragment-only handoff, server-set cookie, etc.) that are out of scope here. The extension treats the URL as it finds it.
- **First-write-wins.** If `pbsync` already exists in storage, the new pickup is ignored and a single hint line is logged. Switching rooms is explicitly out of scope until the popup ships a "leave room" action that calls `clearCreds`.
- **`clientId` is dropped on every save.** Even though first-write-wins means we never overwrite live creds in this slice, `saveCreds` strips `clientId` so a future replace-and-reconnect slice can reuse it safely.
- **No new tests.** Existing extension has zero tests; introducing vitest is a separate concern. Verification is `npm run compile` + `npm run lint` + a manual repro in the README.

## Context

- **Visuals:** None.
- **References:**
  - [`lib/Controller/ShareController.php`](../../../lib/Controller/ShareController.php) `buildRedirectUrl` — defines the `sync_url` / `sync_password` query-param contract.
  - [`extension/entrypoints/content.ts`](../../../extension/entrypoints/content.ts) — `defineContentScript` + `chrome.runtime.sendMessage` pattern.
  - [`extension/entrypoints/background.ts`](../../../extension/entrypoints/background.ts) — `onMessage` listener + `routeMessage` switch.
  - [`extension/src/background/storage.ts`](../../../extension/src/background/storage.ts) — existing `loadCreds` / `saveClientId` / `clearCreds`.
  - [`extension/src/background/ws.ts`](../../../extension/src/background/ws.ts) — `connect` / `disconnect` API.
  - [`extension/src/messages.ts`](../../../extension/src/messages.ts) — `ContentToBackground` union.
- **Product alignment:** Closes the "join a room via the dashboard link" gap called out in [`EXTENSION_TODO.md`](../../../EXTENSION_TODO.md) §"Next up" and prefigured in [`extension/docs/storage.md`](../../../extension/docs/storage.md) §"Future tightening".

## Standards applied

The standards listed in `agent-os/standards/index.yml` (`backend/php-conventions`, `frontend/vue-conventions`, `tooling/build`) don't apply directly — this slice is extension-only TypeScript. Project-level rules that DO apply are documented in `standards.md`.
