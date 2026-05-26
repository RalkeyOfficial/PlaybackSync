# Owner-driven CURSOR_CHANGE_REQUEST — Shaping Notes

## Scope

Make the in-page episode buttons (the ones the miruro adapter already scrapes for `catalogFragment`) act as a **two-way** cursor-change surface:

1. **Sender side.** A viewer clicks an episode in their tab → the room follows (default-in-playlist, freeform-any), *or* the tab is pulled back to the room's current cursor (default-not-in-playlist, single-any). Either way the viewer stays connected.
2. **Receiver side.** When the server broadcasts `CURSOR_CHANGE`, the miruro adapter synthetically clicks the matching episode button in the page's own DOM so the receiver's player navigates to the same ep via miruro's normal SPA routing path.

The user pressing the episode button is the only manual trigger. **No injected UI, no popup-driven cursor picker, no preventDefault** — the page navigates as it always does; we just listen and announce on the sender side, and replay the click on the receiver side.

## Behavior matrix

| Mode      | Target is in playlist                   | Target is not in playlist                          |
| --------- | --------------------------------------- | -------------------------------------------------- |
| default   | send `CURSOR_CHANGE_REQUEST` (videoRef) | pull tab back to cursor (stay connected)           |
| single    | pull tab back to cursor                 | pull tab back to cursor                            |
| freeform  | send `CURSOR_CHANGE_REQUEST` (videoRef) | send `CURSOR_CHANGE_REQUEST` (server auto-appends) |

The room's current cursor is the source of truth for anchored modes (default, single). An off-target click is corrected, not penalised — the tab snaps back, the WS runtime stays up, the popup stays on `joined`. Leaving a room is only ever done via the popup's explicit Leave Room button.

## Decisions

- **Adapter is mode-unaware.** Listeners attach unconditionally; the background filters per current `SessionState.mode`. Chosen over "runtime toggles a setter on the adapter" because it avoids DOM thrashing on mode changes and keeps the adapter contract narrow.
- **No `preventDefault` on the click.** Local nav proceeds as normal; we piggyback the announcement. The user's page should never feel different from what they're used to.
- **Receiver navigation replays the user's click.** The miruro adapter applies `cursor_change` commands by synthetically clicking the matching episode button in the page's own DOM, not by setting `location.href`. This keeps the SPA routing path identical for room-driven nav and user-driven nav, so any side effects miruro relies on (route-change observers, autoplay state) behave consistently.
- **Episode matching is by parsed `?ep=` number, not by playlist position.** Owners can reorder the room's playlist freely (or stupidly, as the user put it) without breaking the receiver-side resolution.
- **`Event.isTrusted` filters self-loops.** The synthetic clicks the receiver path dispatches are filtered out of the sender path so a broadcast doesn't bounce back as a fresh `CURSOR_CHANGE_REQUEST`. The same mechanism keeps the pull-back path quiet — `pullTabBackToCursor` dispatches the same `cursor_change` command shape the adapter already handles, and the resulting synthetic click is filtered the same way.
- **Pull back, don't disconnect.** Anchored rooms (default, single) treat navigation as something the room politely corrects, not as a signal that the user left. Misclicks on related-video thumbnails are the single most common navigation event on miruro/YouTube/anime sites; making them destructive (eject → rejoin) would create constant friction for the *most* common user action. The room's identity is "we're anchored to this content," and the appropriate response to drift is to yank back, not eject.
- **Single mode is strict, but in the same way as default.** Any click that doesn't match the locked entry pulls the tab back. A click on the locked entry is a no-op (the pull-back's target equals the current URL, so the adapter's `location.href === pageUrl` short-circuit fires). Same rule as default; the playlist just happens to have exactly one valid destination.
- **Freeform sends unconditionally.** No playlist-membership check for freeform; clicks go straight out as `CURSOR_CHANGE_REQUEST`. The server's `CursorService::resolveAndApply` auto-appends the not-in-playlist target inside the same room-locked transaction as the cursor move. Freeform's whole intent — "clicks are cursor changes, the playlist is a side effect" — collapses into one wire frame.
- **No server change.** Default mode already accepts `target: VideoRefWithMeta` if it matches an existing playlist entry. The entryId-only form (needed for moving between locked single-mode entries from a server-trusted caller) is left for a future dashboard or admin path. The pull-back is purely client-side via the existing `cursor_change` adapter command path.
- **`pullTabBackToCursor` reads `session.cursor.pageUrl`.** The session always holds the room's authoritative cursor after `ROOM_STATE` / `CURSOR_CHANGE` apply. If `session.cursor` is `null` (empty playlist in default mode pre-seed, or pre-JOIN race), pull-back is a no-op — there's nowhere to pull back to, and the click stays where it landed until the first `CURSOR_CHANGE` arrives.

## Auto-disconnect audit

Every path that closes a WS or tears down a per-tab runtime, categorized for the post-pull-back rule. The rule is: **only explicit user intent or unrecoverable server-side state closes the runtime; navigation never does.**

- **`handleCursorTrigger` default-off-list / single-mismatch** — formerly `softLeaveTab`. Now calls `pullTabBackToCursor` and the runtime stays up.
- **Popup `leave_room` envelope** (`handlePopupMessage`) → `tearDownTab`. Explicit user intent via the popup's Leave Room button. **Keep.** This is the only user-driven path that closes a room.
- **`onTerminal` callback** from `ws.ts` terminal close codes (`ROOM_NOT_FOUND`, `ROOM_EXPIRED`, `ROOM_DELETED`, `AUTH_FAILED`, `KICKED`, `CLIENT_ID_IN_USE`, plus `reconnect exhausted`) → `tearDownTab`. Server-driven; the creds are dead and no reconnect can succeed. **Keep.**
- **Adapter `fail` message** (content → background) → inline `disconnect` + `clearCreds`. The adapter signaled it cannot continue (e.g. page deshapes). **Keep.**
- **`chrome.tabs.onRemoved`** → inline `disconnect` + `clearCreds`. The tab is gone. **Keep.**
- **Transient socket drop** → `ws.onClose` flips the popup mirror to `'disconnected'` and schedules reconnect with exponential backoff (1s → 30s). Creds stay, runtime stays pooled, status briefly shows `'disconnected'` until the next attempt opens. Not a user-driven close; not in scope. **Keep.**

Soft-leave (the previous `softLeaveTab` mechanism that closed the socket but kept creds, paired with a popup "Rejoin room" button) is removed. With the only call site replaced by pull-back, the entire scaffolding became dead code — `softLeaveTab`, `softLeftTabs`, `handleRejoinRoom`, the `rejoin_room` popup envelope, and the popup's Rejoin button — all deleted in the same change. The `'disconnected'` `PopupStatus` survives because reconnect-pending still needs it; the popup copy is updated from "Press Rejoin to reconnect" to "Reconnecting automatically".

## Context

- **Visuals:** None. No UI mockups — the in-page surface is the page's own existing buttons. The pull-back path is invisible to the user: their tab snaps back to the cursor's URL via the same synthetic-click code path the receiver side already uses for incoming `CURSOR_CHANGE` frames. The popup's `'disconnected'` state copy is updated to read "Reconnecting automatically" (the Rejoin button it formerly hosted is removed).
- **References:** The `setPlaybackRate` precedent for adding to the Adapter contract (`agent-os/specs/2026-05-24-1830-extension-nudge-rate/`), and the multi-tab arbitration spec for per-tab WS teardown patterns (`agent-os/specs/2026-05-25-1530-extension-multi-tab-arbitration/`). See `references.md`.
- **Product alignment:** PlaybackSync's mission is "watch together without ceremony." Letting any viewer drive cursor changes from their own page is the natural in-the-flow affordance — no need to open a dashboard or a popup picker.

## Standards Applied

- **No author / SPDX headers** (project-wide rule from `CLAUDE.md`) — every new file in the extension respects this.
- **Frontend conventions** (`agent-os/standards/frontend/vue-conventions`) — only loosely relevant; the popup is framework-free vanilla TS, not Vue, so `@nextcloud/vue` and `l10n/*.js` keys don't apply here.
- **No new server code** — the backend `php-conventions` standard isn't engaged.
