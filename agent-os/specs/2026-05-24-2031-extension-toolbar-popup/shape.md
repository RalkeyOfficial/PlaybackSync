# Toolbar Popup — Shaping Notes

## Scope

The extension has been driveable end-to-end since the miruro adapter landed (commit `7bbb2f6`), but it has no in-extension UI. The popup is a placeholder with "Extension scaffold — not wired up yet." copy; everything users want to know about the room — connection state, what's playing, what URL the cursor points at — is invisible unless they open `chrome.storage.local` in DevTools. There is also no way to leave a room short of editing storage by hand.

This slice gives the popup three jobs:

- show the **connection status** as a single derived state (no-creds / connecting / joined / disconnected),
- show the **current cursor** (provider, label, pageUrl) when joined,
- offer a **Leave Room** button that wipes creds and disconnects the socket.

That's the entire "Toolbar popup." bullet from [`EXTENSION_TODO.md`](../../../EXTENSION_TODO.md). Once it ships, the extension is feature-complete for the room-joiner role; remaining work in the punch list is either deferred owner-side controls (cursor-change requests, playlist editing) or packaging polish (icons, store listings).

## Decisions

- **Vanilla TS + plain CSS, no framework.** The popup is small (3-4 conditional blocks, one button). The extension has no frontend framework today — adding Vue or Preact would cost more in build wiring than it saves in the UI. The Nextcloud-side `@nextcloud/vue` components are not usable here: different bundle, different runtime, no Nextcloud `OC.*` globals in the extension.
- **No manual credentials entry.** Asked explicitly in shaping. Creds enter the extension only via the share URL — the popup must not expose a form because doing so creates a second, divergent path that users can land in by accident. When disconnected, the popup tells the user to open a share link; it does nothing else.
- **Push-based liveness via `chrome.runtime.Port`.** A `Port` is the right primitive: long-lived, bidirectional, auto-cleans when the popup closes. Polling was rejected because the popup is open for short bursts and the server can push state changes (cursor moves, mode switches) faster than any reasonable poll interval. Snapshot-on-open was rejected because the cursor can move while the popup is open.
- **Broadcast only on lifecycle/cursor events, not per-tick.** `applyState` fires every ~1 s per tab and only mutates `lastEventId`, which the popup doesn't display. Broadcasting on every `STATE` would mean ~1 Hz snapshot pushes for the entire popup-open duration; that's wasteful and obscures the events that actually matter. Trigger points are: `connecting`, `open`, `ROOM_STATE` applied, `CURSOR_CHANGE` applied, `close`, `clearCreds()`. `PLAYLIST_UPDATE` is also skipped — there's no playlist UI in this slice.
- **Connection status is derived in the background, not the popup.** Rather than ship `{ creds, socketState, clientId }` to the popup and force it to derive the union, the background computes `status: 'no_credentials' | 'connecting' | 'joined' | 'disconnected'` and ships just that. The popup never reads raw socket or creds fields. This keeps the popup logic trivial and the truth in one place; future popups (e.g. mobile, web build) can reuse the same snapshot shape.
- **Cursor display: provider + label + URL.** `cursor.providerId · cursor.label ?? cursor.videoId` as the primary line, `cursor.pageUrl` as a small clickable link below. Concise; clicking the URL opens it in a new tab so the user can manually navigate the synced tab if they got lost. Italic placeholder ("Nothing playing yet") when `cursor === null`.
- **Leave = `clearCreds()` + `disconnect()`.** There is no protocol-level LEAVE frame ([`ws.ts:112-118`](../../../extension/src/background/ws.ts#L112-L118) just closes with code 1000). Leave is purely client-side: wipe storage, close the socket, broadcast the now-empty snapshot, popup re-renders. The popup doesn't close itself; the user is welcome to stay on the no-creds view and read the guidance.
- **Password never crosses the popup boundary.** The snapshot type explicitly omits `syncPassword` — only `syncUrl` is included (for "Connecting to …" display). Defense in depth: the popup runs in the same process as the rest of the extension, but a typed boundary makes accidental leaks (e.g. into a future copy-to-clipboard) structurally impossible.
- **No tests.** Matches existing extension posture — the WS-client, share-URL-creds, and miruro-adapter slices all deferred Vitest setup. Verification is `npm run compile`, `npm run lint`, and a manual smoke against a live daemon.

## Context

- **Visuals:** None. The popup is described in prose ("status pill, cursor line, leave button"); no mockups exist.
- **References:**
  - [`extension/src/messages.ts`](../../../extension/src/messages.ts) — existing content↔background envelope; the new popup channel mirrors the discriminated-union style.
  - [`extension/src/background/session.ts`](../../../extension/src/background/session.ts) — `SessionState` already holds everything the popup needs (`clientId`, `cursor`, `mode`); no new state required.
  - [`extension/src/background/storage.ts`](../../../extension/src/background/storage.ts) — `clearCreds()` already exists, commented "Used by the future 'leave room' action" — that future is now.
  - [`extension/src/background/ws.ts`](../../../extension/src/background/ws.ts) — `disconnect()` already does the right thing.
  - [`extension/entrypoints/credentials.content.ts`](../../../extension/entrypoints/credentials.content.ts) — the share-URL pickup flow this slice deliberately leans on (no manual creds form).
  - [`extension/docs/architecture.md`](../../../extension/docs/architecture.md) — the three-layer diagram needs a popup row.
- **Product alignment:** [`agent-os/product/roadmap.md`](../../product/roadmap.md) §"Phase 2: Browser extension" calls for "popup-level controls" as part of the extension MVP. This slice clears that line.

## Standards applied

The indexed standards (`backend/php-conventions`, `frontend/vue-conventions`, `tooling/build`) are PHP- and Vue-side — none touch the extension's TypeScript stack. Project-level rules from [`CLAUDE.md`](../../../CLAUDE.md) and the documentation policy from the WS-client spec do apply; see `standards.md`.
