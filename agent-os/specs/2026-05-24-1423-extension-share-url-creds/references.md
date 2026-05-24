# References for Credential Pickup from the Share URL

## Server-side contract

### `ShareController::buildRedirectUrl`

- **Location:** [`lib/Controller/ShareController.php`](../../../lib/Controller/ShareController.php) lines 121-141
- **Relevance:** Defines exactly which query parameters the extension is reading — `sync_url` (a `ws://` or `wss://` URL pointing at `/apps/playbacksync/ws/{uuid}`) and `sync_password` (the plaintext one-time password the visitor just typed).
- **Key patterns:** Existing params on `bootstrapUrl` are preserved; fragment survives reassembly. The extension must NOT rely on positional ordering — use `URLSearchParams.get()`.

## Extension architecture references

### Existing content-script entrypoint

- **Location:** [`extension/entrypoints/content.ts`](../../../extension/entrypoints/content.ts)
- **Relevance:** Same `defineContentScript` + `chrome.runtime.sendMessage` pattern we'll mirror in the new entrypoint.
- **Key patterns:** Errors on `chrome.runtime.sendMessage` are swallowed via `.catch(() => {})` because the MV3 background may be asleep; the new entrypoint should match.

### Background `onMessage` listener and dispatcher

- **Location:** [`extension/entrypoints/background.ts`](../../../extension/entrypoints/background.ts) lines 27-33 (listener), 58-94 (routeMessage)
- **Relevance:** Where the new `'credentials'` case lands.
- **Key patterns:** The listener currently returns `undefined` from a sync callback; we need to keep that contract even when the new case is async (wrap the async work in `void (async () => {…})()`). Returning `true` from a listener tells Chrome we'll `sendResponse` later — not the case here.

### Storage module

- **Location:** [`extension/src/background/storage.ts`](../../../extension/src/background/storage.ts)
- **Relevance:** Wraps `chrome.storage.local`; the only file in the extension that touches that API directly. `saveCreds` joins `loadCreds` / `saveClientId` / `clearCreds`.
- **Key patterns:** `saveClientId` is a read-then-write to avoid clobbering creds. `saveCreds` is the inverse: a deliberate clobber, dropping any prior `clientId`.

### WS client

- **Location:** [`extension/src/background/ws.ts`](../../../extension/src/background/ws.ts) lines 89-112
- **Relevance:** `connect()` accepts the creds shape we'll be writing; `disconnect()` exists but is unused in this slice (first-write-wins means no reconnect).
- **Key patterns:** `connect()` is a no-op when a connection already exists — the doc has this safety, but in this slice the background only calls `connect` when `loadCreds()` was previously null, so the runtime singleton is guaranteed unset.

### Message contract

- **Location:** [`extension/src/messages.ts`](../../../extension/src/messages.ts)
- **Relevance:** The new `'credentials'` arm extends the discriminated union.
- **Key patterns:** Existing arms include `adapterId` for log correlation. The new arm intentionally omits it — credential pickup is browser-runtime-global, not adapter-scoped.

## Documentation references

### Storage feature doc

- **Location:** [`extension/docs/storage.md`](../../../extension/docs/storage.md) §"Future tightening" (lines 85-95)
- **Relevance:** Pre-describes the exact flow we're implementing — content script sees `?sync_url=…&sync_password=…`, sends a typed message, background writes and connects.
- **Key patterns:** The doc explicitly promises "The schema doesn't change. The DevTools seeding path stays available as a manual fallback / debug tool." Both promises hold in this slice.

## Old-code references

`OLD_CODE/extension/` did not implement credential pickup; nothing to port. The new implementation is greenfield.

## Punch list

- **Location:** [`EXTENSION_TODO.md`](../../../EXTENSION_TODO.md) line 14
- **Relevance:** This slice clears that bullet. Task 7 moves it from "Next up" to "Already shipped" with a link back to this spec.
