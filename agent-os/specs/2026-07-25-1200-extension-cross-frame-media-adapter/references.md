# References for the Cross-Frame Media Adapter

## Live diagnosis

- **`debug-ext/`** (repo root, untracked) — throwaway unpacked probe used to
  diagnose the embed. Injects into both miruro and strm.cx (`all_frames`), draws
  an on-page panel (no devtools, which itself perturbs the lazy mount), and
  reports the strm.cx frame's `<video>` up to the top frame via
  `window.top.postMessage`. Confirmed: the video is in the cross-origin strm.cx
  iframe, reachable from a content script injected into that frame, and
  self-loads (`readyState 4`, blob src, `paused`) within ~1 s. **Not shipped.**
- **Memory `miruro-strmcx-iframe-embed.md`** — records the diagnosis so a fresh
  session doesn't re-derive it.

## Foundation specs studied

### Plugin foundation (Adapter contract, content runtime)

- **Location:** [`agent-os/specs/2026-05-24-0959-extension-plugin-foundation/`](../2026-05-24-0959-extension-plugin-foundation/)
- **Relevance:** Defines the `Adapter` contract and the sealed `init` lifecycle this spec splits into `PageRole` + `MediaRole`. The per-tab adapter binding is preserved — the split is *within* a tab, across frames.
- **Key patterns kept:** the sealed-lifecycle shape (both new bases keep it), `waitForElement`/`readVideoState`/`wireIntentListeners` in `video-driver.ts` (reused verbatim by `MediaBaseAdapter`), the implicit-`tabId` model (now `+ frameId`).

### WS client (protocol + suppression)

- **Location:** [`agent-os/specs/2026-05-24-1230-extension-ws-client/`](../2026-05-24-1230-extension-ws-client/)
- **Relevance:** The convergence/suppression/heartbeat machinery is unchanged — it's tab-scoped and frame-agnostic. `media_hello` reuses `buildResyncCommands` (the same primitive the nav-guard reload path uses) to converge a late/reloaded media frame.
- **Key patterns kept:** `recordStatus` still feeds the heartbeat; intents from the media frame still pass through the same pre-convergence/settle/echo drops.

### Multi-tab arbitration (per-tab WS model)

- **Location:** [`agent-os/specs/2026-05-25-1530-extension-multi-tab-arbitration/`](../2026-05-25-1530-extension-multi-tab-arbitration/)
- **Relevance:** Established the tab-keyed session/creds/nav-guard model this spec extends with a frame dimension. `tabFrames` sits alongside `sessions`/`navGuardedTabs`, cleared on the same teardown paths.
- **Key patterns kept:** `sender.tab?.id` routing (now threading `sender.frameId`), per-tab maps cleared in `tearDownTab`/`onRemoved`/`fail`.

### miruro adapter (the site being split)

- **Location:** [`agent-os/specs/2026-05-24-1700-extension-miruro-adapter/`](../2026-05-24-1700-extension-miruro-adapter/)
- **Relevance:** Its `plan.md` explicitly parked "Cross-origin iframe support — miruro's `<video>` is top-level so this isn't needed here." That statement is now false; this spec fills the gap. The nav-guard, `url.ts` matcher, and catalog scrape from that slice are preserved unchanged in the page role.

## Cross-browser reference

- [`extension/WXT-AND-BROWSERS.md`](../../../extension/WXT-AND-BROWSERS.md) — `browser.*` not `chrome.*`; Chrome MV3 / Firefox MV2; build both targets. `all_frames` and `frameId` are supported on both; verified by inspecting the built manifests.

## Backend reference points (no change in this spec)

- The daemon treats both frames of a tab as one client (one WS per tab). No
  protocol, handler, or presence change — cross-frame is entirely a
  client-side concern.
