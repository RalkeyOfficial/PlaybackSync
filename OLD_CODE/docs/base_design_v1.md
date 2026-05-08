# PlaybackSync – Base Technical Design (v1)

## 1. Purpose & Scope

PlaybackSync is a browser-extension-based watch-party system that synchronizes HTML5 video playback across multiple devices. Synchronization is mediated exclusively through a backend server (no peer-to-peer). The system is designed for small, trusted groups and prioritizes simplicity, determinism, and low operational overhead.

This document describes the **v1 technical design**. Persistence, DRM support, advanced moderation, and large-scale multi-room concurrency are explicitly out of scope.

---

## 2. High-Level Architecture

The system consists of four logical components:

1. **Browser Extension**
   - Injected into a known, supported video streaming site
   - Observes and controls a single HTML5 `<video>` element
   - Communicates only with the backend sync server

2. **Sync Backend**
   - Stateless, in-memory WebSocket server
   - Maintains authoritative room state
   - Broadcasts control events and drift corrections

3. **Dashboard (Owner-only)**
   - Used to create and revoke sync rooms
   - Displays room state and participant count

4. **Share Frontend**
   - Password-gated entry point for participants
   - Redirects users to the target streaming site with sync parameters

All components are deployed as Docker containers and fronted by a TLS-terminating reverse proxy.

---

## 3. Core Concepts

### 3.1 Room

A **room** represents a single synchronized viewing session.

Room properties:
- UUID (primary identifier)
- Password (shared secret)
- Name (optional nickname for identification)
- Expiration time (TTL ≤ 24h)
- Current playback state
- Connected clients

Rooms are ephemeral and exist only in memory. Backend restarts destroy all rooms.

### 3.2 Playback State

The authoritative playback state stored by the backend consists of:
- `playerState: 'playing' | 'paused'` (server state is always either playing or paused; buffering is client-specific)
- `videoPos: number` (seconds)
- `provider: string`
- `episode: number`
- `last_explicit_event_ts: monotonic timestamp`

Note: Server state only tracks `'playing'` or `'paused'`. The `'buffering'` state is client-specific and is only reported by clients in HEARTBEAT messages. The server does not maintain buffering state because buffering is a per-client condition (network issues, media loading, etc.) that doesn't affect the authoritative room state.

---

## 4. Synchronization Model

### 4.1 Event Classes

There are **two distinct synchronization mechanisms**:

#### A. Explicit Control Events (Authoritative)

Triggered by direct user interaction:
- play
- pause
- seek (forward or backward)
- provider change
- episode change

Properties:
- Sent immediately to the backend
- Backend updates room state immediately
- Broadcast verbatim to all connected clients
- Always override any local or periodic state

#### B. Periodic Drift Correction (Corrective Only)

Used solely to compensate for playback drift.

Properties:
- Initiated by the backend at a fixed interval (e.g. every 5 seconds)
- Backend requests current playback time from all clients
- Uses **max reported time** as a heuristic
- Applies correction only if drift ≥ 500 ms
- Disabled temporarily after explicit control events

Explicit control events always take precedence over drift correction.

---

## 5. Browser Extension Design

### 5.1 Extension Components

#### Content Script

Runs in the context of the target streaming site.

Responsibilities:
- Locate the HTML5 `<video>` element
- Attach listeners for:
  - `play`
  - `pause`
  - `seeked`
- Apply remote control commands to the player
- Detect URL changes for provider / episode updates

The content script does **not** communicate directly with the backend.

#### Background Script (Service Worker)

Acts as the extension’s control plane.

Responsibilities:
- Manage WebSocket connection lifecycle
- Store sync URL + password (with TTL ≤ 24h)
- Send outgoing events to backend
- Receive incoming commands and forward them to content scripts
- Handle reconnection and retry logic
- Suppress feedback loops

Only one WebSocket connection exists per browser profile, regardless of tab count.

---

### 5.2 Feedback Loop Suppression

To prevent oscillation:

- When a remote command is applied, the extension enters a **suppression window** (e.g. 500–1000 ms)
- Local player events triggered during this window are ignored and not sent upstream

This is implemented using a simple boolean flag or timestamp comparison.

---

### 5.3 URL & Episode Detection

The target site encodes both **show identity** and episode information in the URL. In addition to episode detection, the extension must track which *show* a room is bound to.

Detection strategy:
- Monkey-patch `history.pushState` and `history.replaceState`
- Listen to `popstate`
- Fallback to periodic URL polling (≈1s)

On detecting a URL change:
- Parse **show identifier**, provider, and episode from the URL
- If the show identifier differs from the room’s stored show:
  - Suspend synchronization
  - Do not send or apply sync events
- If the show identifier matches:
  - Resume normal synchronization
  - Emit `EPISODE_CHANGE` if episode/provider changed

The backend stores the canonical show identifier for the room on first join and includes it in all subsequent state broadcasts. Clients must validate show identity before applying any remote commands.

DOM inspection is not required.

---

## 6. Backend Sync Server

### 6.1 Technology

- WebSocket-based server
- Node.js or Python (FastAPI + WebSockets)
- Single-threaded event loop
- No database

### 6.2 In-Memory Data Model

```
rooms = {
  room_id: {
    password,
    state: {
      paused,
      time,
      provider,
      episode,
      last_explicit_event_ts
    },
    clients: Set<connection>,
    expires_at
  }
}
```

### 6.3 Room Lifecycle

- Created via dashboard
- Expires automatically via TTL or manual revoke
- Destroyed on backend restart

### 6.4 Connection Lifecycle

1. Client opens WebSocket
2. Client sends `JOIN { room_id, password }`
3. Server validates credentials
4. Client added to room
5. Server sends current authoritative `STATE`

On disconnect:
- Client removed from room
- Room persists until TTL or revoke

---

## 7. WebSocket Protocol

### 7.1 Client → Server Messages

```
JOIN { room_id, password }

EVENT {
  type: play | pause | seek,
  value?: number,
  client_ts
}

EPISODE_CHANGE {
  provider,
  episode,
  url,
  client_ts
}

TIME_REPORT {
  current_time,
  client_ts
}
```

### 7.2 Server → Client Messages

```
STATE {
  paused,
  time,
  provider,
  episode,
  server_ts
}

COMMAND {
  type: play | pause | seek,
  value?
}
```

All timestamps are monotonic and used only for ordering, not wall-clock sync.

---

## 8. Drift Correction Algorithm

1. Every N seconds, server requests `TIME_REPORT`
2. Server ignores reports if:
   - `now - last_explicit_event_ts < COOLDOWN_WINDOW`
3. Compute `max_time` across clients
4. If `|max_time - state.videoPos| ≥ 0.5s`:
   - Update room state
   - Broadcast `STATE`

Clients receiving `STATE`:
- If drift ≥ 500 ms → hard seek
- Apply pause/play if mismatched

No playbackRate nudging is used.

---

## 9. Dashboard & Share Flow

### 9.1 Dashboard

Owner-only interface.

Features (v1):
- Create room
- Revoke room
- View participant count
- View current playback state

No live playback control in v1.

### 9.2 Share Flow

1. Owner creates room in dashboard
2. Server generates share URL: `/UUID`
3. Participant opens share URL
4. Password prompt
5. On success, redirect to target streaming URL with:
```
?sync_url=wss://playbacksync.mydomain.tld/UUID
&sync_password=<password>
```

6. Extension detects parameters, stores them, and strips them from URL
7. Extension connects to sync backend

---

## 10. Security Model

- All traffic over TLS
- Password required to join room
- Password never logged
- No user identity tracking
- No token exchange (by design)

Threat model assumes small, trusted groups.

---

## 11. Non-Goals (v1)

- DRM / EME support
- Persistent rooms
- User accounts
- Ownership transfer
- Moderation / control locking
- Large-scale concurrency

---

## 12. Future Extensions (Out of Scope)

- PlaybackRate-based drift correction
- Dashboard live controls
- Token-based auth
- Persistent room recovery
- Provider-agnostic adapters

