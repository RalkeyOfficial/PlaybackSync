# PlaybackSync — Room Creation & Management (MVP)

## Context

PlaybackSync is being rebuilt from a standalone Node.js service (now archived under `OLD_CODE/`) into a native Nextcloud app. The current codebase is a skeleton: a single `PageController` rendering an empty Vue shell, no DB layer, no domain logic.

This spec shapes the **first MVP feature**: owner-only **Room creation, listing, and deletion** via the Nextcloud UI. The participant join flow (share URL + password gate) is intentionally **deferred** until the WebSocket sync server lands — there is no point in joining a room that can't sync anything yet. `targetUrl` is stored from day one to avoid a future migration.

Outcome: A logged-in Nextcloud user (subject to an admin-toggleable restriction) can create a room, see it listed, copy a one-time password and share link, and delete it. Rooms persist in the Nextcloud DB and expire by TTL (max 24h).

---

## Decisions

- **Persistence:** Nextcloud DB table `oc_playbacksync_rooms` (not in-memory — PHP has no long-running process).
- **Permissions:** Any logged-in user can create rooms by default; admin can restrict to admins-only via `IAppConfig` key.
- **Passwords:** Auto-generated 16-char alphanumeric, hashed via `OCP\Security\IHasher` (bcrypt). Plaintext returned **once** on creation, never persisted, never re-derivable.
- **TTL:** Default 24h, max 24h. Owner can pick shorter at creation.
- **Share flow:** Deferred. The MVP returns a `shareLink` string for display/copy, but no public join endpoint is built yet.
- **API style:** Plain `Controller` returning `DataResponse` (consumed only by this app's own frontend; OCS envelope unnecessary).
- **Cleanup:** Expired rooms pruned by a `TimedJob` background job; controllers also filter out expired rows on read.

---

## Critical Files

### To create

**Backend (PHP):**
- [lib/Migration/Version000000Date20260509XXXX.php](lib/Migration/) — creates `oc_playbacksync_rooms` table
- [lib/Db/Room.php](lib/Db/) — Entity (`extends OCP\AppFramework\Db\Entity`)
- [lib/Db/RoomMapper.php](lib/Db/) — `extends QBMapper<Room>`
- [lib/Service/RoomService.php](lib/Service/) — domain logic: UUID + password generation, hashing, ownership checks, expiration filtering
- [lib/Service/Exceptions/](lib/Service/Exceptions/) — `RoomNotFoundException`, `RoomAccessDeniedException`, `CreateRestrictedException`
- [lib/Controller/RoomController.php](lib/Controller/) — `Controller` with `index/show/create/destroy`
- [lib/BackgroundJob/PruneExpiredRoomsJob.php](lib/BackgroundJob/) — `extends TimedJob`, runs hourly

**Frontend (Vue 3 + Pinia + TypeScript):**
- [src/services/roomsApi.ts](src/services/) — typed axios wrapper using `generateUrl`
- [src/stores/rooms.ts](src/stores/) — Pinia store
- [src/types/room.ts](src/types/) — `Room`, `CreateRoomPayload`, `CreatedRoom` types
- [src/components/RoomsPanel.vue](src/components/) — main panel: list + create button (mounted directly inside `App.vue`'s `NcAppContent`)
- [src/components/RoomList.vue](src/components/) — list of rooms
- [src/components/RoomCreateDialog.vue](src/components/) — `NcDialog` form (name, TTL, targetUrl)
- [src/components/RoomCreatedDialog.vue](src/components/) — `NcDialog` showing one-time password + share link with copy buttons

### To modify

- [lib/AppInfo/Application.php](lib/AppInfo/Application.php) — add `APP_ID` constant; register `PruneExpiredRoomsJob` in `register()`
- [appinfo/routes.php](appinfo/routes.php) — add API routes (see below)
- [appinfo/info.xml](appinfo/info.xml) — add `<background-jobs>` registration; bump version to `0.2.0`
- [src/App.vue](src/App.vue) — replace `NcEmptyContent` with `<RoomsPanel />`; remove the `:to` prop on the nav item (single-page app, no router)
- [l10n/en.js](l10n/en.js) and [l10n/nl.js](l10n/nl.js) — add new keys

---

## API Surface

All routes prefixed `/apps/playbacksync/api/v1/`.

| Verb | URL | Controller method | Returns |
|------|-----|-------------------|---------|
| POST | `/rooms` | `create` | `201` `{ uuid, password, shareLink, name, targetUrl, createdAt, expiresAt }` (password returned **once**) |
| GET | `/rooms` | `index` | `200` `{ rooms: Room[] }` (current user's non-expired rooms) |
| GET | `/rooms/{uuid}` | `show` | `200` Room (owner-only) |
| DELETE | `/rooms/{uuid}` | `destroy` | `204` |

Validation: `targetUrl` must be a valid http(s) URL; `ttl` (seconds) ≤ 86400 if provided; `name` max 100 chars. Errors return `DataResponse` with `Http::STATUS_*` and `{ error: string }`.

---

## DB Schema (`oc_playbacksync_rooms`)

| Column | Type | Notes |
|--------|------|-------|
| `id` | BIGINT autoinc PK | |
| `uuid` | string(36), unique | external identifier |
| `owner_user_id` | string(64), indexed | Nextcloud uid |
| `name` | string(100), nullable | optional nickname |
| `target_url` | text | required at MVP |
| `password_hash` | string(255) | `IHasher->hash()` output |
| `created_at` | BIGINT | unix ms |
| `expires_at` | BIGINT, indexed | unix ms; used by prune job and read filters |

Indexes: `uuid` unique; `owner_user_id`; `expires_at`.

`last_state` (playback state JSON) is **not** added now — added in a later migration when the WebSocket sync server lands. Avoids storing an unused column.

---

## App Config Keys (`IAppConfig`)

| Key | Default | Meaning |
|-----|---------|---------|
| `restrict_to_admins` | `'false'` | If `'true'`, only admins can create rooms |
| `default_ttl_seconds` | `'86400'` | Default TTL when client omits `ttl` |

Admin settings UI is **out of scope for MVP** — admins set via `occ config:app:set playbacksync restrict_to_admins --value true` for now. Note this in the controller task.

---

## Reused Patterns / Utilities

- **Entity + Mapper:** mirrors [server/apps/user_status/lib/Db/UserStatus.php](../../apps/user_status/lib/Db/UserStatus.php) and [UserStatusMapper.php](../../apps/user_status/lib/Db/UserStatusMapper.php).
- **Migration:** mirrors [Version0001Date20200602134824.php](../../apps/user_status/lib/Migration/Version0001Date20200602134824.php).
- **Controller:** mirrors [UserStatusController.php](../../apps/user_status/lib/Controller/UserStatusController.php) — DI of `?string $userId`, attribute-based annotations.
- **Password hashing:** `OCP\Security\IHasher` — `hash()` / `verify()`. Pattern from [twofactor_backupcodes BackupCodeStorage](../../apps/twofactor_backupcodes/lib/Service/BackupCodeStorage.php).
- **Pinia + axios:** [settings/src/store/apps-store.ts](../../apps/settings/src/store/apps-store.ts) for store shape; `generateUrl('/apps/playbacksync/api/v1/rooms')` for endpoint URLs.
- **`@nextcloud/vue` components used:** `NcButton`, `NcDialog`, `NcTextField`, `NcSelect`, `NcListItem`, `NcEmptyContent`, `NcLoadingIcon`, `NcAppContent` (already imported).

---

## Standards Applied

- **backend/php-conventions** — `declare(strict_types=1)`, only `OCP\` imports, `APP_ID` constant in `Application`, attribute-based controller annotations.
- **frontend/vue-conventions** — `<script setup lang="ts">`, `t('playbacksync', ...)` for all strings, `vue-material-design-icons` for icons (`:size="20"` nav, `:size="64"` empty state), Pinia store under `src/stores/`, `<style scoped>` per SFC.

---

## Tasks

### Task 1 — Save spec documentation

Create `agent-os/specs/2026-05-09-1430-room-creation-management/` with:
- `plan.md` — copy of this plan
- `shape.md` — scope, decisions, and Q&A context from this session
- `standards.md` — full content of `backend/php-conventions.md` and `frontend/vue-conventions.md`
- `references.md` — pointers to OLD_CODE ROOMS_API and the user_status / settings / twofactor_backupcodes patterns
- `visuals/` — empty (none provided)

### Task 2 — Database layer

1. Create migration `lib/Migration/Version000200Date20260509XXXX.php` per schema above.
2. Create `lib/Db/Room.php` Entity with typed properties + `addType()` calls for INTEGER fields.
3. Create `lib/Db/RoomMapper.php` extending `QBMapper<Room>` with: `findByUuid(string $uuid)`, `findByOwner(string $userId, int $now)` (filters `expires_at > now`), `deleteExpired(int $now): int`.
4. Wire migration into Nextcloud's migration discovery (auto-detected from path; verify by enabling app).

### Task 3 — Domain service

Create `lib/Service/RoomService.php`:
- `createRoom(string $userId, string $targetUrl, ?string $name, ?int $ttl): array{room: Room, plainPassword: string}` — generates UUID v4, generates 16-char password (alphanumeric, cryptographically random via `random_int`), hashes via `IHasher`, enforces TTL ≤ 86400, applies default from `IAppConfig`.
- `listForOwner(string $userId): Room[]` — delegates to mapper.
- `getOwnedRoom(string $userId, string $uuid): Room` — throws `RoomNotFoundException` (404) or `RoomAccessDeniedException` (403).
- `deleteOwnedRoom(string $userId, string $uuid): void`.
- `assertCanCreate(string $userId): void` — throws `CreateRestrictedException` if `restrict_to_admins=true` and user is not admin (`IGroupManager->isAdmin($userId)`).
- Pure domain exceptions under `lib/Service/Exceptions/`.

### Task 4 — HTTP API

1. Create `lib/Controller/RoomController.php`:
   - Constructor injects `string $appName`, `IRequest $request`, `?string $userId`, `RoomService $service`, `IURLGenerator $urlGenerator` (for share-link string).
   - `#[NoAdminRequired]` on every method (admin restriction enforced inside service).
   - Methods map to API table above; catch domain exceptions → return `DataResponse` with appropriate `Http::STATUS_*`.
   - `create()` returns the `shareLink` as `IURLGenerator->linkToRouteAbsolute('playbacksync.page.index') . '#/r/' . $uuid` (placeholder until share endpoint exists).
2. Add routes to `appinfo/routes.php` (modern array form, alongside existing `page#index`).
3. Add `APP_ID` constant to `Application.php`; register the prune background job.

### Task 5 — Background prune job

Create `lib/BackgroundJob/PruneExpiredRoomsJob.php` extending `OCP\BackgroundJob\TimedJob`:
- Interval: 3600s (hourly).
- Calls `RoomMapper->deleteExpired(time() * 1000)`.
- Register in `Application::register()` via `IBootContext->getAppContainer()->get(IJobList::class)->add(...)` — or declare in `info.xml` `<background-jobs>` (preferred).

### Task 6 — Frontend types, service, and store

1. `src/types/room.ts` — `Room`, `CreateRoomPayload`, `CreatedRoom` (extends Room with `password: string`).
2. `src/services/roomsApi.ts` — `listRooms()`, `createRoom(payload)`, `deleteRoom(uuid)`. Each uses `axios` + `generateUrl('/apps/playbacksync/api/v1/...')`.
3. `src/stores/rooms.ts` — Pinia store: state `{ rooms, loading, lastCreated }`, actions `load`, `create` (stashes plaintext password in `lastCreated` for the creation dialog only — cleared on dismiss), `remove`. Use `@nextcloud/dialogs` `showError` on failure.

### Task 7 — Frontend UI

No router — the app is a single page. Components mount directly inside `App.vue`'s `NcAppContent`.

1. `src/components/RoomsPanel.vue` — loads rooms on mount via the store; renders `RoomList` when populated, `NcEmptyContent` otherwise. Top-bar "Create room" `NcButton` opens `RoomCreateDialog`. Watches `roomsStore.lastCreated` and renders `RoomCreatedDialog` when set.
2. `src/components/RoomList.vue` — renders rooms with name, expiry, delete button.
3. `src/components/RoomCreateDialog.vue` — form fields: name (optional), targetUrl (required, URL-validated), ttl (select: 1h / 6h / 12h / 24h). On submit calls `roomsStore.create(...)`.
4. `src/components/RoomCreatedDialog.vue` — opens when `lastCreated` is set; shows password + shareLink with `NcButton` copy actions; warns the password won't be shown again. Closes → clears `lastCreated`.
5. Update `src/App.vue` — replace `NcEmptyContent` placeholder with `<RoomsPanel />`; remove the `:to="{ name: 'rooms' }"` prop on the nav item (turn it into a non-link active item or drop the navigation rail entirely if it adds nothing — to be decided in implementation, default: keep as a static label).
6. Add l10n keys to `l10n/en.js` and `l10n/nl.js` for every new user-facing string.

### Task 8 — Manual end-to-end verification

Run inside the Nextcloud Docker workspace (per OLD_CODE convention: dev environment runs in containers):

1. `npm run dev` (or `npm run watch`) inside the app dir to build the bundle.
2. `occ app:enable playbacksync` — confirms the migration runs without error.
3. Open the app in a browser, log in as a non-admin user:
   - Create a room → confirm one-time password dialog displays password + copy button.
   - Reload page → password is no longer visible; room appears in list.
   - Delete room → list updates; refresh → still gone.
4. As admin: `occ config:app:set playbacksync restrict_to_admins --value true`. As non-admin: confirm create is rejected (403).
5. DB check: `occ db:execute "SELECT uuid, owner_user_id, password_hash FROM oc_playbacksync_rooms"` — verify `password_hash` is bcrypt-shaped and never the plaintext.
6. Force expiry: insert/edit a row with `expires_at < now`; run `occ background-job:execute <job-id>` for the prune job; row gone.
7. API safety: `curl` `GET /apps/playbacksync/api/v1/rooms/{uuid}` as a different logged-in user → 404 (not 403, to avoid existence disclosure).

---

## Out of Scope (explicitly deferred)

- Public share/join endpoint (`GET /r/{uuid}` with password gate)
- WebSocket sync server / drift correction
- `last_state` column (added with sync server)
- Admin settings UI panel (use `occ` for now)
- Browser extension integration
- Tests (no test infra exists yet; introduce when the suite scaffolding is added)
