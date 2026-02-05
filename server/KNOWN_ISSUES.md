## List of known issues

server\src\handlers\heartbeat.ts:149

Currently, the server only sets the `contentIdentity` field for a room when an explicit episode change occurs. This means that if a room is created and clients start playback without triggering an episode change, there is no content identity recorded for the room. As a result, the drift reconciliation logic cannot reliably distinguish between clients watching the same content (where drift correction is allowed) versus clients on different episodes (where correction should not happen).

This limitation blocks proper drift correction in normal scenarios where users join and start playback on the initial episode, since the system has no way to verify they are in sync on the same media content.

Workaround & Potential Solutions:
- Currently, drift reconciliation continues without content identity checks, so drift correction may be applied even if clients are desynced across episode boundaries.
- A planned fix is to add content identity fields to the initial `JOIN` message, so that the first client to join a room establishes the content identity. This would allow the server to enforce boundaries and prevent drift correction across different content, as required by the protocol design.

---
