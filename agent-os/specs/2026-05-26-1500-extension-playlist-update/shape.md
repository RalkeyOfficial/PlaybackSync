# Extension `PLAYLIST_UPDATE` API + freeform-click fix — Shaping Notes

## Scope

Two threads in one slice:

1. **Freeform clicks become cursor changes.** Today, [`handleCursorTrigger`](../../../extension/entrypoints/background.ts) early-returns when `session.mode === 'freeform'` — every click on an episode in a freeform room is dropped. Restructure the mode branching so freeform sends `CURSOR_CHANGE_REQUEST` unconditionally. The server already handles the not-in-playlist case (auto-append + cursor move in one transaction in [`CursorService::resolveAndApply`](../../../lib/Service/CursorService.php)), so no protocol change is needed.

2. **Dormant `sendPlaylistUpdate` background function.** Encoder, validator, server handler, receiver-side merge are all shipped; nothing in the extension emits `PLAYLIST_UPDATE`. Land a single exported function `sendPlaylistUpdate(tabId, entries, opts?)` in [`extension/src/background/ws.ts`](../../../extension/src/background/ws.ts) with no caller, so a future adapter or popup affordance can pick it up without re-doing protocol plumbing. The function owns the freeform-chain rule (PLAYLIST_UPDATE followed by CURSOR_CHANGE_REQUEST for the same ref).

## Decisions

- **No popup "Add this page" UI in this slice.** The original framing — a toolbar button that adds the current tab's video to the room — is broken in practice: to use it, the user has to navigate away from the room's current video first, which triggers the soft-leave path. Defer the UI until an in-flow adapter exists that can surface rich metadata (title, episode info, etc.) for non-episode-list pages. The API is shipped, the surface is not.

  **Why:** keeps the cognitive load tight (this slice ships one user-visible behavior — freeform clicks now work) and the surface clean for a future adapter to decide what "contributing this page" means in its context.

  **How to apply:** when the next adapter that wants this lands, it brings its own port message and popup affordance; nothing in this slice presumes their shape.

- **Freeform clicks unconditionally send `CURSOR_CHANGE_REQUEST`** — even when the target isn't in the playlist. Matches the user's framing: *"in freeform, clicking on a video does a cursor change; the playlist system is more or less optional."* The server already implements the auto-append-on-cursor-change branch in freeform, so the extension just stops dropping.

  **Why:** the cursor-change spec deferred this on purpose pending a decision here. The decision is "fall back to the server's existing freeform behavior" rather than "require a separate PLAYLIST_UPDATE step in the extension."

  **How to apply:** the freeform branch in `handleCursorTrigger` becomes `sendCursorChangeRequest(tabId, target)` with no in-playlist check.

- **`sendPlaylistUpdate` owns the freeform chain rule, not the caller.** When `opts.chainCursorTo` is provided **and** mode is `'freeform'`, the function sends `PLAYLIST_UPDATE` then immediately sends `CURSOR_CHANGE_REQUEST`. In default mode, `chainCursorTo` is ignored (no chain). In single mode, the server will reject the merge with `single_mode_locked` and the chained cursor-change is moot.

  **Why:** symmetric with how `handleCursorTrigger` owns the mode-decision for clicks. Future callers don't have to replicate the rule.

  **How to apply:** the function reads `session.mode` itself; callers pass `chainCursorTo` whenever they have a "we should watch this now" intent and let the function decide whether to act on it.

- **Single mode is the caller's UI problem.** The function still tries to send `PLAYLIST_UPDATE` in single mode; the server rejects with `single_mode_locked`. The function does not pre-gate. A caller-side UI should gate on `session.mode !== 'single'` before exposing its "add" affordance, just like `handleCursorTrigger` soft-leaves on single-mode clicks today.

  **Why:** keeps the function pure transport. Mode is broadcast to the popup already, so any caller can read it from its own state instead of being told by the function.

- **No popup port envelope, no `AdapterContext` method.** The dormant API is exposed only as an importable function. No `PopupToBackground` envelope kind, no `RuntimeBridge` method, no `ctx.contributeToPlaylist()` — those land when a real UI does.

  **Why:** speculative wiring rots. If we ship a `'add_to_playlist'` popup envelope with no button using it, the next person reading the code can't tell whether it's actively used.

- **Frame order on the chain is safe.** The server processes frames sequentially on a single socket (Ratchet's per-connection queue). The PLAYLIST_UPDATE merge commits inside `withRoomLock`; the subsequent CURSOR_CHANGE_REQUEST acquires the same lock and sees the merged playlist. No retry/await logic in the extension.

- **No new tests.** The extension has no TS test harness today (`extension/` has no test directory, no vitest, no jest). Adding the harness is out of scope; manual verification covers both threads. If automated coverage is wanted, that's a separate spec.

## Context

- **Visuals:** none provided; no UI in this slice.
- **References:**
  - [`agent-os/specs/2026-05-25-2107-extension-owner-cursor-change/`](../2026-05-25-2107-extension-owner-cursor-change/) — established `handleCursorTrigger`, the soft-leave path, and the explicit deferral of freeform.
  - [`agent-os/specs/2026-05-16-1830-content-model-freeform-mode/`](../2026-05-16-1830-content-model-freeform-mode/) — established the auto-append-on-cursor-change behavior we now lean on, plus the auto-prune cap.
  - [`agent-os/specs/2026-05-24-1230-extension-ws-client/`](../2026-05-24-1230-extension-ws-client/) — established the `ws.ts` send-helper pattern (`send`, `sendEvent`, `sendCursorChangeRequest`) that `sendPlaylistUpdate` mirrors.
- **Product alignment:** PlaybackSync's mission is decentralized watch-parties without ceremony ([`agent-os/product/mission.md`](../../product/mission.md)). Freeform's "playlist is optional" framing fits that directly — viewers click episodes and the room follows, no manual playlist curation step.

## Standards Applied

- **No author / SPDX headers** (project-wide rule from `CLAUDE.md`).
- **JSDoc with real descriptions** on the new `sendPlaylistUpdate` export and on the updated `handleCursorTrigger` (per the project comment policy — comments explain *why*).
- [`tooling/build`](../../standards/tooling/build.md) — extension TS goes through the standard build; no ESLint disables.
- **Not engaged:** `frontend/vue-conventions` (no Vue), `backend/php-conventions` (no PHP).
