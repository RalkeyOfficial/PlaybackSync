# References for Toolbar Popup

## Messaging foundation

### Content ↔ background envelope

- **Location:** [`extension/src/messages.ts`](../../../extension/src/messages.ts)
- **Relevance:** Defines `ContentToBackground` / `BackgroundToContent` as discriminated unions tagged by `kind`. The new popup channel mirrors this style: `PopupToBackground` and `BackgroundToPopup` as separate unions, each member tagged by `kind`. Same pattern, different transport (Port instead of one-shot `sendMessage`).
- **Key pattern:** Module-level JSDoc explaining the channel's intent; per-member field-level documentation. The popup additions follow the same shape.

### Background message router

- **Location:** [`extension/entrypoints/background.ts`](../../../extension/entrypoints/background.ts) (`routeMessage`)
- **Relevance:** Shows the existing `chrome.runtime.onMessage` pattern — a synchronous listener that wraps async work in an IIFE so the channel doesn't stay open. The new `chrome.runtime.onConnect` listener sits alongside it and handles a different primitive (Ports stay open by design; the IIFE pattern doesn't apply).

## State sources the popup reads

### Session state

- **Location:** [`extension/src/background/session.ts`](../../../extension/src/background/session.ts)
- **Relevance:** `SessionState` already carries everything the popup displays: `clientId` (set by `applyRoomState`), `cursor` (set by `applyRoomState` and `applyCursorChange`), `mode` (set by `applyRoomState`). No new state is needed. The popup just needs a snapshotting helper that reads these fields.
- **Key insight:** The state is mutable and shared across the worker. The snapshot helper must read it at broadcast-time (not capture references); the values can change between two reads.

### Storage helpers

- **Location:** [`extension/src/background/storage.ts`](../../../extension/src/background/storage.ts)
- **Relevance:** `loadCreds()` returns `PbSyncCreds | null` — the popup status derivation reads this to distinguish `no_credentials` from `connecting`/`disconnected`. `clearCreds()` already exists and is annotated "Used by the future 'leave room' action; here for symmetry"; the comment is now stale and gets updated to "Used by the toolbar popup's Leave Room button" in the same change.

### WS socket lifetime

- **Location:** [`extension/src/background/ws.ts`](../../../extension/src/background/ws.ts) (`runtime` module variable, lines 79, 95)
- **Relevance:** `runtime !== null && runtime.socket?.readyState === WebSocket.OPEN` is "joined-eligible" (still need `session.clientId` for full joined). `runtime !== null && socket-not-open` is `connecting`. `runtime === null && creds-exist` is `disconnected`. The `popupBroadcast` module reads `runtime` indirectly via a small exported predicate on `ws.ts` to keep the import boundary one-way.

## Documentation precedent

### WS-client spec

- **Location:** [`agent-os/specs/2026-05-24-1230-extension-ws-client/`](../2026-05-24-1230-extension-ws-client/)
- **Relevance:** Established the documentation policy this slice follows (`extension/docs/<feature>.md` per feature). Also the template for module-level JSDoc explaining "what this module owns" — the new `popupBroadcast.ts` follows the same shape as `ws.ts` / `session.ts` / `storage.ts`.

### Share-URL credential pickup spec

- **Location:** [`agent-os/specs/2026-05-24-1423-extension-share-url-creds/`](../2026-05-24-1423-extension-share-url-creds/)
- **Relevance:** The slice this one leans on — credentials enter the extension via that flow, and the popup's "no manual creds entry" decision was made because that flow already covers the credential-input path. Worth re-reading §"first-write-wins" to understand why the popup doesn't try to replace creds in place.

### Miruro adapter spec

- **Location:** [`agent-os/specs/2026-05-24-1700-extension-miruro-adapter/`](../2026-05-24-1700-extension-miruro-adapter/)
- **Relevance:** Same posture template: per-file JSDoc, per-feature doc, no tests, `npm run compile` + `npm run lint` + manual smoke as verification. The popup slice mirrors this shape one-for-one.

## Architecture diagram

### Three-layer diagram

- **Location:** [`extension/docs/architecture.md`](../../../extension/docs/architecture.md) §"The three layers"
- **Relevance:** The current diagram has background ↔ content + adapter. This slice adds a popup row on the background side (Port-based snapshot channel). Concretely, after the "Background service worker" box, add a sibling box for "Toolbar popup" with arrows labelled `BackgroundToPopup` (snapshot push) and `PopupToBackground` (leave_room).

## Punch list

- **Location:** [`EXTENSION_TODO.md`](../../../EXTENSION_TODO.md) line 16
- **Relevance:** "Toolbar popup. Room status, current cursor, leave-room button, manual creds entry as a fallback." This slice ships everything except the manual creds entry — explicitly dropped during shaping because credentials only enter via the share URL. Task 9 moves the bullet to "Already shipped" and updates the sub-list to reflect the dropped item.

## User-supplied design context (2026-05-24 shaping)

- **UI stack:** vanilla TS + plain CSS, no framework.
- **Liveness:** push via Port; no polling.
- **Credentials entry:** **no** manual form. Creds come from the share URL.
- **Cursor display:** provider + label + URL (clickable, opens in new tab).

These are not derivable from the codebase; they came from the AskUserQuestion round during shaping and define the slice's product shape.
