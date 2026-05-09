# References for Room Creation & Management

## Legacy API surface (to port partially)

### OLD_CODE Rooms HTTP API

- **Location:** [OLD_CODE/server/docs/ROOMS_API.md](../../../OLD_CODE/server/docs/ROOMS_API.md)
- **Relevance:** Defines the endpoint shapes (create/list/get/delete) and response fields (`roomId`, `password`, `shareLink`, `targetUrl`, `name`, `expiresAt`) we are mirroring in the Nextcloud `RoomController`.
- **Key patterns to borrow:** UUID v4 IDs, 16-char auto-generated password returned once, password never re-derivable, expired rooms surface as `404 Not Found`.

### OLD_CODE base technical design

- **Location:** [OLD_CODE/docs/base_design_v1.md](../../../OLD_CODE/docs/base_design_v1.md)
- **Relevance:** Background on the room/playback-state model. The MVP omits `last_state` — added when the WebSocket sync server lands.

## Nextcloud app patterns to mirror

### user_status — Entity + Mapper

- **Location:** `server/apps/user_status/lib/Db/UserStatus.php` and `UserStatusMapper.php`
- **Relevance:** Cleanest small example of `Entity` + `QBMapper<T>` in core Nextcloud apps.
- **Key patterns:** Public typed properties, `addType()` calls in the entity constructor for INTEGER/BOOLEAN/STRING coercion, fluent `$this->db->getQueryBuilder()` queries in the mapper, `findEntity()` / `findEntities()` for hydration.

### user_status — Migration

- **Location:** `server/apps/user_status/lib/Migration/Version0001Date20200602134824.php`
- **Relevance:** Representative `SimpleMigrationStep` that creates a table.
- **Key patterns:** `changeSchema()` returning `$schema`, `createTable()`, `addColumn()` with `Types::*`, `setPrimaryKey()`, `addUniqueIndex()` / `addIndex()`.

### user_status — Controller

- **Location:** `server/apps/user_status/lib/Controller/UserStatusController.php`
- **Relevance:** Modern Nextcloud controller pattern.
- **Key patterns:** Constructor DI of `?string $userId` for current user, `#[NoAdminRequired]` / `#[NoCSRFRequired]` PHP attributes, `DataResponse` return values, throwing `OCSBadRequestException` etc. for error cases. We will use `Controller` (not `OCSController`) and return `DataResponse` with explicit `Http::STATUS_*` codes since the API is internal-only.

### twofactor_backupcodes — Password hashing

- **Location:** `server/apps/twofactor_backupcodes/lib/Service/BackupCodeStorage.php`
- **Relevance:** Demonstrates `OCP\Security\IHasher` usage in a Nextcloud app.
- **Key patterns:** `$hasher->hash($plain)` to store, `$hasher->verify($plain, $stored)` for later verification. No manual HMAC needed; bcrypt is built in.

### settings — Pinia store

- **Location:** `server/apps/settings/src/store/apps-store.ts`
- **Relevance:** Reference shape for a Pinia store backing a CRUD list view.
- **Key patterns:** `defineStore('name', { state, actions })`, axios + `generateUrl()` calls inside actions, loading flag, `$patch` for state updates.

### Frontend HTTP pattern

- **Location:** `server/apps/dav/src/service/PreferenceService.ts` (representative)
- **Key patterns:** `axios.post(generateUrl('/apps/<app>/api/...'), payload)` for app-internal endpoints; `generateOcsUrl(...)` only when calling the OCS API.

## Routes

### Modern array-form routes file

- **Location:** `server/apps/cloud_federation_api/appinfo/routes.php`
- **Relevance:** Example of `['routes' => [...]]` with REST verbs, URL parameters, and `requirements`. The `playbacksync` app already uses this style for `page#index` — we extend the array.

## Product context

- **Mission:** [agent-os/product/mission.md](../../product/mission.md)
- **Roadmap:** [agent-os/product/roadmap.md](../../product/roadmap.md) — this feature is the foundational item in Phase 1 MVP.
- **Tech stack:** [agent-os/product/tech-stack.md](../../product/tech-stack.md)
