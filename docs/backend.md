# Backend

The PHP backend lives entirely under [`lib/`](../lib/) and follows the standard Nextcloud app conventions. It is split into the layers you'd expect — application bootstrap, database, services, controllers, background jobs — and this document walks through each one in the order a request would touch them. If you want the bird's-eye view of how those layers interact, [architecture.md](architecture.md) is a better starting point; this document is a tour through the pieces themselves.

## Application bootstrap

The entry point for every PHP request that touches the app goes through [`lib/AppInfo/Application.php`](../lib/AppInfo/Application.php). This class extends `OCP\AppFramework\App` and implements `IBootstrap`, which is Nextcloud's modern lifecycle interface — `register()` runs once per request to wire up services in the DI container, and `boot()` runs after all apps have registered, in case you need to interact with another app's container.

The most important thing to notice is the `APP_ID` constant. Every place in the codebase that needs to refer to "the app" — the routes file, the migration, the prune job, the controllers, the `IAppConfig` keys — uses `Application::APP_ID` rather than a hard-coded string. That's deliberate: it means if we ever rename the app slug (which would be a non-trivial undertaking, but still possible) we change one constant rather than grepping through the codebase.

The bootstrap class is intentionally short. Most apps grow a `register()` method full of `$context->registerService(...)` calls, but Nextcloud's autowiring container can resolve our services from their constructor signatures without any explicit registration, so we don't need them. The background job is registered through `appinfo/info.xml` rather than imperatively, which means even the prune job stays out of `Application.php`.

## The data model

The schema is defined by a single migration at [`lib/Migration/Version0001Date20260509120000.php`](../lib/Migration/Version0001Date20260509120000.php). It creates one table — `oc_playbacksync_rooms` — and three indexes. The structure is small and deliberate: every column there earns its place.

| Column           | Type           | Null | Default | Notes                                                                                                |
|------------------|----------------|------|---------|------------------------------------------------------------------------------------------------------|
| `id`             | `BIGINT` PK    | No   | auto    | Internal surrogate key. Never exposed externally; we always reference rooms by `uuid`.               |
| `uuid`           | `VARCHAR(36)`  | No   | —       | Public room identifier (UUID v4). Has a unique index — every API call looks up by this column.       |
| `owner_user_id`  | `VARCHAR(64)`  | No   | —       | Nextcloud user ID of the creator. Indexed for the "list my rooms" query.                             |
| `name`           | `VARCHAR(100)` | Yes  | `NULL`  | Optional human-friendly nickname.                                                                    |
| `target_url`     | `LONGTEXT`     | No   | —       | URL participants will eventually be redirected to.                                                   |
| `password_hash`  | `VARCHAR(255)` | No   | —       | `IHasher->hash()` output (currently `argon2id`). Never the plaintext.                                |
| `created_at`     | `BIGINT`       | No   | —       | Unix milliseconds at insert time.                                                                    |
| `expires_at`     | `BIGINT`       | No   | —       | Unix milliseconds when the room becomes invalid. Indexed for the prune job and read-side filtering.  |

The three indexes the migration declares — `playbacksync_rooms_uuid_ix` (unique on `uuid`), `playbacksync_rooms_owner_ix` (on `owner_user_id`), `playbacksync_rooms_exp_ix` (on `expires_at`) — directly correspond to the three queries the mapper exposes. There is one index per query path, no extras and no redundancies.

The `id` column is the standard auto-incrementing surrogate key that Nextcloud's mappers expect. We never expose this number to anything external — it lives purely as the row identity inside the database. The `uuid` column is the public identifier we use everywhere else: in URLs, in API responses, in share links. It has a unique index because we look rooms up by UUID on every API call.

The `owner_user_id` column stores a Nextcloud user ID, which is a string up to 64 characters. It has its own non-unique index, which is what makes the "list my rooms" query fast: the controller filters by `owner_user_id` and `expires_at > now`, and the index satisfies the first half of that filter cheaply. The `expires_at` column also has its own index, which the prune job uses to find expired rows in O(log n) time even on a hypothetically-large table.

The `password_hash` column is a 255-character string holding the output of `IHasher->hash()`, which today produces an `argon2id`-prefixed string something like `3|$argon2id$v=19$m=65536,t=4,p=1$...`. The exact format will vary as Nextcloud rotates default hash algorithms — that's fine; `IHasher->verify()` knows how to read all the historical formats and will rehash on verify if needed. We never store the plaintext password and the migration deliberately does not include a `last_state` column for the playback state; that gets added in the Phase 2 migration, when the WebSocket sync server actually has something to write there.

The `created_at` and `expires_at` columns are unsigned 64-bit integers holding **unix milliseconds**, not seconds. That choice keeps us symmetric with the JavaScript side, where `Date.now()` returns milliseconds and where sub-second precision is occasionally useful. Every PHP-side time computation multiplies `time()` by 1000 to get into milliseconds before reading or writing these fields.

## Entity and mapper

[`lib/Db/Room.php`](../lib/Db/Room.php) is the typed entity that the mapper hydrates from the database. It extends `OCP\AppFramework\Db\Entity`, which gives us automatic getter/setter generation, dirty-field tracking, and primary-key handling for free. The class itself is mostly a list of public properties annotated with `@method` PHPDoc hints so that a typical IDE can understand `$room->getUuid()` and `$room->setExpiresAt(123)` even though those methods aren't physically declared in the class. Those PHPDoc hints aren't decorative — they're the only way the IDE and static analyzers know which methods exist — so when you add a new column, remember to add the `@method get/set` pair too.

The constructor calls `addType()` for every column whose type is not "string", which is how the entity tells Nextcloud's hydration code to coerce strings into integers when reading from the database. SQLite, MariaDB, and PostgreSQL all return numeric columns as strings to PHP unless you ask, and `addType('createdAt', Types::BIGINT)` is what makes `getCreatedAt()` actually return an `int`.

[`lib/Db/RoomMapper.php`](../lib/Db/RoomMapper.php) extends `QBMapper<Room>`. It exposes three named queries that match the three things any layer above it might want to do, and nothing else. The mapper is deliberately small — there are no generic CRUD methods because no caller in the app needs them. If a future feature needs a new query, it gets added here as a named method rather than callers reaching into the query builder themselves.

| Method                                      | Returns      | Used by                                  | Behavior                                                                                          |
|---------------------------------------------|--------------|------------------------------------------|---------------------------------------------------------------------------------------------------|
| `findByUuid(string $uuid)`                  | `Room`       | `RoomService::getOwnedRoom`              | Single-row lookup by `uuid`. Throws `DoesNotExistException` when no row matches.                 |
| `findActiveByOwner(string $userId, int $now)` | `Room[]`   | `RoomService::listForOwner`              | Filters by `owner_user_id = ?` AND `expires_at > ?`, ordered `created_at DESC`.                  |
| `deleteExpired(int $now)`                   | `int`        | `PruneExpiredRoomsJob::run`              | Bulk `DELETE WHERE expires_at <= ?`. Returns the number of rows removed.                         |

`findByUuid` throws `DoesNotExistException` rather than returning `null` because that's the convention `QBMapper` ships with; the service layer catches it and rewraps into `RoomNotFoundException` so HTTP-layer code never has to know about Nextcloud's DB exceptions. `findActiveByOwner`'s read-side filter on `expires_at > $now` is what keeps expired rows out of the listing even when the prune job hasn't yet run — users never see expired rooms in their UI regardless of the prune cadence.

## The domain service

[`lib/Service/RoomService.php`](../lib/Service/RoomService.php) is where the actual business logic lives. The controller is a thin HTTP shell on top of it, and almost every interesting policy decision is implemented here. The reason for putting policy in a service rather than directly in the controller is that it keeps the rules in one place: if you want to know what a "room" is allowed to be, you read this file.

`createRoom` is the most involved method. It enforces the admin-only restriction (delegating to `assertCanCreate`), validates the target URL and the optional name, normalizes the TTL against the configured default and maximum, and only then generates a fresh UUID and password and persists the row. The plaintext password is generated with `random_int` against a 62-character alphanumeric alphabet, which gives a search space comfortably larger than $62^{16}$ — more than enough entropy for a small-trusted-group threat model. The UUID is a v4 generated from `random_bytes(16)` with the version-4 and variant-10 bits masked in by hand. We could pull in a UUID library, but the few lines it would save aren't worth a new dependency.

`getOwnedRoom` is the choke point for "the user wants to look at room X". Two failure modes funnel into the same `RoomNotFoundException`: the room genuinely doesn't exist, *or* the room exists but is owned by somebody else, *or* the room is past its expiry. All three look identical to the API caller — a 404 with a friendly message. That is intentional: returning a 403 for "this room exists but isn't yours" would leak the existence of someone else's room to a probing attacker, and there is nothing useful the user can do with that information anyway.

`assertCanCreate` is the admin-restriction toggle. By default any logged-in user can create rooms. If an admin has set the `restrict_to_admins` `IAppConfig` key to `'true'`, the service consults `IGroupManager->isAdmin($userId)` and throws `CreateRestrictedException` for anybody who isn't. This is the only place in the codebase that knows about the toggle, which is what makes it easy to change the policy later (per-group restrictions, per-user quotas, etc.) without touching the rest of the code.

The TTL handling is worth flagging because it interacts with admin config. The `default_ttl_seconds` and `MAX_TTL_SECONDS` constants live in this file (24 hours each, by default), but the *actual* default used for a request can be overridden by an admin via `IAppConfig`. The service guards against a misconfigured admin overriding the default to something nonsensical (zero, negative, longer than the maximum) by falling back to the constant if the configured value is out of range.

## The controller

[`lib/Controller/RoomController.php`](../lib/Controller/RoomController.php) is a plain `OCP\AppFramework\Controller` — not an `OCSController` — because the API is consumed exclusively by our own frontend, and the OCS envelope (`<ocs><meta>...</meta><data>...</data></ocs>`) would be pure overhead. We return `DataResponse` objects with explicit HTTP status codes and let `axios` and the Pinia store make sense of them client-side.

Every method has the `#[NoAdminRequired]` PHP attribute, which tells Nextcloud's middleware to allow non-admin users to call the endpoint. The admin-only restriction (when enabled) is enforced inside the service rather than at the route level, because it depends on the runtime value of an `IAppConfig` key — something the route-level attribute mechanism doesn't have access to.

The `?string $userId` parameter in the constructor is auto-injected by Nextcloud's DI container and reflects the currently-authenticated user. It is `null` for unauthenticated requests, which is why every method has an early `if ($this->userId === null)` guard returning 401. The `[NoAdminRequired]` attribute does not imply "logged in" — it implies "doesn't require admin" — so we need that explicit check.

Domain exceptions thrown by the service are caught at the controller boundary and translated into the appropriate HTTP responses. The mapping is one-to-one and lives entirely in the controller's `catch` blocks:

| Exception                       | HTTP status         | When it fires                                                                          |
|---------------------------------|---------------------|----------------------------------------------------------------------------------------|
| `RoomNotFoundException`         | `404 Not Found`     | UUID unknown, room past `expires_at`, or room owned by a different user.               |
| `CreateRestrictedException`     | `403 Forbidden`     | `restrict_to_admins` is on and the caller is not an admin. Only `POST /rooms` raises.  |
| `InvalidRoomInputException`     | `400 Bad Request`   | `targetUrl` invalid, `name` too long, `ttl` out of range. Only `POST /rooms` raises.   |
| (caller is unauthenticated)     | `401 Unauthorized`  | Guarded directly in each method via `if ($this->userId === null)`; no exception used.  |

The error message in the response body comes straight from the exception, which is fine because every domain exception is constructed with a message the user can safely see (no internals, no SQL, no stack traces).

The `serializeRoom` helper at the bottom of the controller is the contract between the backend and the frontend. It picks the fields we want to expose and renames `passwordHash` to nothing (we never expose it) and computes the `shareLink`. When you add a new column, this is where you decide whether the frontend gets to see it.

## Routes

[`appinfo/routes.php`](../appinfo/routes.php) wires URL patterns to controller methods using Nextcloud's traditional array form. The four API endpoints — index, show, create, destroy — sit alongside the single page route. Nextcloud takes the route names like `room#index` and resolves them to the `RoomController::index` method automatically by stripping the controller suffix and lowercasing.

We use the array form rather than the newer attribute-based `#[ApiRoute]` style for one practical reason: the existing `page#index` route is in this file, and keeping the API routes adjacent to the page route makes the routing surface easier to scan. Mixing the two styles is supported but ugly, and we don't gain anything from the attribute form for an internal API.

## The background job

[`lib/BackgroundJob/PruneExpiredRoomsJob.php`](../lib/BackgroundJob/PruneExpiredRoomsJob.php) extends `OCP\BackgroundJob\TimedJob` and runs hourly. Its entire body is a one-liner that asks the mapper to delete every row where `expires_at <= now`. The hourly interval is set in the constructor via `setInterval(3600)`. Nextcloud's job runner takes care of scheduling and concurrency.

The job is registered with Nextcloud through the `<background-jobs>` block in [`appinfo/info.xml`](../appinfo/info.xml). When the app is enabled, Nextcloud reads that block and adds the job to the `oc_jobs` table; when the app is disabled, the job is removed. There is no manual registration code in `Application::register()`, which is the cleanest way to do it: the job's lifecycle exactly tracks the app's lifecycle.

The reason the prune logic lives in a background job rather than being run inline (e.g. on every list request) is that the database does not need help managing its own row count for a small-trusted-group app. Running it hourly is cheap, runs entirely server-side without any user-visible latency, and makes the logic testable in isolation. If somebody disables the cron worker entirely, the worst case is the table grows by however many rooms get created in the meantime — annoying, but not broken: the `findActiveByOwner` query still filters by `expires_at > now`, so users never see expired rows even if they're physically still in the database.
