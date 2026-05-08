# PlaybackSync Extension Architecture (Workshop v1)

This document captures the agreed-upon extension architecture and constraints. It is intended to be stable, explicit, and used as a reference for implementation and future discussion.

---

## 1. Core Goals

- Build a browser extension that connects to the PlaybackSync backend via WebSocket.
- The extension acts as a **protocol client** plus a **site-specific execution layer**.
- Support multiple video websites without changing backend or protocol logic.
- Enforce correctness over best-effort behavior.

---

## 2. Locked Decisions

These decisions are fixed unless this document is explicitly revised:

1. **Exactly one adapter per tab**
   - Multi-video pages are handled inside the adapter by deterministic element selection.

2. **Statically bundled adapters**
   - All adapters are known at build time.
   - No dynamic loading or runtime registration.

3. **Unsupported pages are silent**
   - No UI, logging, or background activity if no adapter matches.

4. **Strict content identity**
   - Content identity derivation must succeed or syncing is disabled.
   - Failure must be visible to the user and intended to trigger a GitHub issue.

---

## 3. Architectural Layers

### A. Core Sync Engine (Background)

Responsibilities:
- WebSocket lifecycle
- Protocol state machine (JOIN, STATE, EVENT, tombstones)
- Clock synchronization
- Event ordering and idempotency
- Suppression windows
- Room lifecycle
- Per-tab session state

Non-responsibilities:
- DOM access
- URL parsing
- Provider or site logic

The backend treats this layer as *the client*.

---

### B. Adapter Manager (Background + Content Coordination)

Responsibilities:
- Evaluate adapters on page load or navigation
- Select **exactly one** adapter per tab or none
- Maintain `tabId → adapterId` mapping
- Mediate communication between Core Sync Engine and adapters
- Enforce strict failure semantics

Rules:
- If an adapter claims a page but fails initialization or identity derivation, syncing is disabled for that tab.
- No fallback to another adapter once one has claimed the page.

---

### C. Site Adapters (Content Scripts)

Properties:
- Each adapter supports exactly one site
- Either fully supports the page or refuses to activate
- No partial or degraded modes

Responsibilities:
- Locate the correct video element
- Observe user playback actions
- Execute authoritative playback commands
- Derive strict content identity
- Detect SPA navigation or content changes

Non-responsibilities:
- WebSocket communication
- Protocol serialization
- Suppression logic
- Cross-tab or cross-client state

---

### D. Injected Page Hooks (Optional)

- Used only when DOM access is insufficient
- Owned entirely by the adapter
- No protocol or networking logic

---

## 4. Adapter Interface

### Mandatory Adapter Shape

- `id: string`
- `canHandlePage(url: URL): boolean`
- `init(ctx: AdapterContext): Promise<void>`
- `destroy(): void`

---

### AdapterContext Capabilities

Adapters may:
- Report local playback intent
- Receive authoritative playback commands
- Read suppression state
- Emit logs
- Fail fast with a fatal error

Adapters may **not**:
- Open WebSockets
- Emit protocol messages
- Decide authority or suppression
- Communicate with other tabs

---

## 5. Local Intent (Adapter → Core)

Adapters emit *intent*, not protocol messages:

- play (with current video time)
- pause (with current video time)
- seek (with target video time)

The Core decides whether intent becomes a protocol EVENT or is suppressed.

---

## 6. Playback Commands (Core → Adapter)

Adapters execute authoritative commands verbatim:

- play
- pause
- seek (absolute video time)
- sync_adjust (small delta correction)

Adapters do not interpret or transform these commands.

---

## 7. Content Identity (Strict)

During initialization, an adapter must set content identity exactly once.

Required fields:
- `providerId`
- `episodeId`
- `normalizedUrl`

### Normalized URL Rules

- **The normalized URL MUST NOT contain the hostname.**
- This allows the same site to operate across multiple hostnames (e.g. `miruro.to`, `miruro.tv`).
- The normalized URL represents the logical content path only, not the domain.

Example:
- Valid: `/watch/one-piece/1093`
- Invalid: `https://miruro.tv/watch/one-piece/1093`

Rules:
- Identity must not change during adapter lifetime.
- Failure to derive identity is a fatal error.

---

## 8. SPA Navigation and Content Changes

Adapters are responsible for detecting:
- URL changes
- Video element replacement
- Episode changes

If the content identity would change:
- The adapter must terminate via a fatal error.
- Hot-swapping identity is not allowed in v1.

This prevents mid-session desynchronization and preserves backend invariants.

---

## 9. Adapter Activation Flow

1. On page load or navigation, adapters are evaluated in priority order.
2. First adapter whose `canHandlePage` returns true is activated.
3. Adapter initializes, locates video, derives identity.
4. If initialization fails, syncing is disabled and a visible error is shown.
5. If no adapter matches, the extension does nothing.

---

## 10. Reference Folder Structure (Indicative)

- background/
  - core/ (websocket, protocol, clock, suppression)
  - adapter-manager
- content/
  - adapters/
    - miruro/
    - _template/
  - adapter-runtime
- injected/
  - site-specific hooks

The `_template` adapter serves as the baseline for new site support.

---

## 11. Design Intent Summary

- Correctness over convenience
- Explicit failure over silent desync
- Backend-agnostic site support
- Replaceable, auditable adapters
- Clear separation of concerns

This document represents the current agreed design state and should be treated as canonical until explicitly revised.

