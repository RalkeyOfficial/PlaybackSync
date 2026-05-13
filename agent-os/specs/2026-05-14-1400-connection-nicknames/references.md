# References for Connection Nicknames

## Similar Implementations

### ClientConnection — connection state object

- **Location:** `lib/WebSocket/ClientConnection.php`
- **Relevance:** Where `nickname` is added as a new `readonly` property alongside `clientId`
- **Key patterns:** Constructor promotion / readonly properties; `reattach()` preserves all existing state so reconnecting clients automatically keep their nickname

### JoinHandler — connection creation

- **Location:** `lib/WebSocket/Handler/JoinHandler.php`
- **Relevance:** `reattachOrCreateClient()` is where `clientId` is generated and where `nickname` must be generated and passed to the `ClientConnection` constructor; also where `client_joined` envelope is built
- **Key patterns:** `bin2hex(random_bytes(16))` pattern for clientId generation; `pushEnvelope()` call for presence events

### RoomRuntime — event ring

- **Location:** `lib/WebSocket/RoomRuntime.php`
- **Relevance:** `pushEvent()` takes `$clientId` (renamed to `$actorId`) for playback events; `pruneExpiredTombstones()` returns dropped client IDs (changed to return `ClientConnection` objects)
- **Key patterns:** `$isOwnerLoopback = $clientId === 'admin'` sentinel check must be preserved

### MessageRouter — socket close

- **Location:** `lib/WebSocket/MessageRouter.php`
- **Relevance:** `onClose()` at line 133 emits `client_left` with `data['clientId']` — updated to `data['nickname']`
- **Key patterns:** `$client` is already in scope via `$runtime->getClient($ctx->clientId)`

### KickController — kick event

- **Location:** `lib/WebSocket/Admin/KickController.php`
- **Relevance:** Emits `client_kicked` with `data['clientId']` — updated to `data['nickname']` using the `ClientConnection` object
- **Key patterns:** `$runtime->getClient($clientId)` check on line 50 already retrieves the client

### Tick — tombstone expiry

- **Location:** `lib/WebSocket/Tick.php`
- **Relevance:** Calls `pruneExpiredTombstones()` and emits `client_left` per dropped client; needs `ClientConnection` return type to access `->nickname`

### PresenceController — REST serialization

- **Location:** `lib/WebSocket/Admin/PresenceController.php`
- **Relevance:** `serializeRuntime()` builds the per-client JSON for the admin presence endpoint; `nickname` is added here

### RoomEventLog.vue — event log display

- **Location:** `src/components/RoomEventLog.vue`
- **Relevance:** `actorLabel()` function truncates client actorId to 8 chars; detail rows for `client_joined`/`client_left`/`client_kicked` reference `event.data?.clientId` — both updated for nicknames
