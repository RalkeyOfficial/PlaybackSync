# Connection Nicknames — Shaping Notes

## Scope

Add Reddit-style random nicknames (`AdjectiveNoun##`, e.g. `WittyFalcon42`) to WebSocket connections. Each nickname is generated once at connection creation time, persisted in memory on the `ClientConnection` object, and replaces the raw hex `clientId` in all event-log display fields (actor chips and type-specific detail text). The internal `clientId` is unchanged and continues to be used for routing, reconnect, tombstoning, and kick logic.

## Decisions

- **Persisted, not deterministic** — nickname is generated randomly at creation and stored on the `ClientConnection` object, not derived from the clientId hash. This gives more varied names and avoids any correlation with the internal ID.
- **Replace ID entirely in display** — the event log actor chip and all type-specific detail rows show the nickname; the raw hex ID is no longer visible to users.
- **actorId carries the nickname** — for client-actor events, `actorId` is set to the nickname string instead of the clientId. This means no schema changes to the event envelope; existing frontend rendering just works once the truncation is removed.
- **data.clientId → data.nickname** — presence event data fields (`client_joined`, `client_left`, `client_kicked`) that previously embedded the clientId now embed the nickname.
- **No DI for generator** — `NicknameGenerator` is a pure static utility; injecting it would add boilerplate for zero benefit.
- **pruneExpiredTombstones returns ClientConnection objects** — to get the nickname when emitting `client_left` for tombstone expiry, we return the full `ClientConnection` from `pruneExpiredTombstones()` instead of just the string clientId.

## Context

- **Visuals:** None
- **References:** `lib/WebSocket/ClientConnection.php`, `lib/WebSocket/Handler/JoinHandler.php`, `lib/WebSocket/RoomRuntime.php`, `lib/WebSocket/MessageRouter.php`, `lib/WebSocket/Admin/KickController.php`, `lib/WebSocket/Tick.php`, `lib/WebSocket/Admin/PresenceController.php`, `src/components/RoomEventLog.vue`
- **Product alignment:** Small friend-group watch parties — humanised identifiers make it easier to see at a glance who paused or seeked the video without needing to memorise hex strings.

## Standards Applied

- `backend/php-conventions` — strict types, OCA namespace, no OC\ imports
- `frontend/vue-conventions` — script setup, no new hardcoded strings (nickname is data, not a UI label)
