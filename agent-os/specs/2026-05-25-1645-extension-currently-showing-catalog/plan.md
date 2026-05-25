# `currentlyShowing` + `catalogFragment` reporting on JOIN

## Context

The v2 WebSocket protocol's `JOIN` frame already accepts two optional fields:

- `currentlyShowing: VideoRef` — what the joining client is playing right now
- `catalogFragment: VideoRefWithMeta[]` — an episode list scraped from the page

The PHP server-side handlers are already wired (see [lib/WebSocket/Handler/JoinHandler.php](../../../lib/WebSocket/Handler/JoinHandler.php)): `JoinHandler` merges any `catalogFragment` into the room's playlist, seeds an empty playlist from `currentlyShowing`, and unicasts a steering `CURSOR_CHANGE` when a joiner's video doesn't match the room cursor. None of that fires today because the extension's `onOpen` ([extension/src/background/ws.ts:212-220](../../../extension/src/background/ws.ts#L212-L220)) never sets the fields.

This spec adds the missing extension-side plumbing: an optional `scrapeCatalog()` method on the `Adapter` contract, a content↔background message carrying the scraped catalog, JOIN deferral while the content script reports identity + catalog, and a real miruro implementation. Unlocks:

- Empty rooms seed themselves from the first joiner's `currentlyShowing` instead of staying cursor-less.
- Joiners with a different video are auto-steered to the room cursor (or, in freeform mode, append to the playlist).
- Rooms accumulate the union of every joiner's scraped episode list without anyone manually building a playlist.

Last open item under [EXTENSION_TODO.md](../../../EXTENSION_TODO.md) §Deferred that's reachable without redesigning multi-tab arbitration. Aligns with [agent-os/product/roadmap.md](../../product/roadmap.md) Phase 2.

## Approach

**Adapter contract — one new optional method.** Append to `Adapter` in [extension/src/adapters/types.ts](../../../extension/src/adapters/types.ts):

```ts
scrapeCatalog?(): Promise<VideoRefWithMeta[] | null>
```

- Optional (`?`) — adapters opt in; `_template` ships a stub showing the shape.
- Async — accommodates DOM-waiting (miruro's episode list hydrates with Vidstack).
- `null` means "not available". Empty array is allowed but treated the same (background omits the wire field). Thrown exceptions are caught by the runtime and treated as `null`.
- Return type matches the wire shape `VideoRefWithMeta` from [extension/src/background/protocol.ts:37-42](../../../extension/src/background/protocol.ts#L37-L42), so the background forwards verbatim — no translation layer.

**Runtime — call once per adapter lifetime, time-boxed.** After `await adapter.init(ctx)` resolves and the runtime transitions to `active` ([extension/src/adapters/runtime.ts:218-227](../../../extension/src/adapters/runtime.ts#L218-L227)), the runtime fires-and-forgets `adapter.scrapeCatalog?()` with an internal 2 s timeout. The result (or `null` on timeout / throw / no method) is forwarded via a new bridge method `sendCatalog(adapterId, catalog)`. The runtime does NOT block `init` or status polling on this — scrape failure must never break the active session.

**Background — defer JOIN until identity + catalog reported, with a cap.** In [extension/src/background/ws.ts](../../../extension/src/background/ws.ts):

- Replace `onOpen`'s immediate `send(JOIN, …)` with a pending-JOIN state on `WsRuntime`. Start a 3 s deadline timer.
- The background already receives `setIdentity` and (after this spec) `setCatalog` content-script messages keyed by tab id. Cache the latest on each `WsRuntime`: `lastIdentity: VideoRef | null`, `lastCatalog: VideoRefWithMeta[] | null`.
- `setIdentity` from the content script sends `{ providerId, videoId, pageUrl: location.href }` (extending today's `ContentIdentity` payload with `pageUrl`). The wire format wants a full URL; `ContentIdentity.normalizedUrl` is for *identity comparison*, not navigation, so it can't be reused as-is.
- JOIN fires either when both fields are populated OR the 3 s timer elapses — whichever happens first. Late arrivals after the cap are dropped on the floor (this JOIN already left without them).
- On reconnect, JOIN re-sends without `currentlyShowing` / `catalogFragment`. Server has merged them once for this room; replay would be best-effort idempotent but adds noise. Track a `firstJoinSent: boolean` per runtime; flip on first successful JOIN.

**miruro adapter — real implementation.** Add `scrapeCatalog()` to [extension/src/adapters/miruro/index.ts](../../../extension/src/adapters/miruro/index.ts). Miruro renders an episode-list sidebar/dropdown on every watch page; the implementation:

1. Wait briefly (≤1.5 s) for the episode-list container to mount via `MutationObserver` — mirror the existing `waitForVideo` pattern.
2. Query each episode entry's anchor / button; derive `videoId = "${showId}-ep${ep}"`, `pageUrl = location.origin + /watch/${showId}?ep=${ep}`, `episodeNumber = parseInt(ep)`, `label = entry text` if present.
3. Return `null` if the container never mounts or yields zero entries — better silent than misleading.

**Selectors are TBD until the implementer inspects a live miruro page.** The miruro task in this plan includes a discovery sub-step.

**`_template` adapter — stub.** Implement `scrapeCatalog()` returning `null`, with a JSDoc note explaining when to override. Keeps the fork template a complete contract reference.

## Critical files

- [extension/src/adapters/types.ts](../../../extension/src/adapters/types.ts) — add `scrapeCatalog?` to `Adapter`; import `VideoRefWithMeta` from the protocol module.
- [extension/src/adapters/runtime.ts](../../../extension/src/adapters/runtime.ts) — extend `RuntimeBridge` with `sendCatalog`; after activation, run a time-boxed `scrapeCatalog` and forward the result.
- [extension/src/adapters/miruro/index.ts](../../../extension/src/adapters/miruro/index.ts) — implement `scrapeCatalog`.
- [extension/src/adapters/_template/index.ts](../../../extension/src/adapters/_template/index.ts) — stub `scrapeCatalog` returning `null`.
- [extension/src/background/ws.ts](../../../extension/src/background/ws.ts) — JOIN deferral, identity+catalog cache on `WsRuntime`, `firstJoinSent` guard.
- The content-entrypoint file that wires `RuntimeBridge` to `chrome.runtime.sendMessage` (path: search for `sendIdentity` call sites under `extension/src/content/` or wherever the bridge is built) — add the `sendCatalog` plumbing and extend the `setIdentity` payload to include `pageUrl`.
- The background message router that consumes `setIdentity` / `sendStatus` etc. from content scripts — add `setCatalog` handler that updates the corresponding `WsRuntime` and triggers JOIN if appropriate.
- [extension/docs/adapter-contract.md](../../../extension/docs/adapter-contract.md) — document the new optional method, including failure semantics.
- [extension/docs/adapter-miruro.md](../../../extension/docs/adapter-miruro.md) — describe the catalog scraping (selectors, fallback).
- [extension/docs/protocol-client.md](../../../extension/docs/protocol-client.md) — note that JOIN now carries `currentlyShowing` + `catalogFragment` and the JOIN-deferral behavior.
- [EXTENSION_TODO.md](../../../EXTENSION_TODO.md) — remove the "`currentlyShowing` + `catalogFragment` reporting on JOIN" bullet from §Deferred.

## Tasks

### Task 1: Save spec documentation

Create this folder (`agent-os/specs/2026-05-25-1645-extension-currently-showing-catalog/`) with:

- `plan.md` — this file
- `shape.md` — scope, decisions (3 s JOIN cap, optional method, null = absent, first-JOIN-only), context (no visuals, references to nudge-rate / WS-client / miruro specs), standards N/A note
- `references.md` — pointers to nudge-rate spec, JoinHandler / MessageValidator on the PHP side, and miruro's existing `waitForVideo` as the MutationObserver template
- `standards.md` — `agent-os/standards/index.yml` covers backend PHP + Vue + build tooling; none apply to extension-internal TS. Note that and link CLAUDE.md + extension docs as the local norms.

### Task 2: Extend the Adapter contract

In [extension/src/adapters/types.ts](../../../extension/src/adapters/types.ts):

- Import `VideoRefWithMeta` from the protocol module (or re-declare a structurally compatible alias if there's a layering convention I should respect — check existing imports first).
- Append `scrapeCatalog?(): Promise<VideoRefWithMeta[] | null>` to the `Adapter` interface, after `setPlaybackRate`. JSDoc:
  - Optional; runtime invokes it once after `init`.
  - Best-effort. The runtime applies its own timeout and catches exceptions — adapters don't need to bound their own latency, but should still resolve in well under a second on the common path.
  - Returning `null` (or throwing) means "no catalog available right now"; the runtime forwards nothing and the JOIN frame omits `catalogFragment`.
  - Entries must be `VideoRefWithMeta` with **full** `pageUrl` (origin included), not the hostname-stripped `normalizedUrl`.

### Task 3: Runtime catalog orchestration

In [extension/src/adapters/runtime.ts](../../../extension/src/adapters/runtime.ts):

- Add `SCRAPE_CATALOG_TIMEOUT_MS = 2000` next to the existing tuning constants.
- Extend `RuntimeBridge` with `sendCatalog(adapterId: string, catalog: VideoRefWithMeta[] | null): void`.
- In `evaluate()`, right after the `state = { kind: 'active', … }` line and the `startStatusPolling` call, fire-and-forget a helper `runCatalogScrape(adapter)`:

  ```ts
  function runCatalogScrape(adapter: Adapter): void {
    if (!adapter.scrapeCatalog) {
      bridge?.sendCatalog(adapter.id, null)
      return
    }
    const timeout = new Promise<null>((resolve) =>
      setTimeout(() => resolve(null), SCRAPE_CATALOG_TIMEOUT_MS),
    )
    Promise.race([adapter.scrapeCatalog().catch(() => null), timeout])
      .then((result) => {
        if (state.kind !== 'active' || state.adapter !== adapter) return
        bridge?.sendCatalog(adapter.id, result ?? null)
      })
  }
  ```

- On `teardown`, no extra cleanup needed — the in-flight promise resolves later but the guard `state.adapter !== adapter` discards its result.

### Task 4: Content-entrypoint bridge wiring

In the file that builds the `RuntimeBridge` from `chrome.runtime.sendMessage` calls (find via `grep -rn "RuntimeBridge\b" extension/src` — likely `extension/src/content/main.ts` or similar):

- Add a `sendCatalog` implementation: post a message `{ kind: 'pbsync.catalog', adapterId, catalog }` to background, scoped to the current tab.
- Extend the existing `sendIdentity` payload to include `pageUrl: location.href` — needed because the wire-format `VideoRef.pageUrl` is the full URL, not the hostname-stripped `normalizedUrl`. Background reconstructs `currentlyShowing` from `{ providerId, videoId, pageUrl }`.

### Task 5: Background JOIN deferral

In [extension/src/background/ws.ts](../../../extension/src/background/ws.ts):

- Add to `WsRuntime`:
  - `lastIdentity: VideoRef | null` (default `null`)
  - `lastCatalog: VideoRefWithMeta[] | null` (default `null`)
  - `catalogReported: boolean` (default `false`) — distinguishes "background got an explicit `null` from the runtime" from "background hasn't heard anything yet"
  - `pendingJoin: { deadline: ReturnType<typeof setTimeout> | null } | null`
  - `firstJoinSent: boolean` (default `false`)
- Refactor `onOpen` (lines 212–220):

  ```ts
  function onOpen(r: WsRuntime): void {
    log('info', 'open; awaiting identity/catalog before JOIN', { tabId: r.tabId })
    r.reconnectAttempt = 0
    notifyOpen(r.tabId)
    r.cb.onLifecycleChange?.()
    if (r.firstJoinSent) {
      sendJoin(r, /* includeContentFields */ false)
      return
    }
    r.pendingJoin = {
      deadline: setTimeout(() => {
        log('info', 'JOIN deadline elapsed; sending without content fields', { tabId: r.tabId })
        flushJoin(r)
      }, 3000),
    }
    maybeFlushJoin(r) // immediate flush if cached values already present
    startTimers(r)
    scheduleInitialClockPings(r)
  }
  ```

- Add `flushJoin(r)`:

  ```ts
  function flushJoin(r: WsRuntime): void {
    if (!r.pendingJoin) return
    if (r.pendingJoin.deadline) clearTimeout(r.pendingJoin.deadline)
    r.pendingJoin = null
    sendJoin(r, true)
    r.firstJoinSent = true
  }
  ```

- Add `maybeFlushJoin(r)`: if `r.lastIdentity !== null && r.catalogReported`, call `flushJoin`. (Identity required; catalog can be `null` but must have been *reported* — the alternative is waiting forever on an adapter that doesn't implement scrapeCatalog.)
- Add `sendJoin(r, includeContentFields)`:

  ```ts
  send(r, {
    type: 'JOIN',
    password: r.creds.syncPassword,
    ...(r.creds.clientId ? { clientId: r.creds.clientId } : {}),
    ...(r.session.lastEventId > 0 ? { lastEventId: r.session.lastEventId } : {}),
    ...(includeContentFields && r.lastIdentity ? { currentlyShowing: r.lastIdentity } : {}),
    ...(includeContentFields && r.lastCatalog && r.lastCatalog.length > 0
      ? { catalogFragment: r.lastCatalog }
      : {}),
  })
  ```

- Export two new entrypoints called by the background message router (Task 6):
  - `reportIdentity(tabId, identity: VideoRef): void` — sets `r.lastIdentity`, calls `maybeFlushJoin(r)`.
  - `reportCatalog(tabId, catalog: VideoRefWithMeta[] | null): void` — sets `r.lastCatalog`, flips `r.catalogReported = true`, calls `maybeFlushJoin(r)`.
- On `onClose`, do NOT reset `firstJoinSent` — it's session-lifetime, not socket-lifetime. Identity/catalog can also persist so a fast reconnect doesn't need to re-collect.

### Task 6: Background message router

Find the file that today routes `setIdentity` content-script messages to `ws.ts` (likely under `extension/src/background/` — grep for the message kind). Add a parallel route for the new `pbsync.catalog` message. Wire both to call the new `reportIdentity` / `reportCatalog` entrypoints from Task 5.

### Task 7: miruro `scrapeCatalog`

In [extension/src/adapters/miruro/index.ts](../../../extension/src/adapters/miruro/index.ts):

1. **Discovery sub-step** (manual, by the implementer): open a miruro watch page in a real browser, locate the episode-list DOM region, capture stable selectors for the container and each entry. Document them at the top of the new method.
2. Implement `scrapeCatalog()`:
   - If `this.destroyed`, return `null`.
   - Wait up to `~1.5 s` for the episode-list container to appear via `MutationObserver` (reuse the same pattern as `waitForVideo`, but with `EPISODE_LIST_WAIT_TIMEOUT_MS`).
   - If absent after timeout → return `null`.
   - Otherwise enumerate entries. For each, derive `{ providerId: 'miruro', videoId: \`${showId}-ep${ep}\`, pageUrl: \`${location.origin}/watch/${showId}?ep=${ep}\`, episodeNumber: parseInt(ep, 10), label }`. Drop entries with no parseable `ep`.
   - Return the array (or `null` if empty).
3. Use a separate `catalogObserver` / `catalogTimer` field rather than reusing `pendingObserver` / `pendingTimer`, since `scrapeCatalog` may run concurrently with the manual-load flow on cold pages. Disconnect both on `destroy()`.

### Task 8: `_template` stub

In [extension/src/adapters/_template/index.ts](../../../extension/src/adapters/_template/index.ts):

```ts
async scrapeCatalog(): Promise<VideoRefWithMeta[] | null> {
  // Override per site: return the visible episode list as VideoRefWithMeta
  // entries with full `pageUrl`. Return null when the page doesn't expose
  // a catalog or the DOM isn't ready.
  return null
}
```

### Task 9: Docs

- [extension/docs/adapter-contract.md](../../../extension/docs/adapter-contract.md) — add a "Catalog reporting" section: optional method, runtime timeout, `null` semantics, full-URL requirement.
- [extension/docs/adapter-miruro.md](../../../extension/docs/adapter-miruro.md) — document the episode-list selectors and the fallback.
- [extension/docs/protocol-client.md](../../../extension/docs/protocol-client.md) — note that JOIN now populates `currentlyShowing` + `catalogFragment` when available, with a 3 s deferral cap before falling back to a content-field-less JOIN; reconnects always send the content-field-less form.
- [EXTENSION_TODO.md](../../../EXTENSION_TODO.md) — remove the `currentlyShowing` + `catalogFragment` bullet from §Deferred.

## Verification

1. **Build:** `cd extension && pnpm compile` (or the project's TS check — check `extension/package.json`). No TS errors after the contract change.
2. **Type exhaustiveness:** confirm no untyped call sites reference the old `sendIdentity` signature; TS should flag any miss.
3. **Manual: empty room seeding.**
   - Create a fresh room from the Nextcloud dashboard.
   - Open a miruro watch page in a browser with the extension installed and the share URL credentials applied.
   - In the room dashboard, verify the playlist seeds from `currentlyShowing` (cursor lands on the joined video) and the rest of the scraped episode list shows up as `scraped` playlist entries.
4. **Manual: steering a mismatched joiner.**
   - With a non-empty room (cursor pointing at episode 3), open a fresh tab on episode 5.
   - Confirm the joiner receives a `CURSOR_CHANGE` immediately after JOIN (DevTools WS frames) and navigates / steers accordingly.
5. **Manual: JOIN deferral cap.**
   - Force `scrapeCatalog` to throw (or temporarily set the timeout to 100 ms). Join with adapter init still pending (e.g., on a cold miruro page).
   - Confirm JOIN goes out after the 3 s cap with no `currentlyShowing` / `catalogFragment` and the room still works.
6. **Manual: reconnect.**
   - Kill the daemon mid-session. After reconnect, confirm JOIN re-sends WITHOUT `currentlyShowing` / `catalogFragment` (background WS frames show only `password` / `clientId` / `lastEventId`).
7. **PHP-side sanity (no test changes needed):** existing `tests/Unit/WebSocket/Handler/JoinHandlerTest.php` etc. continue to pass via the docker-exec `phpunit` command. Don't add new server-side tests as part of this spec — the server is already covered.

## Standards

`agent-os/standards/index.yml` indexes only backend PHP, Vue/Nextcloud frontend, and Vite/Nextcloud build tooling. None apply to extension-internal TypeScript. Defer to CLAUDE.md (no SPDX headers, no empty docblocks) and `extension/docs/` conventions, matching the posture taken by the nudge-rate and multi-tab-arbitration specs.
