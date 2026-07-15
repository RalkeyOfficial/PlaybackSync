# Playback Notifications — Shaping Notes

## Scope

Give viewers awareness of *who* is driving shared playback. Today the sync is silent: a peer
pauses or skips and your player just jumps, with no attribution. The server already records
actor-attributed events (`RoomRuntime::pushEvent`) and streams them to the admin dashboard over
SSE, but that attribution is deliberately withheld from WS clients — peers are anonymous to each
other on the wire, and the extension injects no on-page UI at all.

This slice adds:

- a dedicated server→peer `NOTICE` frame carrying `{event, category, actor, actorId, data}` for
  play / pause / seek / cursor_change / client_joined / client_left,
- small **bottom-right stacking auto-dismiss toasts** in the extension for peer actions,
- a **centered animated welcome badge** shown to *you* the first time you join a room, and
- the client's own `nickname` added to `ROOM_STATE` so the welcome can say who you are.

## Decisions

- **Broadcast nicknames to peers.** Confirmed acceptable in shaping — fits the "small, trusted,
  self-hosted friend groups" mission. This is a deliberate, scoped relaxation of the current
  peer-anonymity design; it is called out explicitly in `docs/ws-protocol.md`.
- **Notify on all listed events** — play/pause, seek (with target time), change-video (with
  title), peer join/leave. No notices for `playlist_update`, `reset`, buffering, or clock frames.
- **Two distinct UI surfaces** (the welcome-badge refinement, added during shaping):
  - *Peer notices* → small toast, **bottom-right**, ~5s auto-dismiss, **stacking**.
  - *Your first-join welcome* → a prominent **horizontally-centered, ~25%-from-top, animated
    badge**: *"You joined the room for **\<video title\>** as **\<nickname\>**"*. Not part of the
    bottom-right stack; longer dwell.
- **Welcome is client-only** — emitted from `ws.ts` on the first `ROOM_STATE` per runtime, no
  server round-trip, fires once per join session (survives reconnects via a `welcomeShown` latch).
- **Dedicated `NOTICE` frame**, decoupled from the authoritative `STATE`/`CURSOR_CHANGE` frames
  which stay minimal. Emission is centralized in one `RoomRuntime::broadcastNotice` helper
  (encoder passed in — no DI change) and called per-handler so the *which-events-notify* set and
  actor-exclusion stay explicit and correct.
- **Actor exclusion server-side** — the actor never sees a `NOTICE` for their own action
  (`activeConnectionsExcept($ctx->clientId)`); they still get the authoritative `STATE` echo.
- **Popup shows your nickname (added mid-build).** The same `ROOM_STATE.nickname`
  feeds a persistent "You · \<nickname\>" identity chip in the toolbar popup (the
  Leave Room screen), so you can always see who you are in the room.
- **Welcome badge is a near-black pill (design iteration).** After review, the
  welcome badge became a fixed 4:1 near-black **pill** (fully-round ends) with a
  3px brand-blue (`#2563EB`) border, focused on the **nickname** (no episode
  title). Peer toasts keep the theme-adaptive bottom-right card style.
- **Vanilla TS + scoped CSS in a Shadow DOM** (WXT `createShadowRootUi`) — first-ever injected UI
  in the extension. No framework, no `@nextcloud/vue` (unusable outside the Nextcloud app runtime).
  Matches the existing toolbar-popup style (CSS custom properties + `prefers-color-scheme` dark).

## Context

- **Visuals:** None. The welcome badge and toasts are described in prose only; no mockups exist.
- **References:** see `references.md` — the server event-log envelope (`RoomRuntime`), the wire
  encoder/validator (`MessageEncoder`/`MessageValidator`), the TS protocol mirror
  (`protocol.ts`), the content↔background messaging (`messages.ts`), the WS client (`ws.ts`), the
  command dispatch path (`background.ts` / `content.ts`), and the toolbar-popup vanilla-CSS
  pattern (`entrypoints/popup/`).
- **Product alignment:** `agent-os/product/mission.md` (decentralized watch-party for small
  trusted groups) and `roadmap.md` §"Phase 2: Browser extension". This is net-new surface, not on
  the roadmap punch list, but consistent with the extension's room-joiner role.

## Standards applied

The indexed standards (`backend/php-conventions`, `tooling/build`, `frontend/vue-conventions`)
are PHP- and Vue-side. `backend/php-conventions` and `tooling/build` apply to the server + build
work; `frontend/vue-conventions` does **not** apply (the extension uses no Vue and no
`@nextcloud/vue`). Project-level rules from `CLAUDE.md` and `extension/WXT-AND-BROWSERS.md` apply
throughout. See `standards.md`.
