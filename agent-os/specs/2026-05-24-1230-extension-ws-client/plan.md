# PlaybackSync Extension — Background WebSocket Client (v2 protocol)

## Context

The plugin foundation just shipped: adapters observe the video and emit intents, the content runtime selects the right adapter, and the background script logs intents but talks to nothing. This slice gives the background a real WebSocket client that turns intents into wire `EVENT`s, applies server frames as `AuthoritativeCommand`s back to adapters, and keeps the connection alive correctly.

The wire contract is locked at [../../../docs/ws-protocol.md](../../../docs/ws-protocol.md) (v2). The daemon is Ratchet + ReactPHP and lives under `lib/WebSocket/` — message validation in `MessageValidator.php`, encoding in `MessageEncoder.php`, dispatch in `MessageRouter.php`. Nothing in `OLD_CODE/extension/` implemented a client past stub-level; this slice is greenfield on the client side.

User-approved scope:

- **Full v2 protocol.** All client + server frames, plus `clientId` + `lastEventId` reconnect with tombstone replay.
- **Creds = dev shim only.** `chrome.storage.local` entry set manually via DevTools. Share-URL sniffing is a follow-up.
- **One room at a time, browser-wide.** Multi-room is deferred.

## Documentation policy (project-wide, starts here)

All extension code and features must be documented. Per-file module JSDoc, per-export JSDoc with real descriptions, per-feature markdown under `extension/docs/`. Task 12 kicks this off (initial doc tree + retroactive JSDoc top-up across the foundation slice).

## Tasks

1. Save spec documentation (this folder).
2. Extend adapter contract — `VideoState` + `getState()` (`extension/src/adapters/types.ts`, `_template/index.ts`).
3. Status emission from runtime (1 s interval, `bridge.sendStatus`, new `status` `ContentToBackground` kind).
4. Protocol module (`extension/src/background/protocol.ts`) — types + encode + decode for all v2 frames.
5. Storage module (`storage.ts`) — `loadCreds`, `saveClientId`, `clearCreds`.
6. Session module (`session.ts`) — state container, `apply*` server-frame folders, suppression windows.
7. Clock sync (lives in `session.ts`) — ping/pong math, offset/RTT median.
8. WS module (`ws.ts`) — connection lifecycle, reconnect with exponential backoff, heartbeat + clock-ping tickers.
9. Per-tab cache (`tabs.ts`) — `Map<tabId, { adapterId, latestState }>`, `chrome.tabs.onRemoved` cleanup.
10. Background entrypoint rewrite — wire `loadCreds → connect`, route `ContentToBackground` messages, deliver commands with suppression-arming.
11. Smoke-test repro doc in `extension/README.md`.
12. Documentation pass — `extension/docs/{README,architecture,protocol-client,adapter-contract,storage}.md` + JSDoc top-up across all extension TS files.

## Verification

`npm run compile` + `npm run lint`. Manual smoke test against a real `occ playbacksync:ws-serve` instance — see `extension/README.md` after Task 11.

## Critical files

**Created:** `extension/src/background/{protocol,storage,session,ws,tabs}.ts`; `extension/docs/{README,architecture,protocol-client,adapter-contract,storage}.md`.

**Modified:** `extension/src/adapters/{types,runtime}.ts`, `extension/src/adapters/_template/index.ts`, `extension/src/messages.ts`, `extension/entrypoints/{background,content}.ts`, `extension/README.md`.

## Out of scope

Credential pickup from share URL; first real site adapter (miruro); popup UI; multi-room arbitration; `currentlyShowing` + `catalogFragment` reporting (schema lands, real values later); owner-driven `CURSOR_CHANGE_REQUEST` triggers (encoder stub only).
