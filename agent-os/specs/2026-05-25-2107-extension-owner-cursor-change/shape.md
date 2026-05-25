# Owner-driven CURSOR_CHANGE_REQUEST — Shaping Notes

## Scope

Make the in-page episode buttons (the ones the miruro adapter already scrapes for `catalogFragment`) act as a **two-way** cursor-change surface:

1. **Sender side.** A viewer clicks an episode in their tab → the room follows, *or* (depending on mode and playlist match) the viewer is softly removed from the room.
2. **Receiver side.** When the server broadcasts `CURSOR_CHANGE`, the miruro adapter synthetically clicks the matching episode button in the page's own DOM so the receiver's player navigates to the same ep via miruro's normal SPA routing path.

The user pressing the episode button is the only manual trigger. **No injected UI, no popup-driven cursor picker, no preventDefault** — the page navigates as it always does; we just listen and announce on the sender side, and replay the click on the receiver side.

## Behavior matrix

| Mode      | Target is in playlist                   | Target is not in playlist |
| --------- | --------------------------------------- | ------------------------- |
| default   | send `CURSOR_CHANGE_REQUEST` (videoRef) | soft-leave the room       |
| single    | soft-leave the room                     | soft-leave the room       |
| freeform  | drop (deferred)                         | drop (deferred)           |

**Soft-leave** = tear down the WS runtime + push a `disconnected` snapshot, *but keep* the `pbsync.tab.<tabId>` credentials slot so the popup can offer one-click Rejoin. Distinct from the existing **Leave Room** button which wipes credentials.

## Decisions

- **Adapter is mode-unaware.** Listeners attach unconditionally; the background filters per current `SessionState.mode`. Chosen over "runtime toggles a setter on the adapter" because it avoids DOM thrashing on mode changes and keeps the adapter contract narrow.
- **No `preventDefault` on the click.** Local nav proceeds as normal; we piggyback the announcement. The user's page should never feel different from what they're used to.
- **Receiver navigation replays the user's click.** The miruro adapter applies `cursor_change` commands by synthetically clicking the matching episode button in the page's own DOM, not by setting `location.href`. This keeps the SPA routing path identical for room-driven nav and user-driven nav, so any side effects miruro relies on (route-change observers, autoplay state) behave consistently.
- **Episode matching is by parsed `?ep=` number, not by playlist position.** Owners can reorder the room's playlist freely (or stupidly, as the user put it) without breaking the receiver-side resolution.
- **`Event.isTrusted` filters self-loops.** The synthetic clicks the receiver path dispatches are filtered out of the sender path so a broadcast doesn't bounce back as a fresh `CURSOR_CHANGE_REQUEST`.
- **Single mode is strict.** Any episode click in single mode soft-leaves the room — even on the room's current locked entry. The user's framing: "single mode = one locked video; any click = you've left."
- **Default mode + out-of-playlist click also soft-leaves.** Same intuition: if you're navigating to a video the room doesn't know about, you're no longer following the room.
- **Freeform is deferred.** The "how do users add to the playlist" question is the separate `PLAYLIST_UPDATE` deferred item. Freeform click handling is a no-op in this spec.
- **No server change.** Default mode already accepts `target: VideoRefWithMeta` if it matches an existing playlist entry. The entryId-only form (needed for moving between locked single-mode entries from a server-trusted caller) is left for a future dashboard or admin path.
- **Soft-leave reuses `PopupStatus = 'disconnected'`.** The popup already distinguishes `disconnected` (creds present, no socket) from `no_credentials` (no creds), so no new enum value is needed.
- **Send-side suppression stamp.** When the background sends `CURSOR_CHANGE_REQUEST` in default mode, it records `'cursor_change'` in `recentCommands` so the broadcast that comes back doesn't try to re-navigate the tab — the tab is already on the new page.

## Context

- **Visuals:** None. No UI mockups — the in-page surface is the page's own existing buttons; the only new UI is a popup "Rejoin Room" button on disconnected state.
- **References:** The `setPlaybackRate` precedent for adding to the Adapter contract (`agent-os/specs/2026-05-24-1830-extension-nudge-rate/`), and the multi-tab arbitration spec for per-tab WS teardown patterns (`agent-os/specs/2026-05-25-1530-extension-multi-tab-arbitration/`). See `references.md`.
- **Product alignment:** PlaybackSync's mission is "watch together without ceremony." Letting any viewer drive cursor changes from their own page is the natural in-the-flow affordance — no need to open a dashboard or a popup picker.

## Standards Applied

- **No author / SPDX headers** (project-wide rule from `CLAUDE.md`) — every new file in the extension respects this.
- **Frontend conventions** (`agent-os/standards/frontend/vue-conventions`) — only loosely relevant; the popup is framework-free vanilla TS, not Vue, so `@nextcloud/vue` and `l10n/*.js` keys don't apply here.
- **No new server code** — the backend `php-conventions` standard isn't engaged.
