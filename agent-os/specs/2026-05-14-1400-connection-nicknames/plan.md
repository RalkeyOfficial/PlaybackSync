# Connection Nicknames (Reddit-Style)

## Context

The event log and presence data currently show raw 32-char hex connection IDs, which are meaningless to users. We're assigning each connection a random human-readable nickname on creation (`AdjectiveNoun##`, e.g. `WittyFalcon42`) that persists for the lifetime of that connection. Nicknames replace the raw IDs in all event-log display fields — the internal `clientId` is unchanged and continues to drive routing/reconnect logic.

---

## Task 1: Save Spec Documentation ✓

`agent-os/specs/2026-05-14-1400-connection-nicknames/` — this folder.

---

## Task 2: NicknameGenerator utility

**New file:** `lib/WebSocket/NicknameGenerator.php`

- `final class NicknameGenerator` with one `public static function generate(): string`
- Returns `{Adjective}{Noun}{number}` — PascalCase adjective + noun, 2-digit number (10–99)
- ~50 adjectives, ~50 nouns in private static arrays inside the class (gives ~225,000 combos)

---

## Task 3: Add `nickname` to ClientConnection

**File:** `lib/WebSocket/ClientConnection.php`

- Add `public readonly string $nickname` property
- Add `string $nickname` parameter to the constructor

---

## Task 4: Generate nickname at connection creation

**File:** `lib/WebSocket/Handler/JoinHandler.php`

In `reattachOrCreateClient()`:
- After `$clientId = $requestedClientId ?? bin2hex(random_bytes(16));` (line 169), add `$nickname = NicknameGenerator::generate();`
- Pass `$nickname` to the `ClientConnection` constructor
- On reattach, existing `ClientConnection` is returned as-is — nickname preserved automatically

Update the `client_joined` envelope (lines 81–88):
- `'actorId' => $client->nickname` (was `$client->clientId`)
- `'data' => ['nickname' => $client->nickname]` (was `['clientId' => $client->clientId]`)

---

## Task 5: Pass nickname as actorId in playback events

- `lib/WebSocket/RoomRuntime.php` — rename `$clientId` → `$actorId` in `pushEvent()` signature
- `lib/WebSocket/Handler/EventHandler.php` — pass `$client->nickname` instead of `$ctx->clientId`
- `lib/WebSocket/Handler/EpisodeChangeHandler.php` — same

---

## Task 6: Pass nickname in presence leave/kick events

- `lib/WebSocket/MessageRouter.php` `onClose` — `data['clientId']` → `data['nickname']` via `$client->nickname`
- `lib/WebSocket/Admin/KickController.php` — pull `ClientConnection` from existing `getClient()` call; use `$client->nickname` in `data['nickname']`
- `lib/WebSocket/RoomRuntime.php` `pruneExpiredTombstones()` — change return type from `list<string>` to `list<ClientConnection>`
- `lib/WebSocket/Tick.php` — use `$dropped->nickname` in `client_left` data

---

## Task 7: Expose nickname in PresenceController

**File:** `lib/WebSocket/Admin/PresenceController.php` — add `'nickname' => $client->nickname` to serialized client

---

## Task 8: Frontend — RoomEventLog.vue

**File:** `src/components/RoomEventLog.vue`

- Remove `.slice(0, 8)` truncation for `'client'` actors in `actorLabel()`
- Update `client_joined`, `client_left`, `client_kicked` detail branches to use `event.data?.nickname` instead of `event.data?.clientId`

---

## Verification

1. Start the WebSocket daemon and open two browser tabs — verify each shows a distinct `AdjectiveNoun##` nickname in the event log actor chip on join
2. Disconnect and reconnect the same tab — verify the nickname is preserved (not regenerated)
3. Trigger play/pause/seek from a client — verify the event log actor chip shows the nickname, not a hex ID
4. Kick a client (as owner) — verify the `client_kicked` event detail shows the nickname
5. Let a tombstone expire (or idle-timeout a client) — verify `client_left` shows the nickname
6. Check the admin presence REST endpoint — verify `nickname` appears alongside `clientId` in client objects
