# On-page notifications

Small on-page popups that tell each viewer what their watch-party peers are
doing, plus a welcome badge when you join. This is the extension's **only
injected page UI** — every other surface (popup) lives in its own document.

Two surfaces, both rendered from [`src/ui/notifications.ts`](../src/ui/notifications.ts)
inside a single WXT shadow-root so the host site's CSS can't touch them:

- **Peer toasts** — small cards in the **bottom-right**, stacked, auto-dismiss
  after ~5 s. Driven by server `NOTICE` frames ("SwiftFox42 paused").
- **Welcome badge** — a fixed 4:1, near-black **pill** (fully-round ends) with
  a 3px brand-blue (`#2563EB`) border, **centered** (≈25 % from top) and
  animated, shown **once** when you join. It focuses on *your* nickname
  ("You joined as **SwiftFox42**") — no episode title. Synthesised client-side;
  never sent over the wire.

## End-to-end flow

```
peer acts        daemon                         you
(pause) ───────► EventHandler                    │
                 broadcastNotice(exclude actor)  │
                 └── NOTICE{event:pause,          │
                           actorId:"SwiftFox42"} ─┼─► ws.ts handleFrame
                                                  │     └─ cb.dispatchNotice(notice)
                                                  │        └─ background.ts dispatchNotice
                                                  │           └─ tabs.sendMessage {kind:'notice'}
                                                  │              └─ content.ts onMessage
                                                  │                 └─ showNotice(notice)
                                                  │                    └─ toast in shadow-root
```

The self **welcome** skips the wire entirely: on the first `ROOM_STATE` per
join session, [`ws.ts`](../src/background/ws.ts) latches `welcomeShown` and
emits a local `dispatchNotice({ event: 'welcome', … })` built from
`ROOM_STATE.nickname` (your own nickname). It fires once per join, not on
every reconnect `ROOM_STATE`.

## The `Notice` message

Defined in [`src/messages.ts`](../src/messages.ts) as the `{ kind: 'notice' }`
arm of `BackgroundToContent`:

| field | meaning |
|-------|---------|
| `event` | `play` / `pause` / `seek` / `cursor_change` / `client_joined` / `client_left`, or the client-only `welcome`. |
| `actor` | `client` / `owner` / `system` — drives the display name. |
| `actorId` | actor nickname, owner userId, or (for `welcome`) your own nickname. |
| `data` | event-specific: `value` (seek seconds), `videoRef.label` (new video), `nickname` (leaver), `reason`. The `welcome` needs no `data` — just `actorId`. |

Peer notices originate from the daemon's `NOTICE` frame — see
[`ws-protocol.md` §NOTICE](../../docs/ws-protocol.md) and its TS mirror in
[`protocol.ts`](../src/background/protocol.ts). The actor is excluded
server-side, so **you never get a toast about your own action**.

## Copy

Plain English (the extension has no i18n framework — same posture as the
popup). Display name is `Host` for `owner`, the leaver's `data.nickname` for a
`system` `client_left`, otherwise the actor nickname.

| event | text |
|-------|------|
| `play` | `<name> played` |
| `pause` | `<name> paused` |
| `seek` | `<name> skipped to <m:ss>` (or `h:mm:ss` past an hour) |
| `cursor_change` | `<name> changed the video to <label>` (`a new video` if unlabelled) |
| `client_joined` | `<name> joined` |
| `client_left` | `<name> left` |
| `welcome` | `You joined as <nickname>` (degrades to `You joined the watch party` when the nickname is missing) |

The welcome text is built from text nodes (never `innerHTML`), so a hostile
video label or nickname can't inject markup.

## Rendering details

- **Shadow-root, lazy mount.** `createShadowRootUi(ctx, { position: 'inline',
  anchor: 'body', css })` mounts on the *first* notice only — pages that never
  sync pay nothing. Styles are scoped with `:host { all: initial }` + tokens
  and a `prefers-color-scheme` dark override mirroring the popup.
- **Stacking + cap.** Newest toast at the bottom; at most `MAX_TOASTS` (4)
  visible, oldest evicted first.
- **Seek coalescing.** A burst of seeks from the same actor updates one toast
  (and resets its timer) instead of flooding the stack.
- **Overlay safety.** Both layers are `position: fixed` with max `z-index` and
  `pointer-events: none` (toasts re-enable it), so they float over a fullscreen
  player without eating clicks meant for the page.
- **Teardown.** `ctx.onInvalidated` clears all timers and drops element refs on
  a dev reload / SPA context swap, so nothing fires after the context dies.

## Not notified

`playlist_update`, `reset`, buffering, and clock frames deliberately emit no
notice — they aren't user-legible actions. There is no notification history,
settings, mute, or sound in this slice.
