# Extension — Owner-driven CURSOR_CHANGE_REQUEST

## Context

The browser extension currently only *follows* the room — it reports its tab's playback state and applies authoritative commands from the server. There is no way for a viewer to drive the room's cursor from inside the extension, even though:

- The wire encoder for `CURSOR_CHANGE_REQUEST` already exists ([`extension/src/background/protocol.ts:99-110`](../../../extension/src/background/protocol.ts#L99-L110)) and has never been called.
- The server accepts the frame from any joined client; mode-specific rules ([`lib/Service/CursorService.php:20-39`](../../../lib/Service/CursorService.php#L20-L39)) arbitrate acceptance.
- The miruro adapter already locates the in-page episode list (`button[data-episode-id]` under `#episodes-list-container`) to populate `catalogFragment` on JOIN — the exact DOM elements a viewer would click to change the room's cursor.

Goal: when a viewer clicks an episode in their own tab, the room follows them — without any injected UI or click hijacking. The adapter attaches passive click listeners to the same buttons it already scrapes; the background decides per-mode whether to announce the click, drop it, or soft-leave the room.

**Out of scope** — freeform "add a new video to the playlist" behavior is the separate `PLAYLIST_UPDATE` deferred item in [EXTENSION_TODO.md](../../../EXTENSION_TODO.md). This spec only handles navigation within the room's existing playlist.

## Behavior summary

The user's click on an episode button always navigates their own tab normally (passive — no `preventDefault`). What the background does with the announcement depends on room mode:

| Mode      | Target is in playlist | Target is not in playlist |
| --------- | --------------------- | ------------------------- |
| default   | send `CURSOR_CHANGE_REQUEST` (videoRef) | soft-leave the room |
| single    | soft-leave the room   | soft-leave the room       |
| freeform  | drop (deferred)       | drop (deferred)           |

"Soft-leave" = tear down the WS runtime but keep the `pbsync.tab.<tabId>` credentials slot intact, so the popup can offer a one-click Rejoin. Distinct from the existing **Leave Room** button which wipes credentials.

## Tasks

### Task 1: Save spec documentation

This folder, with `plan.md`, `shape.md`, `references.md`, `standards.md`.

### Task 2: Extend the adapter → runtime bridge with a cursor-trigger callback

Files: [`extension/src/adapters/types.ts`](../../../extension/src/adapters/types.ts), [`extension/src/adapters/runtime.ts`](../../../extension/src/adapters/runtime.ts), [`entrypoints/content.ts`](../../../entrypoints/content.ts), [`extension/src/messages.ts`](../../../extension/src/messages.ts)

- Add `sendCursorTrigger(adapterId: string, target: VideoRefWithMeta): void` to the `RuntimeBridge` interface (alongside the existing `sendCatalog`, `sendIntent`, etc.).
- The adapter doesn't get this on `AdapterContext` directly — it receives the same `ctx` it does today; the new method is on the bridge it's already wired through. Mirrors how `sendCatalog` works.
- Content script (`entrypoints/content.ts`) implements the new bridge method as `chrome.runtime.sendMessage({ kind: 'cursor_trigger', adapterId, target })`.
- Add `cursor_trigger` to the content-→-background envelope union in [`extension/src/messages.ts`](../../../extension/src/messages.ts).
- No new protocol frame — this is internal to the extension; the outbound wire frame is the existing `CursorChangeRequestFrame`.

### Task 3: Miruro adapter — sender and receiver paths

File: [`extension/src/adapters/miruro/index.ts`](../../../extension/src/adapters/miruro/index.ts)

**Sender path** — emit a cursor trigger when the user clicks an episode:

- Use **event delegation** on `#episodes-list-container` (one delegated `click` listener) rather than per-button listeners. Robust against miruro re-rendering the inner buttons; no per-button bookkeeping needed.
- Listener is passive — it does **not** call `preventDefault`. Miruro's own SPA routing handles the local nav.
- Filter on `Event.isTrusted` so the synthetic clicks dispatched by the **receiver path** below don't loop back to the server.
- The handler resolves the clicked `button[data-episode-id]` via `closest()`, extracts the ep number with the existing `extractEpisodeNumber`, builds a `VideoRefWithMeta` (the same shape `collectEpisodeEntries` already produces), and calls `ctx.emitCursorTrigger(target)`.
- `destroy()` removes the delegated listener.

**Receiver path** — apply an authoritative `cursor_change` command by replaying the user's own click:

- In the `onCommand` switch arm for `cursor_change`, call a new `applyCursorChange(pageUrl)` private method.
- The method parses the target URL, extracts `?ep=`, and finds the in-page `button[data-episode-id]` whose extracted `EP <n>` matches. The episode is matched **by parsed ep number**, not by playlist order — owners can reorder the room's playlist freely without affecting which DOM element gets clicked.
- Synthetic `.click()` triggers miruro's SPA routing exactly as a real click does. The `isTrusted: false` filter on the sender path keeps the replay from being announced back to the server.
- Fall back to a full `location.href` navigation when:
  - we're already at the target URL (typical for the original sender, whose SPA route updated before the broadcast came back),
  - the target URL parses to a different show (miruro's SPA only handles in-show ep changes),
  - the episode list isn't in the DOM yet (cold page mid-hydration),
  - no button matches the target ep (paginated lists, season filters).

### Task 4: Background — decision logic and soft-leave

Files: [`extension/src/background/`](../../../extension/src/background/), [`extension/src/background/session.ts`](../../../extension/src/background/session.ts)

- Add a `handleCursorTrigger(tabId, target)` path in the background's message handler.
- Look up the tab's `SessionState`. The session already exposes `mode` and `playlist` ([`session.ts:73-75`](../../../extension/src/background/session.ts#L73-L75)).
- Decision logic exactly per the matrix above. Matching predicate: an entry matches the target when `entry.providerId === target.providerId && entry.videoId === target.videoId` — the room's existing identity key.
- "Send `CURSOR_CHANGE_REQUEST`" path: build a `CursorChangeRequestFrame` with `target: VideoRefWithMeta` and `clientTs: Date.now()`, send via the existing WS runtime for that tab.
- "Soft-leave" path: implement as a new helper that:
  1. Tears down the per-tab `WsRuntime` (existing teardown path used today on tab-close).
  2. Leaves the `pbsync.tab.<tabId>` storage slot **untouched** (contrast with the popup's `leave_room` which clears it).
  3. Pushes a fresh `PopupSnapshot` with `status: 'disconnected'` over the snapshot port.
- Reuse `PopupStatus = 'disconnected'` — no new status enum value needed. The popup already distinguishes `disconnected` from `no_credentials` based on whether creds are present, so the existing UI treatment will fall out correctly.
- Suppression-window note: when the request is actually sent in default mode, stamp `s.recentCommands` with kind `'cursor_change'` so the corresponding `CURSOR_CHANGE` broadcast that comes back doesn't try to re-navigate the tab (the tab is already on the new page). See [`session.ts:51-55, 287-291`](../../../extension/src/background/session.ts#L51-L55) — the `recordCommand` machinery already knows the `'cursor_change'` kind.

### Task 5: Popup — Rejoin button on disconnected state

Files: [`extension/src/popup/`](../../../extension/src/popup/), [`extension/src/messages.ts`](../../../extension/src/messages.ts)

- Add a **Rejoin Room** button alongside (or replacing) the existing Leave Room button when `status === 'disconnected'` and creds are present for that tab.
- New popup-→-background envelope kind: `rejoin_room`. Background re-establishes the WS runtime for the named tab using the stored creds.
- The existing **Leave Room** button stays as the "hard leave" (wipes creds + tears down).
- Popup is framework-free vanilla TS; no `@nextcloud/vue` components and no `l10n/*.js` keys apply. Confirm during implementation whether popup copy strings live elsewhere.

### Task 6: Verification

End-to-end check on a real miruro page (the only adapter with a real catalog today). Two browsers / two profiles, one shared room.

1. **Default mode, in-playlist click** (default scenario for miruro):
   - Both clients JOIN ep 1. Room playlist gets populated by miruro's catalog scrape.
   - Client A clicks ep 5. Verify: A's tab navigates to ep 5; B's tab navigates to ep 5 via the `CURSOR_CHANGE` broadcast.
2. **Default mode, out-of-playlist click**:
   - Confine the room playlist to a subset (e.g., set the room to a playlist of only eps 1–3 via the dashboard).
   - Client A on ep 1 clicks ep 5. Verify: A's tab navigates locally; A's popup shows `disconnected` + Rejoin button; B's tab stays on ep 1. Rejoin button re-establishes WS without re-typing creds.
3. **Single mode, any click**:
   - Owner sets the room to single mode via the dashboard.
   - Client A clicks any episode button. Verify: A leaves the room (soft) regardless of whether the click was on the locked entry or another.
4. **Freeform mode**:
   - Owner sets freeform. Client A clicks any episode. Verify: nothing happens beyond local nav (no announcement, no leave). Confirms the deferred-bit is genuinely deferred.
5. **PHP-side smoke** — no PHP changes in this spec, but run the test suite anyway to confirm the existing server behavior the spec relies on:
   ```
   docker exec -u www-data master-nextcloud-1 sh -c "cd /var/www/html/apps-extra/playbacksync && phpunit"
   ```

## Critical files

- [`extension/src/adapters/types.ts`](../../../extension/src/adapters/types.ts) — `Adapter`, `RuntimeBridge`, `VideoRefWithMeta`
- [`extension/src/adapters/runtime.ts`](../../../extension/src/adapters/runtime.ts) — adapter lifecycle owner; the bridge type lives here
- [`extension/src/adapters/miruro/index.ts`](../../../extension/src/adapters/miruro/index.ts) — episode-list scrape; new click listeners go here
- [`entrypoints/content.ts`](../../../entrypoints/content.ts) — bridge implementation; new `sendCursorTrigger`
- [`extension/src/messages.ts`](../../../extension/src/messages.ts) — content↔background and popup↔background envelopes; new `cursor_trigger` and `rejoin_room` kinds
- [`extension/src/background/session.ts`](../../../extension/src/background/session.ts) — `SessionState`, already tracks `mode` and `playlist`; no schema change
- [`extension/src/background/protocol.ts`](../../../extension/src/background/protocol.ts) — existing `CursorChangeRequestFrame`, used as-is
- [`extension/src/popup/`](../../../extension/src/popup/) — Rejoin button + handler

## What this spec deliberately doesn't touch

- **Server (`lib/`)** — default mode already accepts a `target: VideoRefWithMeta` if it matches an existing playlist entry. No changes needed.
- **Freeform behavior** — deferred to the separate `PLAYLIST_UPDATE` spec.
- **In-page injected UI** — none. The user's own page already has the buttons; we just listen on them.
- **Adapter mode-awareness** — adapter stays mode-unaware; the background does the filtering ("Adapter always listens, background filters" choice).
- **`targetEntryId` form of the request** — not needed. Default mode accepts the videoRef form; single mode soft-leaves; freeform is deferred. The entryId path stays available for future use (e.g. a dashboard-driven flow).
