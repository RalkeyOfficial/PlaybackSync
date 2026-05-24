# References for Extension WS Client

## Wire-format authority

### docs/ws-protocol.md

- **Location:** [../../../docs/ws-protocol.md](../../../docs/ws-protocol.md)
- **Relevance:** The locked v2 protocol. Every frame type/field in `extension/src/background/protocol.ts` mirrors this 1-for-1.
- **Key sections:** Envelope; Authentication and identity (`clientId`, `lastEventId`); per-frame specs for `JOIN`, `EVENT`, `HEARTBEAT`, `CLOCK_PING`, `BUFFER_*`; server frames (`ROOM_STATE`, `STATE`, `CURSOR_CHANGE`, `PLAYLIST_UPDATE`, `SYNC_ADJUST`, `CLOCK_PONG`, `ERROR`); JOIN steering reaction matrix (informs how the client should ignore JOIN-unicast `CURSOR_CHANGE` for now); sequence diagrams.

## Daemon-side mirrors

### lib/WebSocket/MessageEncoder.php

- **Location:** [../../../lib/WebSocket/MessageEncoder.php](../../../lib/WebSocket/MessageEncoder.php)
- **Relevance:** Server-side encoder for server→client frames. Mirror field naming exactly in the client's `decode`.
- **Key patterns to borrow:** Field ordering doesn't matter (JSON object), but field *names* and types must match wire-format casing (`type` is UPPER_SNAKE_CASE).

### lib/WebSocket/MessageValidator.php

- **Location:** [../../../lib/WebSocket/MessageValidator.php](../../../lib/WebSocket/MessageValidator.php)
- **Relevance:** Server's inbound validator. Mirror its required-field rules on the client's `encode` side — anything the server rejects, we should never emit.
- **Key patterns:** Hand-rolled per-method validation (`validateJoin`, `validateEvent`, …); throws typed `MessageException` with `code` / `message` ready for client transmission.

### lib/WebSocket/MessageRouter.php

- **Location:** [../../../lib/WebSocket/MessageRouter.php](../../../lib/WebSocket/MessageRouter.php)
- **Relevance:** Server's connection-state model. Shows how `JOIN` must be the first message, the 5 s join timeout, per-connection state in `SplObjectStorage<ConnectionInterface, ConnectionContext>`.

### lib/WebSocket/Handler/EventHandler.php

- **Location:** [../../../lib/WebSocket/Handler/EventHandler.php](../../../lib/WebSocket/Handler/EventHandler.php)
- **Relevance:** Implements the **broadcast-including-self** pattern (after an `EVENT`, the server fans out `STATE` to every connection *including* the sender). This is precisely what motivates client-side suppression: applying that `STATE` will trigger native `play`/`pause`/`seeking` events that would loop back as fresh intents. Hence Task 6's 600 ms suppression window.

## Predecessor spec

### Plugin foundation

- **Location:** [../2026-05-24-0959-extension-plugin-foundation/](../2026-05-24-0959-extension-plugin-foundation/)
- **Relevance:** Defined the adapter contract, runtime, and message envelope this slice extends. Read `plan.md` + `shape.md` there for the layering assumptions (background owns WS, content owns DOM, adapters own neither's concerns).

## Future-facing context

### lib/Controller/ShareController.php (`buildRedirectUrl`)

- **Location:** [../../../lib/Controller/ShareController.php#L121](../../../lib/Controller/ShareController.php#L121)
- **Relevance:** Already emits `?sync_url=&sync_password=` query params on the share redirect. This slice doesn't consume them (creds come from the dev shim); the follow-up share-URL credential-pickup spec will.

### agent-os/product/roadmap.md (Phase 2)

- **Location:** [../../product/roadmap.md](../../product/roadmap.md)
- **Relevance:** "Browser extension" phase items — JOIN handshake with `clientId` + `lastEventId`, content-script adapter with feedback-loop suppression, `currentlyShowing` + `catalogFragment` reporting (deferred), popup (deferred). This slice closes the first two.
