# Extension — Credential Pickup from the Share URL

## Context

The PHP side of the share flow already lands users on `room.bootstrapUrl` with `?sync_url=…&sync_password=…` appended (see [`lib/Controller/ShareController.php`](../../../lib/Controller/ShareController.php) lines 121-141). The extension just shipped the v2 WS client (commit `426f49c`), but credentials still have to be seeded by hand via the background worker's DevTools — see [`extension/docs/storage.md`](../../../extension/docs/storage.md) §"Dev workflow". That makes end-to-end demos painful and breaks the "click the share link → you're in the room" UX implied by the dashboard.

This slice closes that loop: a content script sniffs the query params, hands them to the background, which writes them to `chrome.storage.local.pbsync` and starts the WS client — first-write-wins, no replace semantics in this slice.

## Decisions (from shaping)

- **Dedicated content entrypoint** (not piggybacked on the adapter-runtime content script).
- **Leave URL untouched** — no `history.replaceState` stripping in this slice.
- **First-write-wins** — if creds already exist in storage, ignore the new ones (room-switching is deferred to the future "leave room" flow).
- **No new tests** — match existing extension posture (compile + lint + manual smoke).

## Tasks

1. **Save spec documentation** (this folder).
2. **Extend the message contract.** Add `{ kind: 'credentials'; syncUrl: string; syncPassword: string }` to `ContentToBackground` in [`extension/src/messages.ts`](../../../extension/src/messages.ts) with a JSDoc paragraph noting the arm is one-shot and not adapter-scoped.
3. **Add `saveCreds` to storage.** New export in [`extension/src/background/storage.ts`](../../../extension/src/background/storage.ts) that writes `{ syncUrl, syncPassword }` under `pbsync`, deliberately not preserving any existing `clientId` (a stored clientId belongs to whatever room was previously joined).
4. **Create the dedicated content entrypoint.** New file `extension/entrypoints/credentials.content.ts`. Matches `<all_urls>` at `runAt: 'document_start'`. Reads `sync_url` + `sync_password` from `window.location.search`; if both present, posts a single `credentials` message via `chrome.runtime.sendMessage`; otherwise returns. Errors are swallowed (background may be waking).
5. **Handle `credentials` in the background.** Extend [`extension/entrypoints/background.ts`](../../../extension/entrypoints/background.ts) `routeMessage` with a `'credentials'` case:
   - `loadCreds()`; if non-null → log and return (first-write-wins).
   - Else `await saveCreds(...)`, then `connect(creds, session, wsCallbacks)` with the same callbacks `bootstrap()` uses (extract them into a shared local).
   - Make `routeMessage` async; keep the `onMessage` listener returning `undefined` (wrap the body in `void (async () => {…})()`) so Chrome doesn't think we're keeping the channel open for a response.
6. **Documentation pass.**
   - [`extension/docs/storage.md`](../../../extension/docs/storage.md): flip §"Future tightening" to "implemented"; add §"Share-URL pickup" describing the flow. Keep the DevTools fallback.
   - [`extension/docs/architecture.md`](../../../extension/docs/architecture.md): list `credentials.content.ts` in the entrypoint table / diagram.
   - [`extension/README.md`](../../../extension/README.md): add a second smoke-test path (share-link → password prompt → connected).
7. **Update the punch list.** Move the "Credential pickup from the share URL" bullet in [`EXTENSION_TODO.md`](../../../EXTENSION_TODO.md) from "Next up" to "Already shipped" with a link to this spec.

## Critical files

**Created:**

- `extension/entrypoints/credentials.content.ts`
- `agent-os/specs/2026-05-24-1423-extension-share-url-creds/{plan,shape,standards,references}.md`

**Modified:**

- `extension/src/messages.ts`
- `extension/src/background/storage.ts`
- `extension/entrypoints/background.ts`
- `extension/docs/storage.md`
- `extension/docs/architecture.md`
- `extension/README.md`
- `EXTENSION_TODO.md`

## Verification

1. `cd extension && npm run compile && npm run lint` — must be clean.
2. Manual end-to-end:
   - `npm run dev`, load unpacked.
   - In the worker console, `chrome.storage.local.remove('pbsync')` to ensure a clean start.
   - In the dashboard, create a room with a one-time password; copy the share link (`…/apps/playbacksync/r/{uuid}`).
   - Paste the share link in a fresh tab; enter the password at the Basic Auth prompt.
   - Browser redirects to `bootstrapUrl?sync_url=…&sync_password=…`.
   - Worker DevTools logs `share-URL creds accepted; connecting`; WS JOIN flow follows.
   - `chrome.storage.local.get('pbsync')` shows the new entry (no `clientId` yet; gets filled in after first `ROOM_STATE`).
3. **First-write-wins regression.** With creds already present, visit a *different* share link → expect `share-URL creds ignored; pbsync already populated` and no reconnect.
4. **No-params regression.** Visit any normal page (no creds query params) → content script does nothing (no message sent, no console noise).

## Out of scope

- Stripping creds from the URL after pickup (no `history.replaceState`).
- Replace-and-reconnect when creds already exist (deferred to the popup "leave room" flow).
- Automatic `clearCreds` on terminal `AUTH_FAILED`.
- Vitest setup / unit tests.
- Popup UI for manual creds entry.
