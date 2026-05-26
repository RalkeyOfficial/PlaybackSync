# `PLAYLIST_UPDATE` from the extension

`PLAYLIST_UPDATE` is the wire frame the extension uses to merge entries
into the room's playlist out-of-band — i.e. without going through a
cursor change. This document covers the background-side caller API:
[`sendPlaylistUpdate`](../src/background/ws.ts), how it interacts with
room modes, and what shape future UI should take when one wants to
expose it.

## Status

**The caller is dormant.** The function is exported and ready, but no
extension surface invokes it today. It was landed alongside the
freeform-click fix in
[`agent-os/specs/2026-05-26-1500-extension-playlist-update/`](../../agent-os/specs/2026-05-26-1500-extension-playlist-update/)
to keep the protocol seam in one place; the UI is deferred until an
adapter exists that can surface rich metadata (title, episode info,
…) for a page outside the conventional in-page episode-list pattern.

The conventional pattern — viewer clicks an episode-list button, the
room follows — is owned by the **cursor-trigger** path. See
[`agent-os/specs/2026-05-25-2107-extension-owner-cursor-change/`](../../agent-os/specs/2026-05-25-2107-extension-owner-cursor-change/)
and the JSDoc on
[`handleCursorTrigger`](../entrypoints/background.ts). Freeform clicks
go through the same cursor-trigger path; the server auto-appends
not-in-playlist targets, so freeform never needs to call
`sendPlaylistUpdate` to follow a click.

## Signature

```ts
import { sendPlaylistUpdate } from '@/src/background/ws'

sendPlaylistUpdate(
    tabId: number,
    entries: Array<VideoRefWithMeta & { source?: PlaylistEntrySource }>,
    opts?: { chainCursorTo?: VideoRefWithMeta },
): void
```

- `tabId` — the syncing tab whose runtime should emit the frame. No-op
  if no runtime is pooled or the socket isn't `OPEN` (same fail-quiet
  contract as `sendCursorChangeRequest` and `sendEvent`).
- `entries` — candidate entries to merge. Each must include
  `providerId`, `videoId`, `pageUrl`. Optional fields: `label`,
  `episodeNumber`, `seasonNumber`, `source`. The server caps batches at
  **200 entries per message** (`PlaylistService::PER_MESSAGE_CAP`); the
  per-room cap is 1000.
- `opts.chainCursorTo` — when present **and** the session is in
  freeform mode, the function sends a `CURSOR_CHANGE_REQUEST` for that
  ref immediately after the merge frame. Ignored in default and single
  modes.

## Mode behavior

| Mode      | Server response                                                  | Chain cursor on `chainCursorTo`? |
| --------- | ---------------------------------------------------------------- | -------------------------------- |
| default   | merge, broadcast full playlist                                   | no (ignored)                     |
| freeform  | merge, broadcast; auto-pruned at `freeform_auto_append_cap`      | **yes**                          |
| single    | reject with `single_mode_locked` (no merge, no broadcast)        | no (ignored, moot anyway)        |

Single mode is the caller's problem. The function does **not** pre-gate
on mode; it leaves UI gating to the caller. Read mode from the popup
snapshot (`PopupSnapshot.mode`) or from `SessionState.mode` and hide
the affordance when `mode === 'single'`.

## A sketch of a future caller

The shape the spec deliberately leaves open. A future adapter that
wants to expose "contribute this page to the room" might look like:

```ts
// in some future popup or content-side wiring
function onContributeClicked(currentVideoRef: VideoRefWithMeta): void {
    sendPlaylistUpdate(activeTabId, [currentVideoRef], {
        // Freeform: also want the room to navigate to this page
        // immediately. Default: caller probably doesn't want that
        // (that's why the room is in default mode in the first place),
        // and the function correctly drops the chain.
        chainCursorTo: currentVideoRef,
    })
}
```

The caller's responsibilities:

- Decide what a "contribution" means for that adapter (single video?
  scraped season? curated list?).
- Build the `VideoRefWithMeta` payload, ideally with `label` filled in
  so the row in the dashboard playlist editor reads cleanly.
- Gate the UI on `mode !== 'single'`.
- If the future surface lives in the popup, add the port message kind
  to [`extension/src/messages.ts`](../src/messages.ts) and wire it
  through [`entrypoints/background.ts`](../entrypoints/background.ts)
  — `sendPlaylistUpdate` is the *only* thing this slice ships, by
  design.

## Receiver side

Already wired. The server broadcasts the full post-merge playlist as
an inbound `PLAYLIST_UPDATE`; the runtime calls
[`applyPlaylistUpdate`](../src/background/session.ts) which caches the
result into `SessionState.playlist`. No commands are dispatched to the
adapter — the playlist is a passive cache used by the cursor-trigger
in-playlist check and by anything the popup chooses to show.

## See also

- [Cursor-trigger spec](../../agent-os/specs/2026-05-25-2107-extension-owner-cursor-change/) — the in-playlist-click path.
- [Freeform-mode spec](../../agent-os/specs/2026-05-16-1830-content-model-freeform-mode/) — the auto-append behavior `sendPlaylistUpdate` leans on in freeform.
- [`protocol-client.md`](./protocol-client.md) — full wire-frame catalog.
