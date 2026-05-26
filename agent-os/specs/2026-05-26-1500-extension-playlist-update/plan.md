# Extension — `PLAYLIST_UPDATE` API plumbing + freeform-click fix

## Context

Two open gaps in the extension's room-driving surface:

1. **Freeform episode clicks drop on the floor.** The cursor-change spec [(`2026-05-25-2107-extension-owner-cursor-change`)](../2026-05-25-2107-extension-owner-cursor-change/shape.md) deliberately deferred freeform handling. Today, `handleCursorTrigger` in [`extension/entrypoints/background.ts:369-374`](../../../extension/entrypoints/background.ts#L369-L374) logs and returns when `session.mode === 'freeform'`. The server is already prepared for the fix — [`CursorService::resolveAndApply`](../../../lib/Service/CursorService.php) auto-appends a not-in-playlist target on a freeform cursor change in the same transaction.

2. **`PLAYLIST_UPDATE` from the extension has no caller.** Encoder, validator, server handler, receiver-side merge — all shipped. No code path emits an outbound `PLAYLIST_UPDATE` frame. The [`EXTENSION_TODO.md:34`](../../../EXTENSION_TODO.md#L34) item assumed a popup "Add this page" affordance; the user prefers to **defer the UI** (it's awkward — you'd have to navigate away from the room's current video to use it, which itself would trigger a soft-leave) and instead land **dormant, well-documented background API plumbing** so a future adapter (one that surfaces rich title/url/episode metadata for non-episode-list pages) can call it without further protocol work.

This slice closes both gaps in one PR. Product alignment: PlaybackSync's framing is *"watch together without ceremony"*, so freeform's tagline becomes **"clicks are cursor changes, playlist is a side-effect"** — exactly what the server already implements.

## Behavior matrix after this slice

| Mode      | Target in playlist                | Target not in playlist                                            |
| --------- | --------------------------------- | ----------------------------------------------------------------- |
| default   | send `CURSOR_CHANGE_REQUEST`      | soft-leave (unchanged)                                            |
| single    | soft-leave (unchanged)            | soft-leave (unchanged)                                            |
| freeform  | send `CURSOR_CHANGE_REQUEST` ✨    | send `CURSOR_CHANGE_REQUEST`; server auto-appends in same txn ✨   |

`sendPlaylistUpdate` chain rule (new function):

| Mode      | `opts.chainCursorTo` provided | Behavior                                                                                |
| --------- | ----------------------------- | --------------------------------------------------------------------------------------- |
| default   | (ignored)                     | `PLAYLIST_UPDATE` only                                                                  |
| single    | (ignored)                     | `PLAYLIST_UPDATE` only — server rejects with `single_mode_locked`; caller's UI must gate |
| freeform  | yes                           | `PLAYLIST_UPDATE` then `CURSOR_CHANGE_REQUEST` for the same ref                         |
| freeform  | no                            | `PLAYLIST_UPDATE` only                                                                  |

## Tasks

### Task 1: Save spec documentation

This folder, with `plan.md`, `shape.md`, `standards.md`, `references.md`. No `visuals/` — none provided, no popup UI in this slice.

### Task 2: Refactor `handleCursorTrigger` mode branching

File: [`extension/entrypoints/background.ts:361-392`](../../../extension/entrypoints/background.ts#L361-L392)

- Remove the early-return freeform-drop branch.
- Restructure to:
  - `single` → soft-leave on any click (regardless of in-playlist).
  - `freeform` → `sendCursorChangeRequest(tabId, target)` unconditionally; log accordingly.
  - `default` → existing in-playlist gate: send if in playlist, soft-leave if not.
- Keep the existing `recentCommands` flow as-is (it already covers cursor-change suppression; freeform doesn't change that contract).
- Update the JSDoc so the behavior comment matches the new matrix (the current docstring warns against unconditional freeform forwarding — that warning becomes a deliberate decision note).

### Task 3: Add `sendPlaylistUpdate` to background WS

File: [`extension/src/background/ws.ts`](../../../extension/src/background/ws.ts) — new export near `sendCursorChangeRequest` (lines 235–253).

```ts
export function sendPlaylistUpdate(
    tabId: number,
    entries: Array<VideoRefWithMeta & { source?: PlaylistEntrySource }>,
    opts?: { chainCursorTo?: VideoRefWithMeta },
): void
```

- No-op if runtime not pooled / socket not OPEN (mirror `sendCursorChangeRequest`).
- Send `{ type: 'PLAYLIST_UPDATE', entries, clientTs: nowMs() }` via the existing `send(r, …)` helper.
- Read session mode via the same path `ws.ts` already uses for `SessionState`. If `opts?.chainCursorTo` is provided **and** `session.mode === 'freeform'`, immediately call `sendCursorChangeRequest(tabId, opts.chainCursorTo)`. The server processes frames in order on a single socket, so the merge commits before the cursor change resolves.
- JSDoc must explain: (a) the freeform-only chain rule and why; (b) the function is dormant until a UI calls it; (c) single mode is rejected server-side with `single_mode_locked` and callers should gate their UI.

### Task 4: Document the API for adapter authors

New file: [`extension/docs/playlist-update.md`](../../../extension/docs/playlist-update.md) — sibling of `popup.md`, `adapter-miruro.md`.

- One-paragraph overview: why it exists, why no UI today.
- Snippet showing a future adapter / popup wiring calling `sendPlaylistUpdate`.
- Note on `single_mode_locked` and caller-side gating.
- Cross-link to the cursor-change spec for the in-playlist-click path (the more common case).

### Task 5: Update `EXTENSION_TODO.md`

- Bullet at [`EXTENSION_TODO.md:34`](../../../EXTENSION_TODO.md#L34): rewrite the "PLAYLIST_UPDATE from the extension" Deferred bullet — the encoder + caller + freeform chaining shipped here; the remaining deferred work is the **in-flow contribute UI**, blocked on a rich-metadata adapter.
- Shipped-list bullet at [`EXTENSION_TODO.md:17`](../../../EXTENSION_TODO.md#L17): the parenthetical "freeform → drop, deferred" no longer matches reality. Point at this spec.

### Task 6: Verification

Manual end-to-end test in the docker dev stack:

1. **Freeform-click → cursor change with auto-append**
   - Two browser profiles, one room flipped to freeform mode.
   - On browser A, click an episode **not** in the room's playlist.
   - Expect: A's tab navigates, B's tab navigates (synthetic click), the room's playlist gains the entry with `source: auto_appended`, dashboard `PlaylistEditor` reflects it.
2. **Freeform in-playlist click** (regression)
   - Pre-seed a curated entry, then click that episode on A.
   - Expect: both follow; no duplicate (`(providerId, videoId)` key matches existing).
3. **Default mode regression** — in-playlist click follows; out-of-playlist click soft-leaves A.
4. **Single mode regression** — any click soft-leaves A.
5. **`sendPlaylistUpdate` dormant-API smoke test**
   - From the background service-worker devtools, manually call `sendPlaylistUpdate(<tabId>, [{ providerId: 'miruro', videoId: 'test-1', pageUrl: '…', label: 'Smoke' }])`.
   - In default: server merges; dashboard playlist gains the entry.
   - In freeform with `opts.chainCursorTo`: merge + cursor moves.
   - In single: server rejects with `single_mode_locked` (visible in WS daemon log).
6. **PHP suite** — no PHP changes, but confirm green:
   ```
   docker exec -u www-data master-nextcloud-1 sh -c "cd /var/www/html/apps-extra/playbacksync && phpunit"
   ```
7. **Extension build** — `npm run build` in `extension/` confirms TS still compiles.

## Critical files

- [`extension/entrypoints/background.ts`](../../../extension/entrypoints/background.ts) — Task 2
- [`extension/src/background/ws.ts`](../../../extension/src/background/ws.ts) — Task 3
- [`extension/docs/playlist-update.md`](../../../extension/docs/playlist-update.md) — Task 4 (new)
- [`EXTENSION_TODO.md`](../../../EXTENSION_TODO.md) — Task 5

## Files reused (not modified)

- [`extension/src/background/protocol.ts`](../../../extension/src/background/protocol.ts) — `PlaylistUpdateOutFrame` schema + encoder.
- [`extension/src/background/session.ts`](../../../extension/src/background/session.ts) — `SessionState.mode`.
- [`lib/WebSocket/Handler/PlaylistUpdateHandler.php`](../../../lib/WebSocket/Handler/PlaylistUpdateHandler.php) — server-side merge; validates our chain order is safe.
- [`lib/Service/CursorService.php`](../../../lib/Service/CursorService.php) — server's freeform auto-append.

## What this spec deliberately doesn't touch

- **No popup UI.** "Add this page to room" requires navigating away from the room's video, which soft-leaves — the framing is wrong. Defer until an in-flow adapter exists.
- **No server changes.** Everything the slice needs landed in the cursor-change and freeform-mode specs.
- **No popup port envelope or adapter-context method.** The dormant API is one exported function; future UI work brings its own message channel.
- **No new tests.** The extension has no TS test runner today; adding one is a separate spec.
