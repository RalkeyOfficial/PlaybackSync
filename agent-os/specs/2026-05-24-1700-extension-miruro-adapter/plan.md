# Extension — First Real Site Adapter (miruro)

## Context

The browser extension already ships the plugin foundation (`Adapter` contract, runtime, `_template`) and the v2 WS client, but the only registered adapter is the inert `_template` that activates on a `?pbsync-template` query param. Nothing in the registry handles a real streaming page yet, which means an end-to-end sync session is impossible — every other piece (share-URL credential pickup, JOIN/HEARTBEAT/CURSOR_CHANGE handling, dashboard live controls) has been validated only against the template page.

This slice ports the legacy miruro logic — which in [`OLD_CODE/extension/src/content/index.ts`](../../../OLD_CODE/extension/src/content/index.ts) never got past a hostname check — onto the new contract: find the right `<video>`, build the `(providerId, videoId, normalizedUrl)` identity from the share-style URL, implement `getState`, wire intents, and apply authoritative commands. It also handles a miruro-specific quirk: on cold pages the `<video>` element exists but has no source until a manual-load button is activated, so the adapter has to synthesize that activation before sync can occur.

Once this lands, the extension can drive a real sync session for the first time, unblocking everything in the "Next up" column of [`EXTENSION_TODO.md`](../../../EXTENSION_TODO.md).

## Decisions (from shaping)

- **Host matching: enumerated TLDs.** `(www\.)?miruro\.(tv|to|bz|ru)` only — no wildcard. Rotations require a code release; a future slice may move the list to app config.
- **Path matching:** `/watch/<showId>/<slug>?ep=<ep>` — both `showId` and `ep` are required; missing either is a hard fail (`ctx.fail`).
- **Video disambiguation: scoped selector.** `#player-container .player video` — pages can have more than one `<video>` element, so a document-wide `querySelector('video')` is unsafe. The Vidstack player hydrates after page load, so the adapter waits via `MutationObserver` (bounded by a short timeout, then `fail`).
- **Manual-load button: eager-but-conditional.** At init, if `video.currentSrc` is empty, locate the button (`#player-container .vds-video-layout button`) and dispatch the synthesized space-key sequence (keydown + keyup with `key: ' ', code: 'Space', keyCode: 32`). After the source loads, default to paused — the background's first authoritative command will reapply the real room state. No-op if a source already exists.
- **ContentIdentity shape:**
  - `providerId: 'miruro'`
  - `videoId: '<showId>-ep<ep>'` (e.g. `166617-ep4`)
  - `normalizedUrl: '/watch/<showId>?ep=<ep>'` — strips hostname (workshop §7) and drops the slug (slugs are derived from showId and may diverge per host/locale).
- **SPA navigation is already handled** by the runtime's `popstate` + `history.pushState` monkey-patch ([`extension/src/adapters/runtime.ts:184-207`](../../../extension/src/adapters/runtime.ts#L184-L207)) — switching episodes via `?ep=` triggers `teardown` + re-evaluate. The adapter needs no extra plumbing for that.
- **Intent/command wiring mirrors `_template`.** `play` / `pause` / `seeking` event listeners forward `LocalIntent`; `onCommand` applies `play` / `pause` / `seek` / `sync_adjust` verbatim. `cursor_change` stays a no-op (deferred to the in-page-nav spec).
- **No tests.** Matches the existing extension posture — `npm run compile` + `npm run lint` + manual smoke.

## Tasks

1. **Save spec documentation** (this folder).

2. **Create the miruro adapter.** New file [`extension/src/adapters/miruro/index.ts`](../../../extension/src/adapters/miruro/index.ts):
   - `MiruroAdapter implements Adapter` with `id = 'miruro'`.
   - `canHandlePage(url)`: hostname matches `/^(www\.)?miruro\.(tv|to|bz|ru)$/` AND `pathname` matches `/^\/watch\/[^/]+(?:\/[^/]+)?\/?$/` AND `searchParams.has('ep')`.
   - `init(ctx)`:
     - Parse `showId` from path, `ep` from query. If either is missing, `ctx.fail('miruro: missing showId or ep')`.
     - Wait for `#player-container .player video` via `MutationObserver` on `document.body` (subtree). Resolve when found; reject after a bounded timeout (10 s) with `ctx.fail`.
     - If `video.currentSrc === ''`, find `#player-container .vds-video-layout button`. If found, dispatch the space `keydown` + `keyup` (with `bubbles: true, cancelable: true`). If missing, log a warning and continue — Vidstack may have shipped the video pre-loaded.
     - After the synthesized press, await one of: `loadedmetadata` on the video, or a timeout. On `loadedmetadata`, immediately `video.pause()` so the room's authoritative state can take over without a race.
     - Wire `play` / `pause` / `seeking` listeners forwarding `LocalIntent`s (same shape as `_template`).
     - Register `onCommand` for `play` / `pause` / `seek` / `sync_adjust`; `cursor_change` is a no-op until the in-page-nav slice lands.
     - `ctx.setIdentity({ providerId: 'miruro', videoId: '${showId}-ep${ep}', normalizedUrl: '/watch/${showId}?ep=${ep}' })`.
   - `getState()`: same logic as `_template` (`readyState < 3 && !paused → 'buffering'`).
   - `destroy()`: remove listeners, abort the `MutationObserver` if still pending, clear refs.

3. **Register the adapter.** Add `miruroAdapterFactory` to the `ADAPTERS` array in [`extension/src/adapters/runtime.ts`](../../../extension/src/adapters/runtime.ts) — insert **before** `templateAdapterFactory` (first-match-wins; the template should remain the fallback for the test page).

4. **Verify content-script matches.** The current build matches `<all_urls>` ([`extension/wxt.config.ts`](../../../extension/wxt.config.ts) `host_permissions` + [`extension/entrypoints/content.ts`](../../../extension/entrypoints/content.ts) `matches`). No changes needed for this slice — narrowing matches is a packaging-polish task tracked separately in [`EXTENSION_TODO.md`](../../../EXTENSION_TODO.md).

5. **Documentation pass.**
   - New file [`extension/docs/adapter-miruro.md`](../../../extension/docs/adapter-miruro.md): supported hosts, supported URL shape, the manual-load-button quirk, two-video disambiguation. Linked from `adapter-contract.md` step 11.
   - [`extension/docs/architecture.md`](../../../extension/docs/architecture.md): update the "Out-of-scope" bullet "Real site adapters. Only `_template` exists…" — miruro now ships.
   - [`extension/README.md`](../../../extension/README.md): add a miruro smoke-test recipe (open `https://www.miruro.to/watch/166617/fatestrange-fake?ep=4`, observe DevTools log line `[playbacksync:miruro] adapter activated`, verify identity payload in the worker console).

6. **Update the punch list.** Move "First real site adapter (miruro)" in [`EXTENSION_TODO.md`](../../../EXTENSION_TODO.md) from "Next up" to "Already shipped" with a link to this spec.

## Critical files

**Created:**

- `extension/src/adapters/miruro/index.ts`
- `extension/docs/adapter-miruro.md`
- `agent-os/specs/2026-05-24-1700-extension-miruro-adapter/{plan,shape,standards,references}.md`

**Modified:**

- `extension/src/adapters/runtime.ts` — register `miruroAdapterFactory`.
- `extension/docs/architecture.md` — update "Real site adapters" out-of-scope bullet.
- `extension/README.md` — miruro smoke-test recipe.
- `EXTENSION_TODO.md` — move bullet to "Already shipped".

## Verification

1. `cd extension && npm run compile && npm run lint` — must be clean. No `jsdoc/*` rules disabled.

2. **Cold-page smoke test (manual-load path).**
   - `npm run dev`, load unpacked.
   - Open `https://www.miruro.to/watch/166617/fatestrange-fake?ep=4` in a fresh tab.
   - Page-tab DevTools console: `[playbacksync:miruro] adapter activated`.
   - Verify the video has a source after the synthesized space-press (`document.querySelector('#player-container .player video').currentSrc` is non-empty).
   - Verify the video is paused after `loadedmetadata` (not auto-playing from Vidstack's default).
   - Worker DevTools receives `sendStatus` calls with the expected `currentPos` / `playerState`.

3. **Already-loaded path.**
   - Manually press play on the video, then refresh. Verify the adapter does NOT re-dispatch the space-key when `currentSrc` is already populated.

4. **Identity payload.**
   - For `https://www.miruro.to/watch/166617/fatestrange-fake?ep=4` the `setIdentity` message must be: `{ providerId: 'miruro', videoId: '166617-ep4', normalizedUrl: '/watch/166617?ep=4' }`.
   - Repeat with `https://www.miruro.tv/watch/147105/witch-hat-atelier?ep=6` → `videoId: '147105-ep6'`, `normalizedUrl: '/watch/147105?ep=6'`. Same identity across `.tv` / `.to` for the same showId/ep is the load-bearing property (workshop §7).

5. **Episode-switch (SPA navigation).**
   - From `?ep=4`, click the next episode in the miruro UI (which uses `pushState`).
   - Worker logs: `adapter torn down` followed by `adapter activated`, with a new `setIdentity` carrying the new `ep`.

6. **Two-video disambiguation.**
   - On a page known to have a second `<video>`, verify the adapter binds to the `#player-container .player video` and not the other one. Check by setting `document.querySelector('#player-container .player video').dataset.test = 'A'` and confirming the listeners fire only for that element.

7. **End-to-end sync (the actual point).**
   - Two browsers: A and B. A creates a room via the dashboard, copies the share link, opens it in B (credential pickup ships already).
   - A loads a miruro page, B loads the same URL. Both adapters activate, both send identity, the background reports matching `currentlyShowing`.
   - A presses play → B plays. A seeks → B seeks. A pauses → B pauses.

8. **Non-miruro pages stay inert.**
   - Visit `https://example.com` — `[playbacksync:runtime] no adapter matched` (template is gated by `?pbsync-template`).

## Out of scope

- `scrapeCatalog()` / `currentlyShowing.catalogFragment` reporting (deferred to the catalog spec).
- Owner-driven `CURSOR_CHANGE_REQUEST` from the page (encoder ready, needs UI).
- Real `nudge-rate` for `SYNC_ADJUST` (still a hard seek for now).
- Manifest narrowing from `<all_urls>` to per-site matches (packaging-polish task).
- A second site adapter (crunchyroll, youtube, …) — separate spec each.
- Migrating the miruro TLD list to app config.
- Vitest setup / unit tests.
- Cross-origin iframe support — miruro's `<video>` is top-level so this isn't needed here.
