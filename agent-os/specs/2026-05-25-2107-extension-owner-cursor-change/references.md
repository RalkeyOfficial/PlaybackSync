# References for Owner-driven CURSOR_CHANGE_REQUEST

## Similar Implementations

### `setPlaybackRate` — Adapter contract addition pattern

- **Location:** [`agent-os/specs/2026-05-24-1830-extension-nudge-rate/`](../2026-05-24-1830-extension-nudge-rate/)
- **Relevance:** Last new method added to the `Adapter` interface. Shows the canonical shape for an "adapter does the DOM, runtime owns the orchestration" extension to the contract.
- **Key patterns to borrow:**
  - Adapter method is narrow and stateless from the runtime's POV (`setPlaybackRate(rate: number): void`).
  - Runtime owns timing / decision logic; adapter just executes.
  - Miruro implementation is a couple of lines ([`extension/src/adapters/miruro/index.ts:213-215`](../../../extension/src/adapters/miruro/index.ts#L213-L215)).
  - For *this* spec the analogue is reversed (adapter pushes events up, not the runtime pushing commands down) — but the same minimalism applies: one method on the bridge interface, one new envelope kind, runtime decides what to do with the emission.

### Multi-tab arbitration — per-tab WS teardown pattern

- **Location:** [`agent-os/specs/2026-05-25-1530-extension-multi-tab-arbitration/`](../2026-05-25-1530-extension-multi-tab-arbitration/)
- **Relevance:** Established the one-`WsRuntime`-per-tab pool and the `pbsync.tab.<tabId>` credentials slot. Our "soft-leave" needs to tear down the runtime exactly as the tab-close handler does, but leave the credentials slot intact.
- **Key patterns to borrow:**
  - How the tab-close path tears down the runtime (`chrome.tabs.onRemoved` handler in the background).
  - The split between the per-tab WS runtime and the per-tab credentials slot — they have separate lifetimes.
  - How the popup's `leave_room` envelope wipes the credentials slot — soft-leave is the same teardown *minus* the slot wipe.

### Toolbar popup — vanilla TS UI shell

- **Location:** [`agent-os/specs/2026-05-24-2031-extension-toolbar-popup/`](../2026-05-24-2031-extension-toolbar-popup/) and [`extension/docs/popup.md`](../../../extension/docs/popup.md)
- **Relevance:** The popup we're adding a Rejoin button to is framework-free vanilla TS, port-based, snapshot-driven. Shows where the Leave Room button is wired today and the snapshot → render flow.
- **Key patterns to borrow:**
  - Snapshot-derived UI: render off `PopupSnapshot.status`; do not maintain UI-side state for the disconnected/rejoin transition.
  - The existing Leave Room button is the template for the Rejoin button — same port message shape, same "background does the work" pattern.

### `currentlyShowing` + `catalogFragment` on JOIN — miruro catalog scrape

- **Location:** [`agent-os/specs/2026-05-25-1645-extension-currently-showing-catalog/`](../2026-05-25-1645-extension-currently-showing-catalog/) and the miruro adapter's `waitForEpisodeList` + `collectEpisodeEntries` ([`extension/src/adapters/miruro/index.ts`](../../../extension/src/adapters/miruro/index.ts))
- **Relevance:** Already locates the exact DOM elements we want to attach click listeners to (`button[data-episode-id]` under `#episodes-list-container`). The `MutationObserver` already re-fires on late hydration; this spec reuses both.
- **Key patterns to borrow:**
  - Same selectors, same observer.
  - The `VideoRefWithMeta` payload built in `collectEpisodeEntries` is exactly what we want to ship on click — copy that construction.

## Wire protocol — pre-existing pieces we lean on

- **`CursorChangeRequestFrame`** ([`extension/src/background/protocol.ts:99-110`](../../../extension/src/background/protocol.ts#L99-L110)) — already defined, never called. Two variants: `targetEntryId` (single-mode strict path) or `target: VideoRefWithMeta` (the path we use).
- **`CursorChangeFrame`** ([`extension/src/background/protocol.ts:174-180`](../../../extension/src/background/protocol.ts#L174-L180)) — server's broadcast back. `applyCursorChange` in [`session.ts:217-221`](../../../extension/src/background/session.ts#L217-L221) already produces a `cursor_change` command for the navigating tab.
- **Server-side mode rules** ([`lib/Service/CursorService.php:20-39`](../../../lib/Service/CursorService.php#L20-L39)) — confirm that default mode accepts videoRef-against-existing-entry; single mode rejects raw videoRef; freeform auto-appends (which is exactly the behavior we're sidestepping by dropping the request entirely in freeform).
