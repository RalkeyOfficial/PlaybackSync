# References for `nudge-rate` for `SYNC_ADJUST`

## Similar Implementations

### v2 WebSocket client slice

- **Location:** `agent-os/specs/2026-05-24-1230-extension-ws-client/` and `extension/src/background/`.
- **Relevance:** This is where the `SYNC_ADJUST` decoder, the `applySyncAdjust` folder, and the hard-seek fallback all landed. The "deliberately not implemented yet" note in `extension/docs/protocol-client.md` §"What's deliberately not implemented yet" was added there. The fallback to remove is in `extension/src/background/session.ts:141-150`.
- **Key patterns:** Server-frame folders return `AuthoritativeCommand[]`; the WS dispatch calls `dispatchAll` with that array; suppression slots are mapped per command type via `mapCommandKind`.

### miruro adapter slice

- **Location:** `agent-os/specs/2026-05-24-1700-extension-miruro-adapter/` and `extension/src/adapters/miruro/index.ts`.
- **Relevance:** Establishes the `onCommand` switch shape every adapter follows. Both adapters today share an identical `sync_adjust` arm (`video.currentTime += cmd.delta`) — this slice replaces both at once.
- **Key patterns:** Adapters keep an internal `video: HTMLVideoElement | null` and check it before writing. The cleanup pattern (listeners removed in `destroy()`) is the model for any future `ratechange` listener — but no such listener is added in this slice.

### Adapter template

- **Location:** `extension/src/adapters/_template/index.ts`.
- **Relevance:** Canonical reference for the contract surface every new adapter implements. Lives or dies with the contract changes in this slice — if `setPlaybackRate` is added to `Adapter`, the template must implement it.

## Documentation Pointers

- **Wire protocol:** `docs/ws-protocol.md` §`SYNC_ADJUST` (lines 401–421) — server-side semantics for `nudge-rate` vs `seek`.
- **Client-side handling:** `extension/docs/protocol-client.md` §"Drift handling" (lines 99–108) and §"What's deliberately not implemented yet" (line 133). Both need updates as part of Task 6.
- **Adapter contract doc:** `extension/docs/adapter-contract.md` — needs the new `setPlaybackRate` method documented.
