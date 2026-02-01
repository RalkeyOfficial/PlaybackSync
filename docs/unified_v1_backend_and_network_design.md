# Unified Video Sync Protocol (Merged Design)

This document consolidates the event-driven, clock-synchronized client–server model from the newer sync diagram with selected higher-level concepts from the original backend design. The goal is to preserve the stronger timing and ordering guarantees of the new document while reintroducing only those pieces from the old document that materially improve correctness or user experience.

Non-goals remain unchanged: this document does not address horizontal scaling, persistence, or media hosting. It assumes a single authoritative server and a browser extension as the primary client.

---

## 1. Core principles (unchanged, but restated)

The system is built around four invariants:

1. The server owns the authoritative timeline.
2. All user-visible control actions (play, pause, seek, episode change) are serialized and rebroadcast by the server.
3. Clients never infer intent from other clients; they only react to server commands.
4. Clock synchronization is required to schedule simultaneous actions across heterogeneous RTTs.

The newer event-handling document already satisfies these invariants well. The changes below extend the *scope* of what is considered part of the authoritative state.

---

## 2. Authoritative room state (extended)

The old document treated “what is being watched” as first-class state. That idea is retained, but simplified.

Each room maintains the following authoritative state:

- Playback state
  - paused: boolean
  - videoPos: seconds
  - lastEventId
  - lastServerUpdateTs

- Content identity
  - episodeId (or episodeNumber)
  - providerId
  - derivedContentKey (see below)

- Timing metadata
  - serverTime (epoch ms)

### Derived content key

Instead of trusting arbitrary client metadata, the server stores a canonical `derivedContentKey`, computed from:

- normalized URL (extension-provided)
- providerId
- episodeId

This key is opaque to clients. Clients only compare equality.

Purpose:
- Prevents silent desync when two clients think they are “watching the same thing” but are not.
- Allows lightweight validation without hard-coding provider-specific schemas into the backend.

---

## 3. Episode and provider synchronization

### Rationale

The old document included explicit `EPISODE_CHANGE` handling. The newer document omitted it, implicitly assuming a single fixed video. In practice, episode changes are high-impact events and should be treated like seek/play: explicit, serialized, and authoritative.

Provider syncing is more questionable. It is kept optional and constrained.

### Episode change flow

Episode changes are treated as **control events**, not background state.

Client → Server:

- `EPISODE_CHANGE_REQUEST`
  - episodeId
  - providerId
  - pageUrl
  - clientTime

Server behavior:

1. Validate that the request comes from a connected client.
2. Derive `derivedContentKey` from the provided URL + provider + episode.
3. Increment `eventId`.
4. Reset authoritative playback state:
   - paused = true
   - videoPos = 0
5. Broadcast authoritative episode change.

Server → Clients:

- `EPISODE_CHANGE`
  - eventId
  - episodeId
  - providerId
  - derivedContentKey
  - serverTime

Client behavior:

- If `derivedContentKey` matches local derivation:
  - load episode if not already loaded
  - seek to 0
  - pause
- If it does not match:
  - enter “out-of-sync content” state
  - surface UI warning and refuse to apply play/seek events

Why this design:
- Episode changes are rare but disruptive; forcing an explicit pause avoids surprise playback.
- Reusing the existing ACK / ordering model avoids special cases.

### Provider synchronization (optional)

Provider is treated as *context*, not authority.

Rules:
- Provider is only accepted as part of an episode change.
- Provider differences alone never trigger corrective actions.
- If two providers generate the same `derivedContentKey`, the server considers them equivalent.

This avoids locking the protocol to specific streaming sites while still allowing the extension to enforce “same page, same episode” guarantees when possible.

---

## 4. Message model additions

The existing message set from the new document remains valid. The following messages are added:

- `EPISODE_CHANGE_REQUEST`
  - Control priority
  - Requires ACK

- `EPISODE_CHANGE`
  - Authoritative broadcast
  - Resets playback state

- `CONTENT_MISMATCH`
  - Server → client advisory
  - Sent when a client joins or reports a different derivedContentKey

All messages continue to include `eventId`, ordering guarantees, and idempotent handling.

---

## 5. Join and reconnect behavior (refined)

On JOIN or REJOIN, the server sends:

- `ROOM_STATE`
  - playback state
  - episodeId
  - providerId
  - derivedContentKey
  - lastEventId
  - serverTime

Client reconciliation rules:

1. Perform clock sync.
2. Compare derivedContentKey.
   - If mismatch: do not auto-seek or auto-play.
3. If match:
   - Apply JOIN_SEEK_THRESHOLD logic as defined in the newer document.

This merges the old document’s “video identity” concept with the new document’s precise timing model.

---

## 6. Drift correction and content boundaries

Drift correction logic (nudging vs seek) is unchanged **within a content boundary**.

Additional rule:
- No drift correction is applied across episode boundaries.

If a client lags because it has not yet loaded the correct episode, the server does not attempt to compensate; it waits for either:
- ACK of episode change
- or explicit client error / timeout

---

## 7. Explicit exclusions from the old design

The following ideas from the old document are intentionally *not* carried forward:

- Continuous provider syncing outside episode changes
- Server-side inference of episode from timecodes alone
- Implicit episode changes based on seek beyond duration

Reason: these introduce ambiguity and edge cases that conflict with the deterministic event ordering model in the newer document.

---

## 8. Resulting mental model

After merging:

- The *new* document still defines how time, ordering, and correction work.
- The *old* document contributes the notion that “what is being watched” is authoritative state.
- Episode changes are first-class control events.
- Provider is metadata, not a hard constraint.

This keeps the protocol deterministic, debuggable, and extensible without reintroducing unnecessary complexity.

