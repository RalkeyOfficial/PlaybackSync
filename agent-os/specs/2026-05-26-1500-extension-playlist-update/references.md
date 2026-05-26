# References for `PLAYLIST_UPDATE` API + freeform-click fix

## Similar implementations

### Owner-driven `CURSOR_CHANGE_REQUEST` — the click-decision pattern

- **Location:** [`agent-os/specs/2026-05-25-2107-extension-owner-cursor-change/`](../2026-05-25-2107-extension-owner-cursor-change/)
- **Relevance:** Established `handleCursorTrigger` in [`extension/entrypoints/background.ts`](../../../extension/entrypoints/background.ts) and the soft-leave path. The freeform branch this slice replaces was explicitly deferred there ("Freeform click handling is a no-op in this spec").
- **Key patterns borrowed:**
  - Background owns the per-mode decision; adapter stays mode-unaware.
  - `sendCursorChangeRequest` send-helper shape — `sendPlaylistUpdate` is modelled on it.
  - The `recentCommands` suppression stamp survives unchanged; freeform doesn't introduce a new suppression class.

### Freeform mode — server-side auto-append

- **Location:** [`agent-os/specs/2026-05-16-1830-content-model-freeform-mode/`](../2026-05-16-1830-content-model-freeform-mode/)
- **Relevance:** [`CursorService::resolveAndApply`](../../../lib/Service/CursorService.php) auto-appends a not-in-playlist target on a freeform cursor change in the same DB transaction, with the `auto_appended` source. This is the server behavior the freeform-click fix depends on — we wouldn't need a separate `PLAYLIST_UPDATE` extension step to "register" a click in freeform.
- **Key takeaway:** the auto-append cap (default 100 via `freeform_auto_append_cap`) prunes oldest `auto_appended` entries first; curated and cursored entries are protected. Freeform-click traffic will not blow past the per-room cap because of this.

### WS client — send-helper conventions

- **Location:** [`agent-os/specs/2026-05-24-1230-extension-ws-client/`](../2026-05-24-1230-extension-ws-client/)
- **Relevance:** Established the `ws.ts` shape: one runtime pool, a generic `send(r, frame)` helper, and per-frame-type wrapper exports (`sendEvent`, `sendBuffer`, `sendCursorChangeRequest`). `sendPlaylistUpdate` joins that family.
- **Key patterns:**
  - No-op if `runtime` is not pooled / socket not OPEN — caller doesn't need to inspect runtime state.
  - `clientTs: nowMs()` stamped at send time, not at caller's call site.

## Wire protocol — pre-existing pieces we lean on

- **`PlaylistUpdateOutFrame`** at [`extension/src/background/protocol.ts:113-117`](../../../extension/src/background/protocol.ts#L113-L117) — outbound shape: `type: 'PLAYLIST_UPDATE'`, `entries: Array<VideoRefWithMeta & { source? }>`, `clientTs: number`. Encoded via the generic `encode()` at protocol.ts:246–248. Never called from extension today.
- **`PlaylistUpdateInFrame`** at [`extension/src/background/protocol.ts:182-188`](../../../extension/src/background/protocol.ts#L182-L188) — server's broadcast back: full merged playlist + `playlistVersion` + `serverTs`. Consumed by [`applyPlaylistUpdate` in `session.ts:223-228`](../../../extension/src/background/session.ts#L223-L228), which caches into `SessionState.playlist` for free.
- **Server-side validation** at [`lib/WebSocket/MessageValidator.php:150-178`](../../../lib/WebSocket/MessageValidator.php#L150-L178) — `clientTs` must be int (ms), `entries` non-empty, ≤ 200 entries per message (`PlaylistService::PER_MESSAGE_CAP`). Caller-side concerns to be aware of when writing the dormant API.
- **Server-side handler** at [`lib/WebSocket/Handler/PlaylistUpdateHandler.php`](../../../lib/WebSocket/Handler/PlaylistUpdateHandler.php) — separate per-connection rate-limiter bucket from playback events (`playlistRateLimiter`). Rejects with `single_mode_locked` when `Room::getSingleMode()` is true.

## Existing functions reused (no edits)

- [`sendCursorChangeRequest`](../../../extension/src/background/ws.ts) (`extension/src/background/ws.ts:249-253`) — called from the new freeform branch in `handleCursorTrigger`, and from the chain path in `sendPlaylistUpdate`.
- [`softLeaveTab`](../../../extension/entrypoints/background.ts) (`extension/entrypoints/background.ts:403-411`) — called from the single + default-out-of-playlist branches; the freeform branch no longer calls it.
