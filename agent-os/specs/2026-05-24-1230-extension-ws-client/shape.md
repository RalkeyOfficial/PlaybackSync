# Extension WS Client — Shaping Notes

## Scope

The background-side WebSocket client for the extension, speaking the full v2 protocol against the Ratchet daemon. Connection lifecycle, JOIN handshake with reconnect, all client frames (`EVENT`, `HEARTBEAT`, `CLOCK_PING`, `BUFFER_*`, `CURSOR_CHANGE_REQUEST`, `PLAYLIST_UPDATE`), all server frames (`ROOM_STATE`, `STATE`, `CURSOR_CHANGE`, `PLAYLIST_UPDATE`, `SYNC_ADJUST`, `CLOCK_PONG`, `ERROR`), drift handling via `SYNC_ADJUST`, and feedback-loop suppression.

## Decisions

- **Full v2 protocol in one slice** (user-confirmed). Subdividing further would leave the system non-functional at every checkpoint.
- **Creds = dev shim.** `chrome.storage.local` keyed at `pbsync`, set manually via DevTools. Share-URL sniffing has its own follow-up spec.
- **One room, browser-wide.** Roadmap §"Phase 2" says "a single authoritative WebSocket connection from the background worker." Multi-room arbitration is later.
- **Suppression lives in the background.** Workshop §3 forbids adapters from deciding suppression; the background tracks "command sent" per tab and drops matching intents within a 600 ms window.
- **Heartbeat data comes from the adapter via the runtime.** New `getState()` on the `Adapter` contract; the runtime polls it on a 1 s tick and pushes a `status` message. The background caches the latest state per tab and pulls from the cache when the heartbeat timer fires (no round-trip on every heartbeat).
- **Reconnect = exponential backoff capped at 30 s.** Stays inside the daemon's 30 s tombstone window, which lets `JOIN` carry the same `clientId` + `lastEventId` and have the server replay missed events.
- **Clock sync.** 4 pings spaced ~250 ms on connect, then one every 30 s. Maintain a sliding median offset.

## Context

- **Visuals:** None.
- **References:** `docs/ws-protocol.md` (wire format authority); daemon code under `lib/WebSocket/` (`MessageEncoder`, `MessageValidator`, `MessageRouter`, `Handler/EventHandler`) for mirroring field shapes and rationalising suppression; the foundation spec at `agent-os/specs/2026-05-24-0959-extension-plugin-foundation/`.
- **Product alignment:** This slice directly delivers two of the four roadmap §Phase 2 work items — JOIN handshake with `clientId` + `lastEventId` reconnect, and content-script video adapter receiving server `STATE` / `CURSOR_CHANGE` / `SYNC_ADJUST` with feedback-loop suppression.

## Documentation policy

Locked in this spec as a project-wide standard: every TS file gets a module docblock, every exported symbol gets a JSDoc with real descriptions and filled-in `@param`/`@returns`, every feature gets a markdown doc under `extension/docs/`. Applies retroactively — the foundation files get a JSDoc top-up in Task 12. ESLint enforcement (`jsdoc/*` rules) is a future tightening, not in this slice.

## Standards Applied

None from `agent-os/standards/index.yml` (PHP / Vue / Vite — the extension is a separate WXT/TS project). Project `CLAUDE.md` rules continue to apply: no author/license/SPDX headers; comments explain *why* not *what*; meaningful JSDoc is welcome (only the author-header kind is "boilerplate").
