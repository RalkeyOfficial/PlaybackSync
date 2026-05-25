# References for `currentlyShowing` + `catalogFragment` on JOIN

## Similar Implementations

### Adapter-contract extension (nudge-rate)

- **Location:** [agent-os/specs/2026-05-24-1830-extension-nudge-rate/](../2026-05-24-1830-extension-nudge-rate/)
- **Relevance:** Most recent precedent for adding a method to the `Adapter` contract. Establishes the "runtime owns timing/orchestration; adapter exposes a thin declarative primitive" split this spec follows.
- **Key patterns:**
  - JSDoc that explicitly calls out who owns the timer / latency budget.
  - `_template` and miruro implementations updated together so the contract reference stays complete.
  - Module-level state in `runtime.ts` for orchestration scaffolding (`nudgeTimer` is the parallel of what `runCatalogScrape` will need — though we're using a Promise race rather than a long-lived timer reference).
  - Verification posture: TS compile + manual smoke against the live daemon, no new tests.

### Server-side JOIN consumer (already shipped)

- **Location:** [lib/WebSocket/Handler/JoinHandler.php](../../../lib/WebSocket/Handler/JoinHandler.php)
- **Relevance:** Confirms the wire-format contract this spec must produce. Reading this file before implementing avoids redesigning the field shape.
- **Key patterns:**
  - `catalogFragment` is merged via `PlaylistService::merge` (best-effort; logged-and-swallowed on error). Extension does not need to await an ack.
  - `currentlyShowing` triggers two paths: empty-playlist seeding (`seedFromCurrentlyShowing`, lines ~180–200) and mismatch steering (`unicast CURSOR_CHANGE`, lines ~217–228). Both fire automatically — the extension just needs to populate the field.
  - Both fields are independent; the server tolerates either, both, or neither.

### Wire-format parser

- **Location:** [lib/WebSocket/MessageValidator.php](../../../lib/WebSocket/MessageValidator.php) (search for the JOIN parse block)
- **Relevance:** Authoritative shape check. The TS side (`protocol.ts:79-87`) mirrors this 1-for-1, so any divergence shows up here first.
- **Key patterns:** `parseVideoRef` / `parseCatalogFragment` confirm full-URL `pageUrl` is required on every entry — drives the decision to add `pageUrl` to the content-script identity payload.

### `MutationObserver` adapter pattern

- **Location:** [extension/src/adapters/miruro/index.ts](../../../extension/src/adapters/miruro/index.ts) lines 203–224 (`waitForVideo`)
- **Relevance:** Template for miruro's `scrapeCatalog` — same DOM-not-yet-mounted shape, same timeout-or-resolve idiom. Reuse the structure; do NOT reuse the `pendingObserver`/`pendingTimer` fields (they belong to the manual-load flow and may be in-flight when `scrapeCatalog` runs).
- **Key patterns:**
  - Synchronous fast path: try `querySelector` first, only set up an observer if the element isn't there yet.
  - Both `disconnect()` and `clearTimeout` in the `finish` closure to avoid leaks.

### Background `WsRuntime` / pool

- **Location:** [extension/src/background/ws.ts](../../../extension/src/background/ws.ts)
- **Relevance:** This is where JOIN deferral lives. The per-tab pool from the multi-tab-arbitration spec ([agent-os/specs/2026-05-25-1530-extension-multi-tab-arbitration/](../2026-05-25-1530-extension-multi-tab-arbitration/)) keys runtimes by `chrome.tabs.id`, which is exactly the granularity identity+catalog reports come in at. No extra routing logic needed.
- **Key patterns:** `WsRuntime` is the natural home for `lastIdentity`, `lastCatalog`, `firstJoinSent`, `pendingJoin` — all per-tab state with the same lifecycle as the existing fields.

## In-tree docs to update

- [extension/docs/adapter-contract.md](../../../extension/docs/adapter-contract.md) — section for `scrapeCatalog`.
- [extension/docs/adapter-miruro.md](../../../extension/docs/adapter-miruro.md) — episode-list selectors and the fallback.
- [extension/docs/protocol-client.md](../../../extension/docs/protocol-client.md) — JOIN-deferral behavior and which fields populate on first vs subsequent JOINs.
