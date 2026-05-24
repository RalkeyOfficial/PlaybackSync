# References for First Real Site Adapter (miruro)

## Adapter foundation

### Template adapter

- **Location:** [`extension/src/adapters/_template/index.ts`](../../../extension/src/adapters/_template/index.ts)
- **Relevance:** The baseline shape — `Adapter` interface, listener wiring, command-handler switch, identity emission. The miruro adapter forks from this; structure is identical, logic differs in `canHandlePage` (real URL check), `init` (video-discovery wait + manual-load trigger), and `setIdentity` (parsed showId/ep).
- **Key patterns to reuse:**
  - The `emit = (type) => () => ctx.emitIntent({ type, time: video.currentTime })` helper for listener wiring.
  - The `play` / `pause` / `seeking` event triple.
  - The `readyState < 3 && !paused → 'buffering'` rule in `getState`.

### Adapter contract

- **Location:** [`extension/src/adapters/types.ts`](../../../extension/src/adapters/types.ts)
- **Relevance:** Defines `Adapter`, `AdapterContext`, `LocalIntent`, `AuthoritativeCommand`, `ContentIdentity`, `VideoState`. All four interfaces are consumed by the new adapter; nothing here changes.

### Runtime registry and SPA-navigation handling

- **Location:** [`extension/src/adapters/runtime.ts`](../../../extension/src/adapters/runtime.ts)
- **Relevance:**
  - The `ADAPTERS` array (line 26-28) is where `miruroAdapterFactory` is registered — insert **before** `templateAdapterFactory` so the test page still resolves to `_template` via the `?pbsync-template` query param.
  - `installNavigationListeners()` (lines 184-207) already handles `?ep=` changes via the `history.pushState` monkey-patch. Episode-switching tears down + re-evaluates with no adapter cooperation.
- **Key patterns:** First-match-wins on `canHandlePage`. Status polling cadence is 1 s — `getState` must be cheap.

### Content-script entrypoint

- **Location:** [`extension/entrypoints/content.ts`](../../../extension/entrypoints/content.ts)
- **Relevance:** Boots the runtime with a `RuntimeBridge` that forwards to the background via `chrome.runtime.sendMessage`. Matches `<all_urls>` at `runAt: 'document_idle'` — meaning the miruro adapter will be init'd after the document's first idle, which is normally before Vidstack finishes hydrating. The `MutationObserver` in the new adapter's `init` covers the remaining window.

## Adapter-writing tutorial

### Adapter contract doc

- **Location:** [`extension/docs/adapter-contract.md`](../../../extension/docs/adapter-contract.md)
- **Relevance:** "Writing a new adapter, step by step" (lines 110-122) is the procedural reference. Step 11 mandates a per-site doc — this slice ships `extension/docs/adapter-miruro.md` to satisfy it.

## Prior specs in the same plane

### Plugin foundation spec

- **Location:** [`agent-os/specs/2026-05-24-0959-extension-plugin-foundation/`](../2026-05-24-0959-extension-plugin-foundation/)
- **Relevance:** Established the contract. Explicitly called out miruro as the first concrete target ("Real site adapters (miruro first).") which this slice now satisfies.

### WS-client spec

- **Location:** [`agent-os/specs/2026-05-24-1230-extension-ws-client/`](../2026-05-24-1230-extension-ws-client/)
- **Relevance:** Established the documentation policy this slice follows. Also implements the `setIdentity → JOIN.currentlyShowing` plumbing on the background side — once the adapter sets identity, the background broadcasts it.

### Share-URL credential pickup spec

- **Location:** [`agent-os/specs/2026-05-24-1423-extension-share-url-creds/`](../2026-05-24-1423-extension-share-url-creds/)
- **Relevance:** The verification step "End-to-end sync" depends on share-link credential pickup landing first. It has — see commit `82b05d9`.

## Workshop design doc

### Workshop v1, §7 (Strict content identity)

- **Location:** [`OLD_CODE/extension/docs/playback_sync_extension_architecture_adapter_based_design_workshop_v_1.md`](../../../OLD_CODE/extension/docs/playback_sync_extension_architecture_adapter_based_design_workshop_v_1.md) §7
- **Relevance:** Source of the "no hostname in `normalizedUrl`" rule. The exact pair `miruro.tv` / `miruro.to` is cited as the canonical example.

## Old-code references

### Legacy hostname check

- **Location:** [`OLD_CODE/extension/src/content/index.ts`](../../../OLD_CODE/extension/src/content/index.ts) line 83
- **Relevance:** The only miruro logic in the old codebase — `const supportedDomains = ['miruro.tv', 'miruro.to']`. No video-finding, no URL parsing, no event wiring. Nothing concrete to port; this slice is greenfield except for the host list (now expanded with `.bz` / `.ru` per the user's TLD enumeration).

## Live site information (user-supplied)

The following details about miruro's DOM were supplied by the user during shaping (2026-05-24) and verified against the listed example URLs. They are not derivable from the codebase.

- **Supported hosts:** `miruro.tv`, `miruro.to`, `miruro.bz`, `miruro.ru` (all rotate among the same content).
- **URL shape:** `https://www.miruro.<tld>/watch/<showId>/<slug>?ep=<ep>`.
- **Example URLs:**
  - `https://www.miruro.to/watch/166617/fatestrange-fake?ep=4`
  - `https://www.miruro.tv/watch/147105/witch-hat-atelier?ep=6`
  - `https://www.miruro.bz/watch/190704/kanan-sama-wa-akumade-choroi?ep=1`
  - `https://www.miruro.ru/watch/198113/kill-ao?ep=2`
- **Pages may have more than one `<video>` element.** The player's element is reliably reachable via `#player-container .player video`.
- **Cold-page manual-load button:** present at `#player-container .vds-video-layout button`. Activated by dispatching a `keydown` + `keyup` of `Space` (`key: ' ', code: 'Space', keyCode: 32, which: 32, bubbles: true, cancelable: true`) on the button itself. A regular click does not work; the synthesized keyboard sequence does.
- **Player library:** Vidstack (`.vds-video-layout.dark`).

## Punch list

- **Location:** [`EXTENSION_TODO.md`](../../../EXTENSION_TODO.md) line 15
- **Relevance:** This slice clears the "First real site adapter (miruro)" bullet. Task 6 moves it from "Next up" to "Already shipped" with a link back to this spec.
