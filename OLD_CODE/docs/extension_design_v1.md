# PlaybackSync Browser Extension – Functional & Technical Design

## 1. Purpose of the Extension

This document describes how the PlaybackSync **browser extension** should function at a practical and technical level. It is written to explain not just *what* the extension does, but *why* it is structured the way it is, and how each part cooperates with the backend to achieve deterministic video synchronization.

The extension is the client-side execution layer of the PlaybackSync system. Its job is to act as a reliable bridge between three worlds that normally do not cooperate well: the user’s direct interaction with a video player, the browser’s sandboxed extension environment, and an authoritative backend server that dictates shared playback state.

The extension does not attempt to be clever or autonomous. It does not guess intent, infer synchronization, or reconcile conflicts on its own. Instead, it observes local reality, reports it upward when appropriate, and applies server-issued commands exactly as instructed.

In plain terms: the backend decides *what should be happening*, and the extension makes sure the local video player obeys.

---

The browser extension is the **client-side execution layer** of the PlaybackSync system. Its sole responsibility is to:

- Observe and control a single HTML5 `<video>` element on supported streaming sites
- Maintain a persistent, authoritative WebSocket connection to the sync backend
- Translate local user actions into serialized sync requests
- Apply server-issued commands in a deterministic, feedback-loop-safe manner

The extension does **not**:
- Host or proxy media
- Perform peer-to-peer communication
- Infer intent from other clients
- Make autonomous synchronization decisions

All authority flows from the backend.

---

## 2. High-Level Extension Architecture

The extension is split into three cooperating components:

1. **Background Script (Service Worker)** – control plane
2. **Content Script** – video & page integration
3. **Injected Page Hooks (minimal)** – deep player access where required

Only the background script communicates with the backend. Content scripts are strictly sandboxed from the network and act as controlled executors.

---

## 3. Background Script (Service Worker)

The background script is the **brain** of the extension. It does not touch the DOM and it does not directly interact with the video element. Instead, it exists to manage long-lived state, network communication, ordering guarantees, and correctness across tabs.

Because content scripts are ephemeral and tied to individual pages, all global decisions must live in the background service worker. This includes connection management, protocol enforcement, and suppression of feedback loops.

Chrome APIs used by the background script:

- `chrome.runtime`
  - Messaging between background and content scripts
  - Lifecycle hooks (`onInstalled`, `onStartup`)

- `chrome.storage.local`
  - Persisting roomId, password, clientId, and expiry timestamp
  - Ensuring sync parameters survive tab reloads but not browser restarts beyond TTL

- `chrome.tabs`
  - Enumerating active tabs to forward commands
  - Detecting tab closure or navigation events

- `chrome.alarms`
  - Periodic tasks such as TTL expiry cleanup or clock resync triggers

- `WebSocket` (standard Web API)
  - Persistent WSS connection to the backend

---

### 3.1 Responsibilities

The background script is the authoritative local coordinator. It is responsible for:

- Managing the WebSocket lifecycle
- Joining rooms and authenticating
- Performing clock synchronization
- Serializing outbound control requests
- Receiving authoritative commands
- Enforcing ordering and idempotency
- Suppressing feedback loops
- Handling reconnects and recovery

There is **exactly one active WebSocket connection per browser profile**, regardless of how many tabs are open.

---

### 3.2 Connection Lifecycle

The background script owns the entire WebSocket lifecycle. This is critical because synchronization must survive tab reloads, SPA navigations, and temporary content script failures.

When the extension starts (or wakes from suspension), the background script checks whether valid sync parameters exist in `chrome.storage.local`. These parameters are written only when a user joins a room via a share link and are always associated with an explicit expiration timestamp.

If the parameters are valid and unexpired, the background script initiates a secure WebSocket connection to the backend. No user interaction is required at this stage; reconnects are automatic and silent.

Once connected, the script immediately performs a JOIN handshake. If the JOIN fails for any reason (invalid room, expired room, incorrect password), synchronization is disabled and the extension enters a passive failure state. Importantly, the extension does *not* attempt retries for authentication failures, only for transport failures.

This separation avoids accidental brute-force behavior and keeps error states predictable.

---

#### Startup

1. Extension starts or wakes
2. Reads stored sync parameters:
   - roomId
   - password
   - clientId
   - expiration timestamp
3. If parameters are valid and unexpired:
   - Open WebSocket connection to backend

#### Join Sequence

1. Open WSS connection
2. Send `JOIN` message
3. Await `ROOM_STATE`
4. Perform clock synchronization (PING/PONG exchange)
5. Transition to ACTIVE state

If JOIN fails, the extension disables sync and surfaces a passive error indicator.

---

### 3.3 WebSocket State Machine

Local connection states:

- DISCONNECTED
- CONNECTING
- JOINING
- SYNCING_CLOCK
- ACTIVE
- DEGRADED (connected but content mismatch or lagging)

State transitions are explicit and logged for debuggability.

---

### 3.4 Clock Synchronization

Clock sync is mandatory before applying scheduled commands.

Mechanism:
- NTP-style exchange (`CLOCK_PING` / `CLOCK_PONG`)
- 3–5 samples on join
- Median RTT selected
- Offset = serverTime − clientTime

The offset is used to schedule `play()` and `pause()` at a specific real-world instant.

Clock sync is re-run periodically or after reconnect.

---

### 3.5 Outbound Event Handling

When the content script reports a **local user action**, the background script:

1. Verifies sync is ACTIVE
2. Verifies suppression window is not active
3. Serializes the request into a protocol message:
   - `EVENT { event: "play" | "pause" | "seek", value?: number, client_ts }`
   - `EPISODE_CHANGE_REQUEST`
4. Attaches client timestamp (`client_ts`)
5. Sends to server

The background script never directly mutates playback state.

---

### 3.6 Inbound Command Handling

When the backend sends authoritative commands, the background script treats them as the single source of truth. These commands are never interpreted, modified, or merged locally.

Each inbound command includes an `eventId`. The background script keeps track of the highest applied `eventId` and discards any duplicates or out-of-order messages. This ensures idempotency and protects against reconnect-related replays.

Valid commands are forwarded to all relevant content scripts using `chrome.tabs.sendMessage`. The background script does not assume that every tab is alive or responsive; message delivery is best-effort and non-blocking.

Before forwarding any command, the background script activates a suppression window. This window is communicated to content scripts so that any DOM events triggered by applying the command do not propagate back upstream as user intent.

This mechanism is one of the most important correctness guarantees in the entire system.

---

On receiving authoritative server messages:

- Commands are ordered by `eventId`
- Duplicate or stale events are ignored
- Valid commands are forwarded to all relevant content scripts

Commands include:
- PLAY (scheduled)
- PAUSE (immediate)
- SEEK
- EPISODE_CHANGE
- SYNC_ADJUST

The background script activates a **suppression window** before forwarding commands.

---

### 3.7 Feedback Loop Suppression

To prevent oscillation:

- Any remote command activates a suppression window (e.g. 750 ms)
- Local player events occurring during this window are ignored
- Suppression is timestamp-based, not boolean, to handle overlaps

This ensures that remote seeks or plays do not echo back as local intent.

---

### 3.8 Reconnect & Recovery

On disconnect:

- Enter CONNECTING state
- Reconnect using exponential backoff
- Re-send JOIN with same clientId

On reconnect success:

- Receive ROOM_STATE
- Re-run clock sync
- Reconcile content identity
- Seek or pause if required

---

## 4. Content Script

The content script is the extension’s **hands**. It lives inside the web page, can see and manipulate the DOM, and is the only component allowed to touch the video element.

It is intentionally kept simple. The content script does not know about rooms, passwords, clocks, or other clients. Its job is to observe, report, and execute.

Chrome APIs used by the content script:

- `chrome.runtime.sendMessage`
  - Report user-initiated playback events to the background script

- `chrome.runtime.onMessage`
  - Receive authoritative playback commands

- Standard DOM APIs
  - `document.querySelector`
  - `MutationObserver`
  - `HTMLMediaElement` API

The content script never opens network connections and never stores persistent state.

---

### 4.1 Responsibilities

The content script runs in the context of the streaming site and is responsible for:

- Locating the correct `<video>` element
- Attaching event listeners
- Executing playback commands
- Reporting user actions upward
- Detecting URL / episode changes

It is deliberately dumb and reactive.

---

### 4.2 Video Element Discovery

Modern streaming sites are almost universally SPA-based and frequently replace video elements without a full page reload. Because of this, the content script cannot assume that a `<video>` element discovered once will remain valid.

On injection, the script searches for candidate `<video>` elements and selects the most likely primary playback element based on heuristics such as duration, visibility, and playback readiness. These heuristics are deliberately conservative to avoid accidentally binding to preview or ad elements.

A `MutationObserver` is attached to detect DOM changes that may invalidate the current binding. If the active video element disappears or is replaced, listeners are detached and discovery runs again.

This approach avoids provider-specific DOM scraping while remaining robust across site updates.

---

Discovery strategy:

1. Query for visible `<video>` elements
2. Filter by:
   - Not muted-only previews
   - Has duration > threshold
3. Select first stable candidate

If the video element changes (SPA reloads, episode switch):
- Detach listeners
- Re-bind to new element

---

### 4.3 Attached Video Event Listeners

Listeners include:

- `play`
- `pause`
- `seeking`
- `seeked`
- `waiting` (buffer start)
- `playing` (buffer end)

Only **user-initiated** events are forwarded. Programmatic events triggered during suppression are ignored.

---

### 4.4 Applying Playback Commands

When the content script receives a playback command from the background script, it applies it directly to the bound `HTMLMediaElement`.

**PLAY commands:** Play commands are applied immediately when received. When a user clicks play, the native video player starts immediately and cannot be delayed by JavaScript. Any initial desynchronization between clients (< 250ms typically due to RTT differences) is acceptable and quickly corrected by drift reconciliation (`SYNC_ADJUST` messages).

**PAUSE and SEEK commands:** These are applied immediately, as users expect them to take effect without delay.

All command handlers are idempotent and guarded against duplicate application using the `eventId` supplied by the background script.

---

When receiving commands from background:

- SEEK: `video.currentTime = targetPos`
- PAUSE: `video.pause()`
- PLAY:
  - Schedule `video.play()` at `(serverTime - clockOffset)`

Commands are idempotent and guarded by eventId ordering.

---

### 4.5 Drift Adjustment

For `SYNC_ADJUST`:

- If mode = `nudge-rate`:
  - Temporarily adjust `video.playbackRate`
  - Restore once delta < threshold
- If mode = `seek`:
  - Hard seek to targetPos

No autonomous drift correction is performed client-side.

---

## 5. URL, Episode, and Content Identity Handling

### 5.1 URL Change Detection

Because most providers are SPAs:

- Monkey-patch `history.pushState`
- Monkey-patch `history.replaceState`
- Listen for `popstate`
- Fallback polling (≈1s)

---

### 5.2 Derived Content Key

On URL change, the content script derives:

- providerId
- episodeId
- normalized URL fingerprint

This is hashed locally to produce a **derivedContentKey**.

The key is opaque and only used for equality comparison.

---

### 5.3 Episode Change Flow

If a user navigates to a new episode:

1. Content script detects change
2. Background script sends `EPISODE_CHANGE_REQUEST`
3. Server broadcasts authoritative `EPISODE_CHANGE`
4. Extension:
   - Pauses video
   - Seeks to 0
   - Waits for PLAY

If local derivedContentKey does not match server:
- Enter DEGRADED state
- Refuse to apply playback commands
- Surface mismatch warning

---

## 6. Handling Buffering & Media Failures

### 6.1 Buffer Reporting

On `waiting`:
- Send `BUFFER_START`

On `playing`:
- Send `BUFFER_END`

---

### 6.2 Server-Driven Recovery

The extension never pauses the room autonomously.

If instructed:
- Apply SYNC_ADJUST
- Or hard seek

Lagging clients are corrected without blocking others.

---

## 7. Storage, Permissions, and Privacy

### 7.1 Chrome Permissions

The extension requires a deliberately small and explicit permission set:

- `storage`
  - Required to persist room credentials and client identity

- `tabs`
  - Required to message active tabs and detect tab lifecycle events

- `scripting`
  - Required to inject content scripts on supported streaming sites

- `alarms`
  - Used for TTL expiry enforcement and periodic maintenance

- Host permissions (restricted)
  - Only for explicitly supported streaming domains
  - No `<all_urls>` wildcard

### 7.2 Privacy Properties

All stored data is:

- Local-only (`chrome.storage.local`)
- Ephemeral (hard TTL enforced)
- Never synced to a cloud account
- Never logged or transmitted except during JOIN

The extension does not fingerprint users, collect analytics, or observe non-video browsing behavior.

---

Stored locally:

- roomId
- password
- clientId
- expiration timestamp

Constraints:
- TTL enforced (≤ 24h)
- Cleared automatically on expiry
- Never synced to cloud
- Never logged

---

## 8. Error Handling & UX Philosophy

The extension favors **silent correctness** over UI noise.

Principles:
- Never block playback
- Never auto-navigate pages
- Surface warnings only on hard mismatch
- Fail closed (do nothing) instead of guessing

---

## 9. Non-Goals (Extension)

The extension explicitly does not:

- Attempt to bypass DRM
- Scrape provider internals
- Control ads or overlays
- Infer intent from heuristics
- Provide chat or social UI

---

## 10. Resulting Mental Model

- The backend owns time and truth
- The extension is a deterministic actuator
- The content script touches the DOM
- The background script touches the network
- All user-visible actions are serialized

This keeps the system debuggable, predictable, and robust under real-world latency and failure modes.

