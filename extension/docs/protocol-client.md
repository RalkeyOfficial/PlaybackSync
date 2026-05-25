# Protocol Client

How the background speaks v2 to the PlaybackSync sync daemon. The wire format itself is owned by [`docs/ws-protocol.md`](../../docs/ws-protocol.md) at the project root — this page is about *how the client uses it*: connection lifecycle, reconnect, clock-sync, heartbeats, drift handling, feedback-loop suppression.

The code is in `src/background/`:

- [`protocol.ts`](../src/background/protocol.ts) — TS types + `encode` / `decode` for every v2 frame.
- [`session.ts`](../src/background/session.ts) — pure state container + frame folders + suppression + clock math.
- [`ws.ts`](../src/background/ws.ts) — the only place `new WebSocket(...)` happens. Drives timers, dispatches frames.
- [`storage.ts`](../src/background/storage.ts) — `chrome.storage.local` wrapper for `syncUrl` / `syncPassword` / `clientId`.
- [`tabs.ts`](../src/background/tabs.ts) — per-tab status cache that feeds heartbeats.

## Connection lifecycle

```
background boot
   │
   ▼
loadCreds()  ──── null ───▶ idle (log a hint, stay idle until reload)
   │
   ▼ creds
new WebSocket(creds.syncUrl)
   │
   ▼ open
send JOIN { password, clientId?, lastEventId?, currentlyShowing?, catalogFragment? }
   │
   ▼ ROOM_STATE
saveClientId(frame.clientId)    ← persists for next reconnect
apply room state + fan out cursor/seek/play-pause commands to active tab
   │
   ▼
start heartbeat timer (5 s)
schedule initial CLOCK_PING burst (4 pings, 250 ms apart)
start periodic CLOCK_PING timer (30 s)
   │
   ▼
running ──► message ──► decode ──► session.apply* ──► dispatchCommand(...)
```

The whole flow is at most a handful of synchronous steps per frame. Nothing buffers, nothing batches — frames are translated and dispatched as they arrive.

## JOIN handshake

The **first** JOIN on a runtime is deferred up to `FIRST_JOIN_DEFERRAL_MS` (3 s) so the content script has a chance to report identity and the result of `Adapter.scrapeCatalog()`. JOIN flushes when both signals arrive, or when the deadline elapses — whichever happens first. The daemon's `JOIN_TIMEOUT` is 5 s (`docs/ws-protocol.md`), so the deferral fits comfortably inside it.

**Reconnect JOINs** skip the deferral entirely: the runtime tracks `firstJoinSent` per-tab, so subsequent reconnects emit a bare JOIN immediately on `open`. The server has already merged `catalogFragment` into the room's playlist on the first JOIN and replayed `currentlyShowing` against the cursor; replaying either on reconnect would be best-effort idempotent at best, and noise at worst.

Optional fields, in order of how the daemon treats them:

- **`clientId`** — included whenever we have one from a prior `ROOM_STATE`. If the prior connection's tombstone is still warm (≤ 30 s old, server-configurable), the daemon resumes the session and replays missed events in `ROOM_STATE.recentEvents`.
- **`lastEventId`** — the highest `eventId` we've folded into the session. Tells the daemon where to start the replay.
- **`currentlyShowing`** — first JOIN only. Built by the background from the active adapter's `ContentIdentity` plus the entrypoint-captured `location.href` (the wire format needs a full URL; `ContentIdentity.normalizedUrl` is hostname-stripped). Empty rooms seed their cursor from it; mismatched joiners get unicast `CURSOR_CHANGE` steering.
- **`catalogFragment`** — first JOIN only. Sourced from `Adapter.scrapeCatalog()`. Omitted entirely when the adapter has no method, returns `null`, throws, or times out (`SCRAPE_CATALOG_TIMEOUT_MS = 2 s` in `runtime.ts`). See [`adapter-contract.md` §Catalog reporting](adapter-contract.md#catalog-reporting-scrapecatalog).

## Reconnect strategy

Exponential backoff with a hard cap: `1 s, 2 s, 4 s, 8 s, 16 s, 30 s`. After six failures the client gives up — typically that means the daemon is genuinely down or unreachable.

Importantly the cap is **inside the 30 s tombstone window**, so any reconnect that succeeds carries the same `clientId` + `lastEventId` and gets a clean replay.

Close reasons that *stop* the reconnect loop (the daemon already told us "don't bother retrying"):

| Code | Meaning |
|------|---------|
| `ROOM_NOT_FOUND` | UUID in the URL doesn't match a room |
| `ROOM_EXPIRED` | Room past its TTL |
| `ROOM_DELETED` | Room was deleted by its owner |
| `AUTH_FAILED` | Wrong password |
| `KICKED` | Owner kicked this client |
| `CLIENT_ID_IN_USE` | Another live connection holds our clientId |

Everything else (network glitch, idle close, daemon restart) is treated as transient.

## Heartbeat

Every 5 s, the WS module pulls the most recent `VideoState` from `tabs.ts::pickActiveTab()` and sends:

```json
{ "type": "HEARTBEAT", "currentPos": 42.7, "playerState": "playing" }
```

If no tab has reported status yet (e.g. extension just loaded and no content script has fired a `status` message), the tick is skipped. The daemon uses heartbeats both as a liveness signal and as drift input — see the next section.

## Clock sync

NTP-style ping/pong using the math from `docs/ws-protocol.md`:

```
RTT     = (t4 - t1) - (t3 - t2)
offset  = ((t2 - t1) + (t3 - t4)) / 2
```

- `t1` = client send time (`performance.timeOrigin + performance.now()`)
- `t2` = `serverRecvTime` from `CLOCK_PONG`
- `t3` = `serverSendTime` from `CLOCK_PONG`
- `t4` = client receive time (when we got the pong)

The session keeps the offset as a moving average (`alpha = 0.4`) after the first sample, so a single noisy pong doesn't whip the estimate around. The first sample sets the offset outright — we converge fast and then smooth.

**Cadence:** 4 pings spaced ~250 ms on connect (the initial burst that gives us a usable offset within a second), then one ping every 30 s.

## Drift handling

The client doesn't decide when to drift-correct — the daemon does. When the server compares our `HEARTBEAT.currentPos` against its extrapolated authoritative position and the delta crosses the threshold, it sends `SYNC_ADJUST`:

| `mode` | When | What we do |
|--------|------|------------|
| `nudge-rate` | 200–500 ms drift | Clamp `<video>.playbackRate` to ±5 % toward the drift direction for up to 3 s; the runtime drives the timer and restores `1.0`. |
| `seek` | ≥ 500 ms drift | Hard seek to `targetPos`. |

Rate math + restore timer live in [`src/adapters/runtime.ts`](../src/adapters/runtime.ts); adapters expose a thin `setPlaybackRate(rate)` primitive ([`src/adapters/types.ts`](../src/adapters/types.ts)) and never schedule their own timer. A competing `play` / `pause` / `seek` mid-nudge cancels the timer and restores baseline before the new command lands.

For the `seek` case the resulting native `seeking` event in the adapter would normally loop back as a fresh intent — suppression stops that. The `nudge-rate` case fires `ratechange`, which no adapter listens to, so no suppression slot is needed there.

## Feedback-loop suppression

Three gates sit in front of `sendEvent`, each killing a different class of phantom intent. They share a cause — native video-element events that aren't real user actions — but fire at different points in the connection's life.

### 1. Per-command echo window (600 ms)

The daemon **broadcasts STATE to every connection including the sender** (see [`lib/WebSocket/Handler/EventHandler.php`](../../lib/WebSocket/Handler/EventHandler.php)). This is the *correct* thing to do for state convergence, but it means every time we send an `EVENT play`, the daemon hands us back a `STATE { playerState: 'playing' }` that we then apply — which fires `<video>.play()` — which fires the `play` native event — which the adapter sees and emits as a fresh local intent.

To stop the echo:

1. The entrypoint calls `session.recordCommand(tabId, cmd)` immediately before `chrome.tabs.sendMessage` ships the command.
2. The next intent of the matching type arriving within 600 ms is dropped silently (`shouldSuppress`).

600 ms covers the round-trip + browser event-fire delay. The window is short enough that real user actions don't get eaten — a person can't physically click play, then click pause, in under 600 ms with intent.

`nudge_rate` commands arm no suppression slot — they don't produce a `seeking` event, only a `ratechange` event, and no adapter listens to that.

### 2. Pre-convergence drop

A tab joining a room hasn't yet been told the room's authoritative state. During adapter init the page may still fire its own native events — a Vidstack auto-play, a resume-position seek — that look like intents but aren't. Forwarding them as wire `EVENT`s clobbers the room's playback state for everyone.

The session tracks `convergedTabs: Set<number>` — tabs that have received at least one authoritative command on the current connection. Until a tab is in that set, `hasConverged` returns false and the entrypoint drops the intent (logged as `dropping pre-convergence intent`).

A tab transitions to converged via `markConverged(session, tabId)`, called from `dispatchAll` after `pickActiveTab` succeeds. If no tab has reported status when the first `ROOM_STATE` / `STATE` / `SYNC_ADJUST` arrives, `dispatchAll` stashes the commands in `session.pendingConvergence` instead of dropping them; the `status` handler then calls `flushPendingConvergence`, which dispatches the latest stashed commands to whichever tab `pickActiveTab` now picks and marks it converged. Newer frames overwrite older ones — we always converge to the freshest authoritative state.

### 3. Post-convergence settle window (5 s)

The page's auto-resume logic can also fire *after* the adapter has applied the room's first command — sometimes a second or two later, well outside the 600 ms echo window. `JOIN_SETTLE_WINDOW_MS` (5000 ms) is armed exactly once per tab per connection by `markConverged`; `inSettleWindow` drops any intent from that tab while `Date.now() < settleUntil` (logged as `dropping settle-window intent`). The "first convergence only" rule is deliberate — re-arming on every STATE-driven re-dispatch would keep re-locking the user out of their own intents mid-session.

### Reset on (re)connection

`resetConvergence(session)` clears `convergedTabs`, `pendingConvergence`, and `settleUntilByTab` on every WS `openSocket` and on `leave_room`. A cached tab from a previous connection has to be re-converged by the fresh `ROOM_STATE` before its intents are allowed to flow. The convergence and settle entries for a tab are also dropped on `chrome.tabs.onRemoved` and on adapter `fail`.

## Buffer transitions

The content runtime polls `adapter.getState()` every 1 s and pushes a `status` message. The background entrypoint compares the new `playerState` against the last value it saw for that tab; on a flip into `'buffering'` it sends `BUFFER_START` (with `videoPos`), and on a flip out it sends `BUFFER_END`. The daemon suppresses drift correction for that client while it's buffering and re-sends `ROOM_STATE` after `BUFFER_END`.

## Error frames

`ERROR` frames carry a `code` + `message`. Anything in `TERMINAL_ERROR_CODES` is treated as fatal (calls `onTerminal` and gives up reconnects); everything else is logged and ignored — the daemon doesn't close the connection for recoverable errors, and we don't need to either.

## What's deliberately not implemented yet

- **`CURSOR_CHANGE_REQUEST` from the extension** — the encoder type is in `protocol.ts` but no caller fires it. Needs UI to trigger.
- **`PLAYLIST_UPDATE` from the extension** — same; encoder ready, no scraping path beyond the first-JOIN `catalogFragment`.
