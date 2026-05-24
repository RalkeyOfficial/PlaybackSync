# References for Extension Plugin Foundation

## Similar implementations

### Workshop v1 design (canonical reference)

- **Location:** [OLD_CODE/extension/docs/playback_sync_extension_architecture_adapter_based_design_workshop_v_1.md](../../../OLD_CODE/extension/docs/playback_sync_extension_architecture_adapter_based_design_workshop_v_1.md)
- **Relevance:** This is the locked v1 design from the legacy prototype. Every shape decision in this slice traces back to it.
- **Key patterns to borrow:**
  - §3 Architectural layers — Core Sync Engine (background) / Adapter Manager / Site Adapters (content) / Injected page hooks (optional). The slice implements the second and third layer; the first is deferred.
  - §4 Adapter interface — `id`, `canHandlePage(url)`, `init(ctx)`, `destroy()`. Copied verbatim into `extension/src/adapters/types.ts`.
  - §5–6 Intent vs commands — adapters emit local intent (play/pause/seek + time), receive authoritative commands (play/pause/seek/sync_adjust). v2 adds `cursor_change`.
  - §7 Content identity — `providerId` / `videoId` / `normalizedUrl`; normalized URL must NOT contain hostname.
  - §10 Reference folder structure — `content/adapters/_template/`, `content/adapters/<site>/`, `content/adapter-runtime`.
- **Deviation:** §8 "fatal on identity change" relaxed to "tear-down + re-evaluate" (see `shape.md`).

### OLD_CODE skeletal extension

- **Location:** [OLD_CODE/extension/src/](../../../OLD_CODE/extension/src/) — `content/adapter-runtime.ts` (5-line stub), `content/index.ts` (PING/PONG smoke test), `background/index.ts` (lifecycle hooks), `types/messages.d.ts`.
- **Relevance:** The structural blueprint, not working code. Shows where the runtime was meant to live and what the content↔background message types were trending toward.
- **Key patterns to borrow:** The `ContentMessage` / `BackgroundMessage` discriminated-union shape in `types/messages.d.ts` is the basis for `extension/src/messages.ts` in this slice.

## Protocol and integration references

### WebSocket protocol v2

- **Location:** [docs/ws-protocol.md](../../../docs/ws-protocol.md)
- **Relevance:** The future background WS client (out of scope here) speaks this. Shapes the **field naming** in `types.ts`: `videoId` (not `episodeId`), `pageUrl` on `cursor_change`, `time` (seconds float) for position.
- **What to read:** JOIN.currentlyShowing shape, CURSOR_CHANGE payload, SYNC_ADJUST modes (`nudge-rate` / `seek`).

### Share-link redirect

- **Location:** [lib/Controller/ShareController.php:121](../../../lib/Controller/ShareController.php#L121) (`buildRedirectUrl`)
- **Relevance:** Already emits `?sync_url=&sync_password=` query params on the share redirect. Not consumed in this slice — informs the **follow-up credential-pickup spec**: the content script will sniff these on the bootstrap landing page and pass them to the background.

### Phase 2 roadmap

- **Location:** [agent-os/product/roadmap.md](../../product/roadmap.md) §"Phase 2: Browser extension (in progress)"
- **Relevance:** Lists the concrete work items this slice unlocks: JOIN handshake + reconnect, content-script adapter w/ feedback-loop suppression, `currentlyShowing` + `catalogFragment` reporting, toolbar popup, cross-browser packaging.
