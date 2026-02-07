# Client–Server Sync Diagram & Event Handling

This document contains a connection diagram, event flows, priorities, and explicit handling rules for a single-server, WebSocket-based video sync system. It assumes a browser extension on the client implements the player control and local playback adjustments.

Throughout the doc each section explains: **what** the component/event is, **how** it should work in practice, and **why** the approach is chosen. All numeric values are expressed as labeled configuration parameters (with an example value included where helpful). Replace example values with your own measurements during testing.

---

## 1) High-level ASCII diagram (single server)

```
Client A                        Server                         Client B
  |-- WebSocket CONNECT ------->|                              |
  |                             |                              |
  |-- JOIN(roomId,userId) --->  |                              |
  |                             |                              |
  |<-- JOIN_ACK(state) -------  |                              |
  |                             |                              |
  |-- CLOCK_PING (t1) ------->  |                              |
  |<-- CLOCK_PONG (t2) ------   |                              |
  |  (compute offset)           |                              |
  |                             |                              |
  |-- EVENT(play) ------------>  |                              |
  |                             |-- BROADCAST(STATE) -------->  |
  |                             |                              |
  |<-- STATE ------------------ |                              |
  |  (apply immediately)        |                              |
```

What: minimal diagram for single-server architecture.
How: persistent WebSocket connection from each client to the server; join a room; perform clock sync on join; send EVENT messages for play/pause/seek; server rebroadcasts authoritative STATE messages.
Why: single server simplifies conflict resolution and ordering; persistent connection reduces latency and provides ordered, low-latency delivery.

Notes: all messages are JSON over WSS. `serverTime` uses epoch ms. The diagram intentionally omits load balancers or pub/sub as they are not being used in the final product.

---

## 2) Message types (canonical shapes)

All messages contain: `{ type, roomId, eventId, sourceClientId, seq }` unless noted.

For each message below I list: **what** the message represents, **how** clients/servers should construct/interpret it, and **why** this shape is chosen.

Control events (highest priority):

- `EVENT` (client → server)
  - What: client sends explicit control events (play, pause, seek) to the server.
  - How: `{ type: "EVENT", event: "play" | "pause" | "seek", value?: number, client_ts: number }` where `event` indicates the action, `value` is required for seek events (target position in seconds), and `client_ts` is the client timestamp when the action occurred.
  - Why: unified message format simplifies protocol while maintaining all necessary control actions. Server processes events and broadcasts authoritative state.

- `STATE` (server → clients, broadcast)
  - What: authoritative playback state broadcast from server to all clients.
  - How: `{ type: "STATE", playerState: "playing" | "paused", videoPos: number, server_ts: number, eventId: number, provider?: string, episode?: number }` where `videoPos` is the authoritative playback position, `server_ts` is the server timestamp, and `eventId` provides ordering.
  - Why: single message type for all state changes simplifies client handling. Clients apply the state immediately when received. The `eventId` ensures proper ordering and idempotency.

State / sync events (medium priority):

- `HEARTBEAT`
  - What: regular status update from client to server.
  - How: `{ type: "HEARTBEAT", currentPos, playerState, clockSample }`.
  - Why: allows the server to measure drift, detect buffering, and compute aggregate metrics without forcing immediate corrections.

- `SYNC_ADJUST`
  - What: server-driven corrective action.
  - How: `{ type: "SYNC_ADJUST", serverTime, targetPos, mode }` where `mode` ∈ {`nudge-rate`, `seek`}.
  - Why: provides a structured instruction set for small or large corrections.

- `CLOCK_PING` / `CLOCK_PONG`
  - What: offset measurement packets (NTP-style).
  - How: include clientSendTime, serverRecvTime, serverSendTime, clientRecvTime.
  - Why: needed to calculate per-client clock offset and RTT.

Health / buffering (high-medium priority):

- `BUFFER_START`, `BUFFER_END`
  - What: client signals that it has started or finished rebuffering.
  - How: `{ type: "BUFFER_START", videoPos }` and `{ type: "BUFFER_END", videoPos }`.
  - Why: server uses these to avoid waiting indefinitely for stuck clients and to decide whether to instruct catch-up behaviour or pause the room.

Control acknowledgements (important):

- `ACK` / `NACK`
  - What: clients acknowledge receipt and application of critical control events.
  - How: `{ type:"ACK", eventId }`.
  - Why: server can detect missing clients or stalled connections and take alternate action after `ACK_TIMEOUT`.

Administrative (low priority):

- `ROOM_STATE`
  - What: full authoritative state returned on join or reconnect.
  - How: includes `{ videoPos, playerState, lastEventId, serverTime }`.
  - Why: lets new or reconnected clients immediately converge to the canonical timeline.

---

## 3) Priority table and handling semantics

What: ordered priority list and handling rules.
How: the server enqueues incoming requests and applies rules below to process them.
Why: prioritization reduces user-visible inconsistencies and avoids blocking the room for a single problematic client.

1. **Highest — Control events**: `EVENT` (client → server) and `STATE` (server → clients).
   - How: Server processes `EVENT` messages and broadcasts `STATE` with `eventId` ordering. Clients send `ACK` for `STATE` messages. If `ACK` not received within `ACK_TIMEOUT`, mark client `lagging` but proceed for others.
   - Why: user-visible controls determine the session’s perceived correctness and responsiveness.

2. **High — Buffering notifications**: `BUFFER_START`/`BUFFER_END`.
   - How: immediate state change on server for that client; used to alter subsequent scheduling or flag for catch-up.
   - Why: buffer events indicate media-plane failure (not network), which needs different handling than missing ACKs.

3. **Medium — Heartbeats and sync**: `HEARTBEAT`, `SYNC_ADJUST`.
   - How: used for non-urgent corrections (nudge or seek decisions).
   - Why: avoid constantly interrupting playback while still converging over time.

4. **Low — Telemetry and admin**: `ROOM_STATE` dumps, logs.
   - How: asynchronous.
   - Why: diagnostic and recovery data.

Design rationale: keep authoritative timeline responsive while avoiding oscillatory corrections from chasing minute differences.

---

## 4) Event handling flow (server and client) — step by step

This section expands each flow with direct what/how/why reasoning.

### On client connect / join

What: client joins a room and must align to canonical time.
How (step-by-step):

1. Client connects WSS and sends `JOIN(roomId,userId)`.
2. Server replies `ROOM_STATE { videoPos, playerState, lastEventId, serverTime }`.
3. Client performs `CLOCK_SYNC` (3–5 ping/pong exchanges) to compute `offset = serverTime - clientTime` and RTT.
4. Client compares local `currentTime` to `videoPos` from server. If `|delta| > JOIN_SEEK_THRESHOLD` then client seeks to server `videoPos` and does not auto-play until further instruction.

Why: joining clients commonly have arbitrary local state; immediate clock sync plus a seek threshold ensures that they do not silently diverge or cause surprise jumps when the next control event is applied. Doing a small number of ping/pong exchanges balances accuracy with connect latency.

### On EVENT (client sends play/pause/seek)

What: a user wishes to control playback for the group (play, pause, or seek).
How:

1. Client sends `EVENT { event: "play" | "pause" | "seek", value?: number, client_ts: number }` where `value` is required for seek events (target position in seconds).
2. Server validates the event and calculates authoritative `videoPos` (may accept client value or re-sample for seek events).
3. Server updates room state and immediately broadcasts `STATE { playerState, videoPos, server_ts, eventId }` to all clients.
4. Clients apply the state immediately when received. Each client replies `ACK(eventId)`.
5. Server waits up to `ACK_TIMEOUT_MS` for ACKs, flags missing clients as `lagging`, and logs.

Why: immediate broadcast ensures responsive user experience for the initiating client. When a user clicks play, the native video player starts immediately and cannot be delayed by JavaScript. Small initial desynchronization between clients (typically < 250ms due to RTT differences) is acceptable and corrected automatically by drift reconciliation (`SYNC_ADJUST` messages) within seconds. ACKs give the server visibility into who applied the command.

Edge cases and specifics:

- If a client experiences `BUFFER_START` during playback, the client should immediately notify server with `BUFFER_START`.
- The server's policy (default) is not to pause the entire room for a single buffer; instead, it flags the client and later issues a targeted `SYNC_ADJUST`.

### Event Types

**Play Event:**
- Client sends `EVENT { event: "play", client_ts }`
- Server updates `playerState = "playing"` and broadcasts `STATE` message
- Clients apply play immediately when received

**Pause Event:**
- Client sends `EVENT { event: "pause", client_ts }`
- Server updates `playerState = "paused"` and calculates authoritative `videoPos` based on expected time
- Server broadcasts `STATE` message with paused state
- Clients apply pause immediately and send `ACK`

Why: pauses are typically user-triggered synchronous events that participants expect to happen immediately.

**Seek Event:**
- Client sends `EVENT { event: "seek", value: targetPos, client_ts }`
- Server validates target position (e.g., clamp within video duration) and updates `videoPos`
- Server broadcasts `STATE` message with new position
- Clients apply seek immediately: `video.pause(); video.currentTime = targetPos; send ACK(eventId)`
- Server waits for ACKs and expects a play event to resume if appropriate

Why: seeks change the canonical timeline, so immediate authoritative broadcasting avoids divergent histories.

### On BUFFER_START / BUFFER_END

What: a client signals that media playback stalled (buffering) and when it resumes.
How:

- `BUFFER_START` sent immediately when playback stalls.
- `BUFFER_END` sent once the media has enough buffered content to resume smoothly (report `currentPos`).

Server behaviour:

- **continue** for the majority. Server marks the client `lagging` and optionally sends `SYNC_ADJUST` when client reports `BUFFER_END`.

Why: Improves overall experience for the majority and avoids repeatedly interrupting many users for one bad connection.

---

## 5) Resynchronization strategy and thresholds

What: how to keep drift below a perceptual threshold.
How: provide three correction methods and cadences, with labeled parameters.
Why: to minimize visible jumps and maintain perceived simultaneity.

Correction actions (labels and example usage):

- `NUDGE_THRESHOLD_MS` (example: 50–300 ms)
  - What: threshold under which a gentle correction is preferred.
  - How: temporarily adjust `video.playbackRate` by a small multiplier for a short period (e.g., `1.02` or `0.98`) until the gap closes.
  - Why: smooth audible and visual experience, avoids abrupt seeks for tiny skew.

- `SEEK_THRESHOLD_MS` (example: 500 ms)
  - What: threshold above which a hard seek is preferable.
  - How: client sets `video.currentTime = targetPos` immediately (optionally pause briefly to avoid decoding artifacts), then await `PLAY`.
  - Why: big gaps degrade the group experience and occasional jumps are better than prolonged desynchronization.

- `JOIN_SEEK_THRESHOLD_MS` (example: 500 ms)
  - What: threshold used on initial join to decide whether to seek to room state.
  - How: if joining client's `currentTime` differs from server `videoPos` by more than this, immediately seek to server `videoPos`.

- `CLOCK_SYNC_INTERVAL_S` (example: 30–60s)
  - What: how often to re-run clock sync samples.
  - How: on join run 3–5 exchanges, then again every `CLOCK_SYNC_INTERVAL_S` or after major RTT changes.
  - Why: clocks drift and network conditions change; periodic resync keeps offsets accurate.

- `HEARTBEAT_INTERVAL_S` (example: 5s)
  - What: client heartbeat frequency for position reporting.
  - How: clients send `HEARTBEAT` every `HEARTBEAT_INTERVAL_S` including `currentPos` and `playerState`.
  - Why: server uses these to detect drift and buffering without overwhelming the network.

- `ACK_TIMEOUT_MS` (example: 2500 ms)
  - What: how long server waits for ACKs on critical events.
  - How: after broadcasting a control event, server waits up to `ACK_TIMEOUT_MS`. Missing ACKs mark the client lagging.
  - Why: gives slower clients a fair chance to respond while keeping the room responsive.

Adaptive behaviour:

- Make thresholds dynamic where possible. For example, adjust drift thresholds based on measured RTT distribution and observed drift patterns to adapt to the current cohort’s latency profile.

---

## 6) Ordering, idempotency, and conflict resolution

What: rules to ensure consistent application of events across clients.
How:

- Server attaches monotonically increasing `eventId` to authoritative broadcasts.
- Clients apply events in `eventId` order and buffer out-of-order messages for a short `EVENT_REORDER_WINDOW_MS` (example: 200ms).
- Event handlers are idempotent (ignoring duplicate `eventId`).
- Conflicting requests: server serializes by arrival. Optionally designate a `HOST` role that has higher priority.
  Why: ordering prevents inconsistent timelines and idempotency avoids double application in case of retries.

---

## 7) Reconnect and recovery

What: how a reconnecting client catches up.
How:

1. Re-establish WSS and `JOIN` the room.
2. Immediately run `CLOCK_SYNC` to recompute offset.
3. Request `ROOM_STATE`; server returns `{ videoPos, playerState, lastEventId }` and any `recentEvents[]` since `lastEventId`.
4. If `|localPos - videoPos| > JOIN_SEEK_THRESHOLD_MS`, client seeks to `videoPos` and sets `playerState` accordingly.
5. If events need replay, server streams them in `eventId` order; client ACKs each.
   Why: ensures consistent recovery and avoids inconsistent application of stale events.

---

## 8) Timeouts, retries and metrics

What: operational parameters to detect problems and measure health.
How:

- `ACK_TIMEOUT_MS`: default 2500 ms. Retransmit up to 2 times for critical broadcasts; do not retry indefinitely.
- `JOIN_TIMEOUT_MS`: default 3000 ms.
- Metrics collected: RTT distribution, percent of clients lagging beyond `SEEK_THRESHOLD_MS`, ACK success rate, average drift.
  Why: operational health is essential to tuning thresholds and for diagnosing regions where the defaults are insufficient.

---

## 9) Example JSON sequences (with labeled parameters)

Play flow (client -> server -> clients)

1. Client A -> Server: `{ type:"EVENT", event:"play", client_ts: 167XXXX }`
2. Server -> all: `{ type:"STATE", playerState:"playing", videoPos: 123.45, server_ts: now_server, eventId: 42 }`
3. Client A starts playing immediately (native player cannot be delayed).
4. Client B receives -> applies `play()` immediately -> sends `{ type:"ACK", eventId:42 }`
5. Any initial desynchronization (< 250ms typically) is corrected by drift reconciliation within seconds.

Resync flow (server detects drift)

1. Server -> client C: `{ type:"SYNC_ADJUST", mode:"nudge-rate", serverTime: now, targetPos: 130.32 }`
2. Client C briefly increases `playbackRate` until `currentTime` ≈ `targetPos` then restores normal rate.

---

## 10) Summary of recommended labeled parameters (examples)

- `HEARTBEAT_INTERVAL_S` = 5 (example)
- `CLOCK_SYNC_EXCHANGES` = 3 on join, re-run every `CLOCK_SYNC_INTERVAL_S` = 30–60 (example)
- `ACK_TIMEOUT_MS` = 2500 (example)
- `JOIN_SEEK_THRESHOLD_MS` = 500 (example)
- `NUDGE_THRESHOLD_MS` = 50–300 (example)
- `SEEK_THRESHOLD_MS` = 500 (example)
- `DRIFT_THRESHOLD_MS` = 100–200 (example) - threshold for triggering drift correction

Each of these labels should be made configurable in the server and client code. Start with the example values, run tests with representative users, and tune to your user geography and content characteristics.

---

## 11) Mermaid diagram

Github will automatically display this diagram in a visual format.
if you cannot see it visually go to https://mermaid.live/ and paste this in.

```mermaid
sequenceDiagram
    participant C as Client (initiator)
    participant S as Server (authoritative)
    participant O as Other Clients

    rect rgba(240,240,240,0.3)
    Note over C,S: JOIN + CLOCK_SYNC
    C->>S: JOIN(roomId, userId)
    S-->>C: ROOM_STATE {videoPos, playerState, serverTime}
    C->>S: CLOCK_PING (clientSendTime)
    S-->>C: CLOCK_PONG (serverRecvTime, serverSendTime)
    Note right of C: compute offset = serverTime - clientTime
    end

    rect rgba(230,255,230,0.3)
    Note over C,S: PLAY flow (immediate broadcast)
    C->>S: EVENT {event: "play", client_ts}
    Note right of S: compute authoritative videoPos\nbroadcast STATE immediately
    S-->>O: STATE {playerState: "playing", videoPos, server_ts, eventId}
    S-->>C: STATE {playerState: "playing", videoPos, server_ts, eventId}
    Note left of C: play() starts immediately\n(native player cannot be delayed)
    Note left of O: play() applied immediately\nwhen message received
    O-->>S: ACK {eventId}
    C-->>S: ACK {eventId}
    Note right of S: wait up to ACK_TIMEOUT_MS\nflag missing ACKs as lagging\nany initial drift corrected by SYNC_ADJUST
    end

    rect rgba(255,230,230,0.3)
    Note over C,S: BUFFER occurs on one client
    C-->>S: BUFFER_START {videoPos}
    Note right of S: mark client as lagging, room continues by default
    C-->>S: BUFFER_END {videoPos_after}
    alt gap <= NUDGE_THRESHOLD_MS
        S-->>C: SYNC_ADJUST {mode: nudge-rate, targetPos}
        Note right of C: temporarily adjust playbackRate
    else gap > SEEK_THRESHOLD_MS
        S-->>C: STATE {playerState, videoPos: targetPos, server_ts: now, eventId}
        C-->>S: ACK {eventId}
        Note right of C: apply hard seek
    end
    end

    rect rgba(240,240,255,0.3)
    Note over O,S: PAUSE flow (immediate)
    O->>S: EVENT {event: "pause", client_ts}
    S-->>O: STATE {playerState: "paused", videoPos, server_ts, eventId}
    S-->>C: STATE {playerState: "paused", videoPos, server_ts, eventId}
    O-->>S: ACK {eventId}
    C-->>S: ACK {eventId}
    Note right of S: pause is authoritative and immediate
    end

    rect rgba(250,250,250,0.6)
    Note over S: Configuration labels (examples only)
    Note over S: ACK_TIMEOUT_MS = configurable
    Note over S: NUDGE_THRESHOLD_MS / SEEK_THRESHOLD_MS are tunable
    Note over S: Playback events broadcast immediately\nany drift corrected by SYNC_ADJUST
    end
```
