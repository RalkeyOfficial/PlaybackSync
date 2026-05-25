# `currentlyShowing` + `catalogFragment` reporting on JOIN — Shaping Notes

## Scope

Wire the extension to populate the two existing optional JOIN fields (`currentlyShowing`, `catalogFragment`) so the server-side JOIN handlers — already merged and tested — actually fire. Adds an optional `scrapeCatalog()` method to the `Adapter` contract, a real implementation for miruro, JOIN deferral in the background until the content script reports identity + catalog, and a `_template` stub so the contract stays a complete reference.

## Decisions

- **Optional method, opt-in per adapter.** Adapters without a meaningful episode list don't have to fake one. The runtime treats the absence of `scrapeCatalog` the same as a `null` result — JOIN goes out without `catalogFragment`. `_template` carries a stub returning `null` to document the shape for fork authors.
- **Runtime owns the timeout, not the adapter.** A single `SCRAPE_CATALOG_TIMEOUT_MS = 2000` lives in `runtime.ts`. Adapters can take as long as they want (within reason) and the runtime caps total latency uniformly. Mirrors the nudge-rate split: adapter exposes a thin primitive, runtime owns timing.
- **`null` means absent at the wire level.** Adapters return `null`, the runtime forwards `null`, the background omits `catalogFragment` from the JOIN frame entirely. Empty arrays are coerced to absence too (no point sending `catalogFragment: []`). Matches the optional-field shape in `protocol.ts`.
- **Background defers JOIN with a 3 s cap, not blocks forever.** Identity/catalog arrive on a separate channel (content-script `chrome.runtime.sendMessage`) than the WS socket. The background waits up to 3 s for both, then sends JOIN with whatever's cached — possibly nothing. A misbehaving adapter must never lock a room out. The cap is `SCRAPE_CATALOG_TIMEOUT_MS + ~1 s headroom` for the message round-trip.
- **First JOIN only; reconnect re-sends bare.** Server merges `catalogFragment` once per room, and `currentlyShowing`'s empty-playlist seeding only matters when the room is empty (which it isn't post-first-JOIN). Replaying on every reconnect would add server-side noise for zero gain. Track `firstJoinSent` per `WsRuntime`; flip on first successful flush.
- **`pageUrl` is added to the content-script→background identity payload.** The wire format wants a full URL; `ContentIdentity.normalizedUrl` is hostname-stripped for *identity comparison*, not navigation. Cleanest fix: include `location.href` alongside `providerId` + `videoId` in the message the content script already sends.
- **No tests.** Matches the posture of every prior extension slice (miruro / WS-client / share-URL-creds / popup / multi-tab-arbitration). Verification is `pnpm compile` + manual smoke against a live daemon, with the server-side already covered by existing PHP unit tests.

## Context

- **Visuals:** None — internal protocol-handling change with no UI surface.
- **References:**
  - [agent-os/specs/2026-05-24-1830-extension-nudge-rate/](../2026-05-24-1830-extension-nudge-rate/) — closest analog (adding a method to the `Adapter` contract with a runtime-owned timer).
  - [lib/WebSocket/Handler/JoinHandler.php](../../../lib/WebSocket/Handler/JoinHandler.php) — server-side consumer of both fields, including the empty-playlist seeding and `CURSOR_CHANGE` steering paths.
  - [lib/WebSocket/MessageValidator.php](../../../lib/WebSocket/MessageValidator.php) — parse contract for the JOIN frame.
  - [extension/src/adapters/miruro/index.ts](../../../extension/src/adapters/miruro/index.ts) `waitForVideo` (lines 203–224) — `MutationObserver` template the miruro `scrapeCatalog` implementation should mirror.
- **Product alignment:** [agent-os/product/roadmap.md](../../product/roadmap.md) Phase 2 lists `currentlyShowing` + `catalogFragment` reporting as a concrete browser-extension milestone. This spec ships it. Removes the last addressable bullet from [EXTENSION_TODO.md](../../../EXTENSION_TODO.md) §Deferred that doesn't require the multi-tab-arbitration redesign.
- **Future-proofing:** The browser-wide shared `clientId` work (still deferred — see EXTENSION_TODO §Deferred) would pivot from per-tab WS to per-room WS. This spec keeps catalog/identity reporting strictly per-tab, so the data path is reusable regardless of how the WS topology evolves.

## Standards Applied

N/A — [agent-os/standards/index.yml](../../standards/index.yml) covers backend PHP conventions, Vue/Nextcloud frontend conventions, and Vite/Nextcloud build tooling. None apply to extension-internal TypeScript modules. Defer to [CLAUDE.md](../../../CLAUDE.md) and `extension/docs/*.md`, same as the nudge-rate and multi-tab-arbitration specs.
