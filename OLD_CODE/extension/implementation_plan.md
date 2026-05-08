# PlaybackSync Extension Implementation Plan

This document provides a step-by-step implementation plan for building the PlaybackSync browser extension. The plan starts with simple but large foundational steps and gradually progresses to complex but small implementation details.

**Goal**: Maintain constant focus on what to do next, with clear milestones and dependencies.

---

## Phase 1: Foundation & Setup (Simple, Large Steps)

### Step 1.1: Create Base Project Structure
**Goal**: Establish the foundational folder structure and build configuration.

**Tasks**:
- [ ] Create folder structure:
  ```
  extension/
  ├── src/
  │   ├── background/
  │   │   └── core/
  │   ├── content/
  │   │   ├── adapters/
  │   │   │   ├── _template/
  │   │   │   └── miruro/
  │   │   └── adapter-runtime.ts
  │   └── injected/
  ├── public/
  │   └── icons/
  ├── schemas/
  └── dist/
  ```
- [ ] Configure TypeScript with separate compilation targets for background/content/injected
- [ ] Set up build scripts in `package.json` to compile all entry points
- [ ] Add basic ESLint configuration for extension code
- [ ] Create `.gitignore` entries for `dist/` and build artifacts

**Deliverable**: Project structure ready, TypeScript compiles successfully, build scripts work.

**Estimated Complexity**: Low  
**Estimated Time**: 1-2 hours

---

### Step 1.2: Create Manifest.json with Required Permissions
**Goal**: Define extension manifest with minimal required permissions.

**Tasks**:
- [ ] Create `manifest.json` with Manifest V3 structure
- [ ] Add required permissions:
  - `storage` (for room credentials)
  - `tabs` (for messaging and tab lifecycle)
  - `scripting` (for content script injection)
  - `alarms` (for TTL expiry)
- [ ] Add host permissions for initial supported sites (e.g., `miruro.tv`, `miruro.to`)
- [ ] Configure background service worker entry point
- [ ] Configure content script injection rules (match patterns for supported sites)
- [ ] Add extension icons (placeholder icons acceptable)
- [ ] Set extension name, version, description

**Deliverable**: Valid `manifest.json` that loads in Chrome without permission warnings.

**Estimated Complexity**: Low  
**Estimated Time**: 30 minutes

---

### Step 1.3: Implement Basic Background Service Worker Lifecycle
**Goal**: Establish background script that starts and stays alive.

**Tasks**:
- [ ] Create `src/background/index.ts` as service worker entry point
- [ ] Implement `chrome.runtime.onInstalled` handler (log installation)
- [ ] Implement `chrome.runtime.onStartup` handler (log startup)
- [ ] Add basic error handling and logging (use structured logging pattern)
- [ ] Verify service worker stays active and logs lifecycle events
- [ ] Test service worker persistence across browser restarts

**Deliverable**: Background service worker that starts, logs lifecycle events, and remains active.

**Estimated Complexity**: Low  
**Estimated Time**: 1 hour

---

### Step 1.4: Implement Basic Content Script Injection
**Goal**: Inject content scripts on supported pages and establish communication channel.

**Tasks**:
- [ ] Create `src/content/index.ts` as content script entry point
- [ ] Configure manifest to inject content script on supported domains
- [ ] Implement basic `chrome.runtime.sendMessage` from content script
- [ ] Implement basic `chrome.runtime.onMessage` handler in background
- [ ] Add message type definitions (TypeScript interfaces)
- [ ] Test bidirectional messaging between content and background
- [ ] Verify content script only loads on configured domains

**Deliverable**: Content script injects on supported pages and can communicate with background.

**Estimated Complexity**: Low-Medium  
**Estimated Time**: 1-2 hours

---

## Phase 2: Storage & Configuration (Simple, Large Steps)

### Step 2.1: Implement Storage Layer for Room Credentials
**Goal**: Store and retrieve room credentials with TTL enforcement.

**Tasks**:
- [ ] Create `src/background/storage.ts` module
- [ ] Define TypeScript interfaces for stored data:
  - `roomId: string`
  - `password: string`
  - `clientId: string`
  - `expirationTimestamp: number`
- [ ] Implement `saveSyncParams()` using `chrome.storage.local`
- [ ] Implement `loadSyncParams()` with validation
- [ ] Implement `clearSyncParams()` for cleanup
- [ ] Add TTL validation (reject expired credentials)
- [ ] Add error handling for storage failures
- [ ] Write unit tests for storage functions

**Deliverable**: Storage module that persists and validates room credentials with TTL.

**Estimated Complexity**: Low  
**Estimated Time**: 1-2 hours

---

### Step 2.2: Implement URL Parameter Parsing for Share Links
**Goal**: Extract sync parameters from URL query strings and store them.

**Tasks**:
- [ ] Create `src/background/url-parser.ts` module
- [ ] Implement function to extract `sync_url` and `sync_password` from URL
- [ ] Parse WebSocket URL to extract roomId
- [ ] Validate URL format (must be WSS)
- [ ] Strip parameters from URL after extraction (clean URL bar)
- [ ] Integrate with storage layer to save extracted parameters
- [ ] Handle edge cases (missing params, invalid URLs, non-WSS URLs)
- [ ] Test with various URL formats

**Deliverable**: URL parser that extracts sync parameters and stores them.

**Estimated Complexity**: Low-Medium  
**Estimated Time**: 1-2 hours

---

### Step 2.3: Implement Alarm-Based TTL Cleanup
**Goal**: Automatically clear expired credentials using Chrome alarms.

**Tasks**:
- [ ] Create `src/background/ttl-manager.ts` module
- [ ] Implement `scheduleTTLCleanup()` that sets `chrome.alarms` for expiration time
- [ ] Implement `chrome.alarms.onAlarm` handler to clear expired credentials
- [ ] Integrate with storage layer to check and clear expired entries
- [ ] Handle alarm cancellation when credentials are manually cleared
- [ ] Test TTL expiration and cleanup behavior

**Deliverable**: Automatic cleanup of expired credentials via alarms.

**Estimated Complexity**: Low  
**Estimated Time**: 1 hour

---

## Phase 3: WebSocket & Protocol Foundation (Medium Complexity, Large Steps)

### Step 3.1: Implement WebSocket Connection Lifecycle
**Goal**: Establish and maintain WebSocket connection to backend.

**Tasks**:
- [ ] Create `src/background/core/websocket.ts` module
- [ ] Implement connection state machine:
  - `DISCONNECTED`
  - `CONNECTING`
  - `JOINING`
  - `SYNCING_CLOCK`
  - `ACTIVE`
  - `DEGRADED`
- [ ] Implement `connect()` function that opens WSS connection
- [ ] Implement `disconnect()` function with graceful close
- [ ] Implement reconnection logic with exponential backoff
- [ ] Add connection state change logging
- [ ] Handle WebSocket errors and connection failures
- [ ] Test connection lifecycle and reconnection behavior

**Deliverable**: WebSocket module that manages connection lifecycle with state machine.

**Estimated Complexity**: Medium  
**Estimated Time**: 2-3 hours

---

### Step 3.2: Implement JSON Message Protocol Layer
**Goal**: Serialize and deserialize protocol messages with validation.

**Tasks**:
- [ ] Create `src/background/core/protocol.ts` module
- [ ] Define TypeScript interfaces for all message types (from `WEBSOCKET_TYPES.md`):
  - Client → Server: `JOIN`, `EVENT`, `EPISODE_CHANGE_REQUEST`, `CLOCK_PING`, `HEARTBEAT`
  - Server → Client: `ROOM_STATE`, `PLAY`, `PAUSE`, `SEEK`, `EPISODE_CHANGE`, `SYNC_ADJUST`, `CLOCK_PONG`, `ERROR`
- [ ] Implement `serializeMessage()` for outbound messages
- [ ] Implement `deserializeMessage()` for inbound messages
- [ ] Add JSON schema validation using `ajv` (install dependency)
- [ ] Create JSON schema files in `schemas/` directory for each message type
- [ ] Add error handling for invalid messages
- [ ] Write unit tests for serialization/deserialization

**Deliverable**: Protocol layer that validates and serializes/deserializes all message types.

**Estimated Complexity**: Medium  
**Estimated Time**: 3-4 hours

---

### Step 3.3: Implement JOIN Handshake Flow
**Goal**: Authenticate with backend and receive initial room state.

**Tasks**:
- [ ] Create `src/background/core/join-handler.ts` module
- [ ] Implement `sendJoin()` function that sends JOIN message with credentials
- [ ] Implement handler for `ROOM_STATE` response
- [ ] Validate `ROOM_STATE` message structure
- [ ] Store received room state (playback state, content identity)
- [ ] Handle JOIN failures (invalid room, expired room, wrong password)
- [ ] Transition connection state to `JOINING` → `ACTIVE` or error
- [ ] Integrate with storage layer to load credentials
- [ ] Test JOIN flow with valid and invalid credentials

**Deliverable**: JOIN handshake that authenticates and receives room state.

**Estimated Complexity**: Medium  
**Estimated Time**: 2-3 hours

---

## Phase 4: Clock Synchronization (Medium Complexity, Medium Steps)

### Step 4.1: Implement Clock Synchronization (NTP-style)
**Goal**: Calculate clock offset between client and server.

**Tasks**:
- [ ] Create `src/background/core/clock-sync.ts` module
- [ ] Implement `CLOCK_PING` message sending
- [ ] Implement `CLOCK_PONG` message handling
- [ ] Calculate RTT for each ping-pong exchange
- [ ] Collect 3-5 samples and select median RTT
- [ ] Calculate clock offset: `offset = serverTime - clientTime`
- [ ] Store clock offset for use in scheduled commands
- [ ] Implement periodic re-sync (every 30-60 seconds)
- [ ] Handle clock sync failures gracefully
- [ ] Write unit tests for clock offset calculation

**Deliverable**: Clock synchronization that calculates and maintains offset.

**Estimated Complexity**: Medium  
**Estimated Time**: 2-3 hours

---

### Step 4.2: Implement Scheduled Command Execution
**Goal**: Execute playback commands at precise server-specified times.

**Tasks**:
- [ ] Create `src/background/core/command-scheduler.ts` module
- [ ] Implement `schedulePlay()` that uses clock offset to schedule `play()` at server time
- [ ] Use `setTimeout` or `requestAnimationFrame` for precise timing
- [ ] Handle clock drift between sync and execution
- [ ] Implement immediate execution for `PAUSE` and `SEEK` commands
- [ ] Add logging for scheduled vs immediate commands
- [ ] Test scheduled execution accuracy (within 50ms tolerance)

**Deliverable**: Command scheduler that executes commands at precise server times.

**Estimated Complexity**: Medium-High  
**Estimated Time**: 2-3 hours

---

## Phase 5: Event Handling & Suppression (Medium Complexity, Medium Steps)

### Step 5.1: Implement Event Suppression Window
**Goal**: Prevent feedback loops when applying remote commands.

**Tasks**:
- [ ] Create `src/background/core/suppression.ts` module
- [ ] Implement suppression window state (timestamp-based, not boolean)
- [ ] Implement `activateSuppressionWindow(durationMs)` function
- [ ] Implement `isSuppressionActive()` function that checks if current time is within window
- [ ] Handle overlapping suppression windows (extend window if needed)
- [ ] Integrate with command handlers to activate suppression before forwarding commands
- [ ] Integrate with event handlers to check suppression before sending events
- [ ] Test suppression prevents feedback loops

**Deliverable**: Suppression window that prevents feedback loops.

**Estimated Complexity**: Medium  
**Estimated Time**: 1-2 hours

---

### Step 5.2: Implement Outbound Event Handling (Local Intent → Protocol)
**Goal**: Convert local user actions into protocol events.

**Tasks**:
- [ ] Create `src/background/core/event-handler.ts` module
- [ ] Implement handlers for local intent messages from content scripts:
  - `play` (with current video time)
  - `pause` (with current video time)
  - `seek` (with target video time)
- [ ] Check suppression window before processing intent
- [ ] Check connection state (must be `ACTIVE`)
- [ ] Serialize intent into `EVENT` protocol message
- [ ] Attach `client_ts` timestamp
- [ ] Send to server via WebSocket
- [ ] Handle send failures gracefully
- [ ] Test event handling with suppression active/inactive

**Deliverable**: Event handler that converts local intent to protocol events.

**Estimated Complexity**: Medium  
**Estimated Time**: 2-3 hours

---

### Step 5.3: Implement Inbound Command Handling (Protocol → Content Script)
**Goal**: Receive authoritative commands and forward to content scripts.

**Tasks**:
- [ ] Create `src/background/core/command-handler.ts` module
- [ ] Implement handlers for inbound protocol commands:
  - `PLAY` (scheduled)
  - `PAUSE` (immediate)
  - `SEEK` (immediate)
  - `EPISODE_CHANGE`
  - `SYNC_ADJUST`
- [ ] Validate `eventId` for idempotency (ignore duplicates/out-of-order)
- [ ] Track highest applied `eventId`
- [ ] Activate suppression window before forwarding
- [ ] Forward commands to relevant content scripts via `chrome.tabs.sendMessage`
- [ ] Handle tab not found or unresponsive gracefully
- [ ] Test command forwarding and idempotency

**Deliverable**: Command handler that receives and forwards authoritative commands.

**Estimated Complexity**: Medium  
**Estimated Time**: 2-3 hours

---

## Phase 6: Adapter System Foundation (Medium Complexity, Large Steps)

### Step 6.1: Define Adapter Interface and Types
**Goal**: Establish TypeScript interfaces for adapter system.

**Tasks**:
- [ ] Create `src/content/adapter-types.ts` module
- [ ] Define `Adapter` interface:
  - `id: string`
  - `canHandlePage(url: URL): boolean`
  - `init(ctx: AdapterContext): Promise<void>`
  - `destroy(): void`
- [ ] Define `AdapterContext` interface:
  - `reportIntent(intent: PlaybackIntent): void`
  - `onCommand(callback: (cmd: PlaybackCommand) => void): void`
  - `isSuppressionActive(): boolean`
  - `failFatal(error: Error): void`
  - `log(level: string, message: string, data?: object): void`
- [ ] Define `PlaybackIntent` type: `{ type: 'play' | 'pause' | 'seek', time: number }`
- [ ] Define `PlaybackCommand` type: `{ type: 'play' | 'pause' | 'seek' | 'sync_adjust', time?: number, delta?: number }`
- [ ] Define `ContentIdentity` type: `{ providerId: string, episodeId: string, normalizedUrl: string }`
- [ ] Export all types for use by adapters

**Deliverable**: Complete TypeScript type definitions for adapter system.

**Estimated Complexity**: Low-Medium  
**Estimated Time**: 1-2 hours

---

### Step 6.2: Implement Adapter Runtime (Content Script Side)
**Goal**: Create runtime that provides AdapterContext to adapters.

**Tasks**:
- [ ] Create `src/content/adapter-runtime.ts` module
- [ ] Implement `AdapterContext` class that provides:
  - `reportIntent()` - sends intent to background via `chrome.runtime.sendMessage`
  - `onCommand()` - registers callback for commands from background
  - `isSuppressionActive()` - checks suppression state (may need to request from background)
  - `failFatal()` - logs fatal error and disables adapter
  - `log()` - structured logging
- [ ] Implement message handlers for commands from background
- [ ] Implement message handlers for suppression state updates
- [ ] Add error handling and logging
- [ ] Test adapter runtime with mock adapter

**Deliverable**: Adapter runtime that provides AdapterContext to adapters.

**Estimated Complexity**: Medium  
**Estimated Time**: 2-3 hours

---

### Step 6.3: Implement Adapter Manager (Background Side)
**Goal**: Manage adapter lifecycle and coordinate between adapters and core sync engine.

**Tasks**:
- [ ] Create `src/background/adapter-manager.ts` module
- [ ] Implement `tabId → adapterId` mapping storage
- [ ] Implement adapter evaluation on page load/navigation:
  - Listen for `chrome.tabs.onUpdated` events
  - Evaluate adapters in priority order
  - Select first adapter whose `canHandlePage()` returns true
- [ ] Implement adapter activation:
  - Inject content script for selected adapter
  - Wait for adapter initialization
  - Handle initialization failures (disable sync for tab)
- [ ] Implement adapter deactivation on navigation/close
- [ ] Implement content identity forwarding from adapter to core sync engine
- [ ] Implement command forwarding from core sync engine to adapter
- [ ] Implement intent forwarding from adapter to core sync engine
- [ ] Add error handling and logging

**Deliverable**: Adapter manager that coordinates adapters and core sync engine.

**Estimated Complexity**: Medium-High  
**Estimated Time**: 3-4 hours

---

## Phase 7: Template Adapter (Medium Complexity, Large Steps)

### Step 7.1: Create Template Adapter Structure
**Goal**: Create baseline adapter that serves as reference for site-specific adapters.

**Tasks**:
- [ ] Create `src/content/adapters/_template/index.ts`
- [ ] Implement `canHandlePage()` that always returns `false` (template never activates)
- [ ] Implement `init()` with placeholder logic
- [ ] Implement `destroy()` with cleanup
- [ ] Add comprehensive JSDoc comments explaining adapter responsibilities
- [ ] Add example implementations for:
  - Video element discovery
  - Event listener attachment
  - Content identity derivation
  - Command execution
- [ ] Create `README.md` in template directory explaining adapter pattern

**Deliverable**: Template adapter that serves as reference implementation.

**Estimated Complexity**: Low-Medium  
**Estimated Time**: 2-3 hours

---

### Step 7.2: Implement Template Adapter Video Discovery
**Goal**: Provide robust video element discovery pattern.

**Tasks**:
- [ ] Implement `discoverVideoElement()` function in template
- [ ] Use `document.querySelectorAll('video')` to find candidates
- [ ] Filter candidates by:
  - Visibility (not hidden)
  - Duration (has meaningful duration > threshold)
  - Not muted-only previews
- [ ] Select first stable candidate
- [ ] Implement `MutationObserver` to detect video element replacement
- [ ] Handle SPA navigation that replaces video element
- [ ] Add error handling for video not found
- [ ] Document discovery strategy in comments

**Deliverable**: Template adapter with robust video discovery.

**Estimated Complexity**: Medium  
**Estimated Time**: 2-3 hours

---

### Step 7.3: Implement Template Adapter Event Observation
**Goal**: Observe user playback actions and report intent.

**Tasks**:
- [ ] Implement event listeners for:
  - `play` event
  - `pause` event
  - `seeking` event (start of seek)
  - `seeked` event (end of seek)
- [ ] Check suppression window before reporting intent
- [ ] Extract current video time from `video.currentTime`
- [ ] Report intent via `AdapterContext.reportIntent()`
- [ ] Handle programmatic events (ignore during suppression)
- [ ] Detach listeners on destroy
- [ ] Test event observation with suppression active/inactive

**Deliverable**: Template adapter that observes and reports playback intent.

**Estimated Complexity**: Medium  
**Estimated Time**: 2-3 hours

---

### Step 7.4: Implement Template Adapter Command Execution
**Goal**: Execute authoritative playback commands from server.

**Tasks**:
- [ ] Implement command handlers for:
  - `play` - call `video.play()`
  - `pause` - call `video.pause()`
  - `seek` - set `video.currentTime = command.time`
  - `sync_adjust` - apply delta correction (nudge-rate or seek)
- [ ] Register command callback via `AdapterContext.onCommand()`
- [ ] Handle commands idempotently (check if already applied)
- [ ] Handle video element not ready (wait for `canplay`)
- [ ] Add error handling for command failures
- [ ] Test command execution with various video states

**Deliverable**: Template adapter that executes playback commands.

**Estimated Complexity**: Medium  
**Estimated Time**: 2-3 hours

---

### Step 7.5: Implement Template Adapter Content Identity
**Goal**: Derive strict content identity from page.

**Tasks**:
- [ ] Implement `deriveContentIdentity()` function
- [ ] Extract `providerId` from URL or page context
- [ ] Extract `episodeId` from URL or page context
- [ ] Derive `normalizedUrl` (path only, no hostname):
  - Parse URL
  - Extract pathname + search params (if needed)
  - Remove hostname
  - Example: `/watch/one-piece/1093`
- [ ] Validate all three fields are present
- [ ] Set content identity exactly once during `init()`
- [ ] Fail fast if identity derivation fails
- [ ] Document identity derivation rules in comments

**Deliverable**: Template adapter that derives content identity.

**Estimated Complexity**: Medium  
**Estimated Time**: 2-3 hours

---

## Phase 8: Miruro Adapter (Complex, Medium Steps)

### Step 8.1: Create Miruro Adapter Structure
**Goal**: Create Miruro-specific adapter based on template.

**Tasks**:
- [ ] Create `src/content/adapters/miruro/index.ts`
- [ ] Copy template adapter structure
- [ ] Implement `canHandlePage()` to match Miruro domains:
  - `miruro.tv`
  - `miruro.to`
  - Check URL pattern matches video page
- [ ] Set adapter `id: 'miruro'`
- [ ] Test adapter activation on Miruro pages

**Deliverable**: Miruro adapter that activates on Miruro pages.

**Estimated Complexity**: Low-Medium  
**Estimated Time**: 1 hour

---

### Step 8.2: Implement Miruro Video Discovery
**Goal**: Locate video element on Miruro pages.

**Tasks**:
- [ ] Inspect Miruro page structure to identify video element selector
- [ ] Implement Miruro-specific video discovery:
  - May need to wait for SPA to load video
  - May need to handle multiple video elements (ads vs main)
  - Use Miruro-specific selectors if needed
- [ ] Test video discovery on various Miruro pages
- [ ] Handle edge cases (video not loaded, multiple videos)

**Deliverable**: Miruro adapter that reliably finds video element.

**Estimated Complexity**: Medium  
**Estimated Time**: 2-3 hours

---

### Step 8.3: Implement Miruro Content Identity Derivation
**Goal**: Extract content identity from Miruro URLs.

**Tasks**:
- [ ] Analyze Miruro URL structure (e.g., `/watch/anime-name/episode-number`)
- [ ] Implement `deriveContentIdentity()` for Miruro:
  - `providerId: 'miruro'`
  - Extract `episodeId` from URL path
  - Derive `normalizedUrl` (path only, no hostname)
- [ ] Handle URL variations (query params, hash fragments)
- [ ] Validate identity derivation on various Miruro URLs
- [ ] Test identity derivation edge cases

**Deliverable**: Miruro adapter that derives content identity from URLs.

**Estimated Complexity**: Medium  
**Estimated Time**: 2-3 hours

---

### Step 8.4: Implement Miruro SPA Navigation Detection
**Goal**: Detect episode changes and content swaps.

**Tasks**:
- [ ] Implement URL change detection:
  - Monkey-patch `history.pushState` and `history.replaceState`
  - Listen for `popstate` events
  - Fallback polling (≈1s)
- [ ] Compare new content identity with current identity
- [ ] If identity changes:
  - Call `AdapterContext.failFatal()` to terminate adapter
  - Document that hot-swapping is not supported in v1
- [ ] Test navigation detection on Miruro SPA

**Deliverable**: Miruro adapter that detects and handles navigation.

**Estimated Complexity**: Medium-High  
**Estimated Time**: 2-3 hours

---

## Phase 9: Content Identity & Episode Handling (Complex, Small Steps)

### Step 9.1: Implement Content Identity Forwarding (Adapter → Core)
**Goal**: Forward content identity from adapter to core sync engine.

**Tasks**:
- [ ] Extend adapter runtime to forward content identity to background
- [ ] Extend adapter manager to receive content identity from adapter
- [ ] Store content identity per tab in adapter manager
- [ ] Forward content identity to core sync engine during JOIN
- [ ] Include content identity in `JOIN` message
- [ ] Test content identity forwarding flow

**Deliverable**: Content identity flows from adapter to backend.

**Estimated Complexity**: Medium  
**Estimated Time**: 1-2 hours

---

### Step 9.2: Implement Episode Change Request Handling
**Goal**: Handle episode changes as first-class control events.

**Tasks**:
- [ ] Extend adapter interface to support episode change detection
- [ ] Implement episode change detection in adapters (triggered by navigation)
- [ ] Send `EPISODE_CHANGE_REQUEST` from adapter via adapter runtime
- [ ] Handle `EPISODE_CHANGE_REQUEST` in background event handler
- [ ] Serialize and send `EPISODE_CHANGE_REQUEST` to server
- [ ] Handle `EPISODE_CHANGE` response from server
- [ ] Forward episode change to adapter for execution
- [ ] Reset playback state (pause, seek to 0)
- [ ] Test episode change flow end-to-end

**Deliverable**: Episode changes handled as authoritative control events.

**Estimated Complexity**: Medium-High  
**Estimated Time**: 3-4 hours

---

### Step 9.3: Implement Content Mismatch Detection
**Goal**: Detect and handle content identity mismatches.

**Tasks**:
- [ ] Compare local `derivedContentKey` with server `derivedContentKey` on JOIN
- [ ] Compare local `derivedContentKey` with server `derivedContentKey` on `EPISODE_CHANGE`
- [ ] If mismatch detected:
  - Enter `DEGRADED` connection state
  - Refuse to apply playback commands
  - Surface visible warning to user
- [ ] Implement `CONTENT_MISMATCH` message handling (if server sends it)
- [ ] Test content mismatch scenarios

**Deliverable**: Content mismatch detection and handling.

**Estimated Complexity**: Medium  
**Estimated Time**: 2-3 hours

---

## Phase 10: Drift Reconciliation (Complex, Small Steps)

### Step 10.1: Implement HEARTBEAT Messages
**Goal**: Send periodic playback state reports to server.

**Tasks**:
- [ ] Request current video time from adapter
- [ ] Send `HEARTBEAT` message with:
  - `currentTime`
  - `client_ts`
  - `buffering` state (if applicable)
- [ ] Send heartbeat at fixed interval (e.g., every 5 seconds)
- [ ] Only send heartbeat when connection is `ACTIVE`
- [ ] Handle heartbeat send failures gracefully
- [ ] Test heartbeat message flow

**Deliverable**: Periodic heartbeat messages sent to server.

**Estimated Complexity**: Low-Medium  
**Estimated Time**: 1-2 hours

---

### Step 10.2: Implement SYNC_ADJUST Command Handling
**Goal**: Apply drift correction commands from server.

**Tasks**:
- [ ] Handle `SYNC_ADJUST` command in command handler
- [ ] Forward `SYNC_ADJUST` to adapter
- [ ] Implement `sync_adjust` execution in adapter:
  - If mode = `nudge-rate`: temporarily adjust `video.playbackRate`
  - If mode = `seek`: hard seek to `targetPos`
- [ ] Restore playback rate after nudge-rate correction
- [ ] Test drift correction with various drift amounts

**Deliverable**: SYNC_ADJUST commands applied to correct drift.

**Estimated Complexity**: Medium-High  
**Estimated Time**: 2-3 hours

---

## Phase 11: Error Handling & Edge Cases (Complex, Small Steps)

### Step 11.1: Implement Comprehensive Error Handling
**Goal**: Handle all error scenarios gracefully.

**Tasks**:
- [ ] Add error handling for WebSocket connection failures
- [ ] Add error handling for invalid protocol messages
- [ ] Add error handling for adapter initialization failures
- [ ] Add error handling for video element not found
- [ ] Add error handling for content identity derivation failures
- [ ] Add error handling for command execution failures
- [ ] Surface user-visible errors for fatal failures
- [ ] Log all errors with structured context
- [ ] Test error scenarios

**Deliverable**: Comprehensive error handling throughout extension.

**Estimated Complexity**: Medium  
**Estimated Time**: 3-4 hours

---

### Step 11.2: Implement Reconnection & Recovery
**Goal**: Handle disconnections and reconnect gracefully.

**Tasks**:
- [ ] Detect WebSocket disconnection
- [ ] Implement exponential backoff reconnection
- [ ] Re-send JOIN with same `clientId` on reconnect
- [ ] Re-run clock synchronization on reconnect
- [ ] Reconcile content identity on reconnect
- [ ] Apply `JOIN_SEEK_THRESHOLD` logic (seek if drift > threshold)
- [ ] Test reconnection scenarios (network drop, server restart)

**Deliverable**: Robust reconnection and recovery.

**Estimated Complexity**: Medium-High  
**Estimated Time**: 3-4 hours

---

### Step 11.3: Implement Tab Lifecycle Management
**Goal**: Handle tab close, navigation, and reload.

**Tasks**:
- [ ] Listen for `chrome.tabs.onRemoved` to clean up adapter mappings
- [ ] Listen for `chrome.tabs.onUpdated` to detect navigation
- [ ] Deactivate adapter on navigation away from supported page
- [ ] Reactivate adapter on navigation to supported page
- [ ] Handle tab reload (adapter reinitializes)
- [ ] Clean up resources on tab close
- [ ] Test tab lifecycle scenarios

**Deliverable**: Proper tab lifecycle management.

**Estimated Complexity**: Medium  
**Estimated Time**: 2-3 hours

---

## Phase 12: Testing & Polish (Complex, Small Steps)

### Step 12.1: Write Unit Tests for Core Modules
**Goal**: Ensure core functionality is tested.

**Tasks**:
- [ ] Write unit tests for storage module
- [ ] Write unit tests for protocol serialization/deserialization
- [ ] Write unit tests for clock synchronization
- [ ] Write unit tests for suppression window
- [ ] Write unit tests for event handler
- [ ] Write unit tests for command handler
- [ ] Set up Jest test runner configuration
- [ ] Achieve >80% code coverage for core modules

**Deliverable**: Comprehensive unit test suite for core modules.

**Estimated Complexity**: Medium  
**Estimated Time**: 4-6 hours

---

### Step 12.2: Write Integration Tests for Adapter System
**Goal**: Test adapter system end-to-end.

**Tasks**:
- [ ] Write integration tests for adapter activation
- [ ] Write integration tests for adapter deactivation
- [ ] Write integration tests for intent forwarding
- [ ] Write integration tests for command forwarding
- [ ] Write integration tests for content identity flow
- [ ] Test with mock adapters
- [ ] Test with template adapter

**Deliverable**: Integration tests for adapter system.

**Estimated Complexity**: Medium-High  
**Estimated Time**: 3-4 hours

---

### Step 12.3: Manual Testing & Bug Fixes
**Goal**: Test extension in real browser environment.

**Tasks**:
- [ ] Test extension installation and loading
- [ ] Test room join flow with share link
- [ ] Test playback synchronization between multiple clients
- [ ] Test seek synchronization
- [ ] Test pause/play synchronization
- [ ] Test episode change flow
- [ ] Test reconnection scenarios
- [ ] Test error scenarios
- [ ] Fix bugs discovered during testing
- [ ] Document known limitations

**Deliverable**: Extension tested and bugs fixed.

**Estimated Complexity**: High (variable)  
**Estimated Time**: 8-12 hours

---

### Step 12.4: Add Logging & Debugging Tools
**Goal**: Enable debugging and monitoring.

**Tasks**:
- [ ] Add structured logging throughout extension
- [ ] Add debug mode flag (controlled via storage or URL param)
- [ ] Add debug UI overlay (optional, for development)
- [ ] Add connection state indicator (optional)
- [ ] Add error reporting mechanism
- [ ] Document debugging procedures

**Deliverable**: Logging and debugging tools for development.

**Estimated Complexity**: Low-Medium  
**Estimated Time**: 2-3 hours

---

## Summary

This implementation plan progresses from simple foundational steps (project setup, manifest, permissions) to complex implementation details (adapter system, protocol handling, drift reconciliation). Each phase builds on previous phases, maintaining a clear focus on what to do next.

**Total Estimated Time**: 60-90 hours (approximately 2-3 weeks of focused development)

**Key Milestones**:
1. **Phase 1-2**: Foundation complete (project setup, storage, basic communication)
2. **Phase 3-5**: Core sync engine complete (WebSocket, protocol, clock sync, events)
3. **Phase 6-7**: Adapter system complete (adapter runtime, template adapter)
4. **Phase 8**: First site adapter complete (Miruro)
5. **Phase 9-10**: Advanced features complete (episode handling, drift reconciliation)
6. **Phase 11-12**: Production ready (error handling, testing, polish)

---

## Notes

- This plan assumes the backend server is already implemented and available for testing.
- Some steps may be parallelized (e.g., template adapter and Miruro adapter can be developed in parallel after adapter system is complete).
- Complexity estimates are relative and may vary based on implementation details.
- Time estimates assume familiarity with browser extension development and TypeScript.
