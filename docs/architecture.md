# Architecture

PlaybackSync is structured as a fairly conventional Nextcloud app: a PHP backend that lives under `lib/`, a Vue 3 single-page application that lives under `src/`, a Nextcloud-rendered HTML shell that bridges the two, and a thin database table where the app's domain state lives. Everything else — authentication, sessions, CSRF tokens, navigation chrome, the dark-mode-aware design tokens — is provided by Nextcloud itself, which is one of the main reasons the app is built as a Nextcloud integration rather than as a standalone service.

## The big picture, end to end

When a logged-in user opens the app from the Nextcloud navigation, the browser hits a single PHP route (`GET /apps/playbacksync/`) which is handled by `PageController::index`. That controller does almost nothing: it tells Nextcloud to enqueue the compiled Vue bundle and returns the empty `templates/index.php` template, which is little more than a `<div id="playbacksync-root">` element wrapped inside Nextcloud's standard chrome. The Nextcloud server does the rest of the page assembly, injecting the navigation top bar, the user menu, the search, the dark-themed background, and the script tag for our bundle.

Once the page reaches the browser, the Vue bundle takes over. It mounts on `#playbacksync-root` and immediately renders `App.vue`, which is just a thin frame that hands the entire content area over to `RoomsPanel`. From this point on, the app is a single-page experience that talks back to PHP only over the JSON REST API at `/apps/playbacksync/api/v1/rooms`. There is no second page, no router, and no fragment routes — the dashboard *is* the app.

When the user creates a room, the flow walks through every layer on both sides exactly once. Tracing it in order:

| Step | Layer                | Code                                               | What happens                                                                                  |
|------|----------------------|----------------------------------------------------|-----------------------------------------------------------------------------------------------|
| 1    | UI (component)       | `RoomCreateDialog.vue`                             | User fills the form and clicks **Create**; the component dispatches `roomsStore.create(...)`. |
| 2    | Pinia store          | `src/stores/rooms.ts`                              | The action sets `creating = true` and calls `roomsApi.createRoom(payload)`.                    |
| 3    | API service          | `src/services/roomsApi.ts`                         | Builds the URL via `generateUrl`, fires `axios.post(...)` with the JSON payload.               |
| 4    | HTTP                 | Nextcloud router                                   | Routes `POST /apps/playbacksync/api/v1/rooms` to `RoomController::create`.                     |
| 5    | Controller           | `lib/Controller/RoomController.php`                | Authentication check, parameter parsing, calls `RoomService::createRoom(...)`.                 |
| 6    | Service              | `lib/Service/RoomService.php`                      | Admin gate, validation, UUID + password generation, hashing via `IHasher`, persists via mapper.|
| 7    | Mapper               | `lib/Db/RoomMapper.php` (`QBMapper<Room>`)         | `INSERT INTO oc_playbacksync_rooms ...`.                                                        |
| 8    | Service              | back in `RoomService::createRoom`                  | Returns `[room: Room, plainPassword: string]` to the controller.                                |
| 9    | Controller           | back in `RoomController::create`                   | Serializes the room, attaches the one-time `password`, returns `DataResponse(...) 201`.         |
| 10   | Pinia store          | back in `rooms.ts`                                 | Prepends the new room to `rooms`, sets `lastCreated` (with password) for the password dialog.    |
| 11   | UI (component)       | `RoomCreatedDialog.vue`                            | Watches `lastCreated`, opens, shows password + share link with copy buttons.                    |

The plaintext password exists only in steps 6 → 9 → 10 → 11. It is never stored, never logged, and never returned again on any subsequent call.

Deletes and lists work the same way, just shorter: controller → service → mapper → DB. There is no caching layer on either side: we lean on Nextcloud's database connection pool and the relatively low traffic the app sees (a friend group is not a high-load workload).

## Why a Nextcloud app instead of a standalone service

The legacy implementation under [`OLD_CODE/`](../OLD_CODE/) was a standalone Node.js service. That worked, but it forced anyone who wanted to use PlaybackSync to provision a separate domain, set up TLS, configure an external auth proxy, and somehow share credentials with their friends. The Nextcloud-app rewrite trades a little flexibility (you have to be on Nextcloud) for a lot of operational simplicity: the people who would actually use this app are already running Nextcloud, already have their friends' accounts on it, and already have TLS, sessions, and an admin UI in place. Building on top of that platform means we get to focus on the actual problem — synchronized playback — and skip the infrastructure most users would otherwise have to recreate from scratch.

There is one consequence of that choice that shapes the rest of the architecture: PHP, unlike Node, has no long-running process. Each HTTP request is a fresh PHP-FPM worker that lives only as long as the request, so we cannot keep an in-memory map of rooms the way the legacy server did. Persistent state has to live in the database, full stop. That is why the rooms table exists at all, and why the WebSocket sync server (when it lands) will run as a separate long-running process that is *registered with* the Nextcloud app rather than embedded in it.

## Layer responsibilities

The PHP backend is split into the conventional Nextcloud layers, each with a clear remit. The **controller layer** under `lib/Controller/` is responsible for HTTP plumbing only — parameter parsing, status codes, response shape, and translating domain exceptions into HTTP errors. It deliberately contains no business logic. The **service layer** under `lib/Service/` owns everything that is interesting: room creation, password generation, ownership rules, the admin-restriction toggle, and TTL enforcement. If a question is "should a non-admin be allowed to create a room here?" or "what happens if the TTL is too long?", the answer is in the service. The **mapper layer** under `lib/Db/` is the only code that talks to the database and is structured around `QBMapper<Room>`. It exposes a small handful of named queries (find by UUID, find active rooms for owner, delete expired) and otherwise stays out of the way. The **background job** under `lib/BackgroundJob/` is a different shape but plays in the same band: it runs on the Nextcloud cron schedule, calls into the mapper to delete expired rows, and never touches HTTP.

The Vue frontend mirrors this layering deliberately. Components stay presentational/orchestrational; the Pinia store owns runtime state; a thin API service is the only place that speaks HTTP.

| Side     | Layer                                | Folder                          | What it owns                                                                          | What it does **not** do                                                |
|----------|--------------------------------------|---------------------------------|---------------------------------------------------------------------------------------|------------------------------------------------------------------------|
| Backend  | Controllers                          | [`lib/Controller/`](../lib/Controller/) | HTTP parsing, status codes, response shape, exception → status mapping.            | Business logic, DB access, validation rules.                            |
| Backend  | Services                             | [`lib/Service/`](../lib/Service/)       | Domain rules: ownership, TTL, password/UUID generation, admin toggle.              | HTTP, JSON, DB query construction.                                      |
| Backend  | Mappers (`QBMapper<Room>`)           | [`lib/Db/`](../lib/Db/)                 | The three named queries the app actually uses.                                     | Generic CRUD callers can reach into; HTTP semantics; domain rules.      |
| Backend  | Background jobs                      | [`lib/BackgroundJob/`](../lib/BackgroundJob/) | Hourly prune of expired rows. Registered via `appinfo/info.xml`.              | HTTP-bound work; user-visible state; anything that needs a request.     |
| Frontend | Components                           | [`src/components/`](../src/components/) | Rendering, form input collection, dialog orchestration.                            | Calling axios directly; constructing API URLs; cross-component state.   |
| Frontend | Pinia store                          | [`src/stores/`](../src/stores/)         | Rooms array, loading flags, optimistic updates, `lastCreated` lifecycle.            | DOM rendering; URL construction.                                        |
| Frontend | API services                         | [`src/services/`](../src/services/)     | Typed wrappers around `axios` + `generateUrl`. Single point of HTTP contact.        | UI logic; storing data; orchestrating dialogs.                          |

## Where the WebSocket server will plug in (forward-looking)

Phase 2 of the roadmap introduces a long-running WebSocket service that will coordinate playback events between participants. Because PHP cannot host a persistent socket process, that service will live as its own daemon — most likely a small Node process or a PHP CLI runner — and connect to the same `oc_playbacksync_rooms` table to validate join attempts. The current `password_hash` column is already shaped for that: when a participant tries to connect with a (room UUID, password) pair, the WebSocket server will verify the password using the same `IHasher` API the create flow used to store it.

Concretely, the only schema change Phase 2 will require is adding a `last_state` column for the cached playback position. Everything else — ownership, expiry, the prune job — already does the right thing.

## Where Phase 3's browser extension will plug in

The browser extension does not need to talk to PHP at all once the WebSocket server exists; it talks straight to the WebSocket coordinator. It does need a way to *get into* a room, though, which is what the share link (`shareLink` field in the API response) is for. In the MVP that link is a placeholder, but Phase 3 will add a thin public PHP endpoint at `/apps/playbacksync/r/{uuid}` that does Basic Auth against the room password, then redirects to the room's `bootstrapUrl` (the share-link redirect target, distinct from each playlist entry's per-video `pageUrl`) with the WebSocket URL and the password attached as query parameters. The extension watches for those parameters, stores them, and connects to the WebSocket server. The legacy implementation's [`OLD_CODE/server/docs/ROOMS_API.md`](../OLD_CODE/server/docs/ROOMS_API.md) describes this flow in full and is the design intent we're working toward.

## Data flow summary

To summarize the MVP flows in plain English: creating a room is a single POST that writes one row and returns one (one-time) password. Listing rooms is a GET filtered by `owner_user_id` and a `expires_at > now` predicate, so each user only ever sees their own non-expired rooms. Deleting a room is a hard DELETE on the row, gated by ownership. Expired rows are mopped up an hour at a time by the background job — even if nobody ever lists or deletes anything, the table will not grow unboundedly. There is no shared state across requests; the only state that survives between requests lives in the database table. That is the entirety of the architecture today, and it is small on purpose.
