# Configuration & Operations

This document covers everything that isn't strictly code: the admin-facing configuration toggles, the background-job machinery, the dev-environment workflow, and the bits of operational glue that make the app run inside a Nextcloud instance. If you're trying to figure out how to enable the app, set a config value, kick the cron job, or rebuild the frontend after an edit, this is the right place.

## Enabling and upgrading the app

The app lives in `apps-extra/playbacksync` inside the Nextcloud Docker dev environment, which means Nextcloud already knows it exists — it's mounted into the container as a normal app. To turn it on for the first time, or to re-run the migrations after a version bump:

```bash
docker exec -u www-data master-nextcloud-1 php /var/www/html/occ app:enable playbacksync
```

That command performs three pieces of work in one shot. It marks the app as enabled in the `oc_appconfig` table, it runs any pending database migrations defined under `lib/Migration/` whose version numbers haven't been recorded yet, and it registers the background jobs declared in `appinfo/info.xml` with the cron worker. There is no separate "install" step; enabling for the first time is the install.

When you bump the version number in [`appinfo/info.xml`](../appinfo/info.xml) (currently `0.2.0`), the next time the app is enabled or the next time `occ upgrade` is run, Nextcloud will detect the version change and re-run any new migrations. Migrations are versioned by their class name — `Version0001Date20260509120000` — and Nextcloud refuses to re-run a migration whose name already appears in the `oc_migrations` table, so an upgrade is always safe to run repeatedly.

To disable the app temporarily without losing data:

```bash
docker exec -u www-data master-nextcloud-1 php /var/www/html/occ app:disable playbacksync
```

Disabling does *not* delete the rooms table or any of its rows. The data is still there if you re-enable. If you genuinely want to wipe the slate clean, you have to drop the table by hand — there's no `app:remove` flow that does that for you.

## Admin configuration keys

The app's behaviour is tuned through Nextcloud's `IAppConfig` mechanism. Every value is editable two ways: from the **Administration settings → PlaybackSync** page (WebSocket tuning, daemon binding, room defaults, and the admin secret), or from the CLI with `occ config:app:*`. The daemon-binding and drift / rate-limit / tuning keys are documented in the operator guide's [Configuration keys](ws-sync-server.md#configuration-keys-iappconfig) table; this section covers the **room-behaviour** keys in depth.

Most keys are seeded on install by the `EnsureDefaultSettings` repair step, so a fresh install already has them present at their defaults (the "Default" column below). `freeform_auto_append_cap` is the exception — it isn't seeded; its default is applied at read time.

**When changes take effect.** Room-behaviour keys on the HTTP path (`restrict_to_admins`, the TTL bounds, `freeform_auto_append_cap`) are re-read per request, so they apply immediately. Daemon **tunables** (the `ws_*` timeouts / drift / rate limits, and `max_clients_per_room`) can be applied to the running daemon without a restart — saving them in admin settings triggers a reload, or send `SIGHUP` — see [Reloading config without a restart](ws-sync-server.md#reloading-config-without-a-restart). The binding keys (`ws_host`/`ws_port`/`ws_admin_*`), `ws_admin_secret`, and `ws_event_log_size` are the exceptions that need a full daemon restart.

| Key                        | Type     | Default                                   | Effect                                                                                                |
|----------------------------|----------|-------------------------------------------|-------------------------------------------------------------------------------------------------------|
| `restrict_to_admins`       | boolean  | `false`                                   | If `true`, only users in the `admin` group can call `POST /rooms`. Existing rooms are not affected.   |
| `default_ttl_seconds`      | integer  | `86400` (24 hours)                        | Default TTL applied when a `POST /rooms` request omits `ttl`. Clamped to `[1, max_ttl_seconds]`; out-of-range values silently fall back. |
| `max_ttl_seconds`          | integer  | `86400` (24 hours)                        | Upper bound a client may request via the `ttl` field on `POST /rooms`. A value `< 1` falls back to the `86400` service constant. |
| `max_clients_per_room`     | integer  | `50`                                      | Caps how many connected clients are listed in the daemon's admin **presence** payload for a room. Not a `JOIN` limit — it doesn't reject participants. |
| `freeform_auto_append_cap` | integer  | `100`                                     | Per-room maximum for the freeform auto-prune policy. See [`freeform_auto_append_cap`](#freeform_auto_append_cap) below. Clamped to `[1, 1000]`. |

### `restrict_to_admins`

This boolean flag controls who is allowed to *create* rooms. By default it is unset, which the service treats as `false`, and any logged-in Nextcloud user can create a room. When set to `'true'` (the string `'true'`, since `IAppConfig` values are strings), only users whose Nextcloud account is in the `admin` group can create rooms — non-admin users get an HTTP 403 with the message "Room creation is restricted to administrators."

Critically, the flag only gates *creation*. Existing rooms continue to be visible, listable, and deletable by their original owner regardless of whether the toggle is on. So a non-admin who created a room before the flag was flipped can still manage that room afterwards; they just can't make a new one.

To turn it on:

```bash
docker exec -u www-data master-nextcloud-1 php /var/www/html/occ config:app:set playbacksync restrict_to_admins --value true
```

To turn it off, you can either set it to `false` or delete the key entirely (both have the same effect):

```bash
docker exec -u www-data master-nextcloud-1 php /var/www/html/occ config:app:delete playbacksync restrict_to_admins
```

### `default_ttl_seconds`

This integer sets the default TTL applied when a `POST /rooms` request omits the `ttl` field. The hard-coded default in `RoomService::DEFAULT_TTL_SECONDS` is 86400 (24 hours), which is what's used if the key is unset. Admins can lower this — for example, to 3600 seconds for one-hour default rooms — if they want short-lived rooms to be the norm:

```bash
docker exec -u www-data master-nextcloud-1 php /var/www/html/occ config:app:set playbacksync default_ttl_seconds --value 3600
```

The service guards against nonsensical values (zero, negative, or longer than the effective `max_ttl_seconds`) by silently falling back to the hard-coded default. So if an admin accidentally sets `default_ttl_seconds` to `0` or above the maximum, the create endpoint still produces sensible 24-hour rooms (or the maximum, whichever is smaller); the misconfiguration is logged but doesn't break anything.

### `max_ttl_seconds`

This integer is the upper bound on what an end user can request via the `ttl` field on the create endpoint. It defaults to 24 hours (86400 seconds) — the `RoomService::MAX_TTL_SECONDS` constant, which is also the value seeded on install and the fallback used if the key is set to something `< 1`. Raise it for longer-lived rooms:

```bash
docker exec -u www-data master-nextcloud-1 php /var/www/html/occ config:app:set playbacksync max_ttl_seconds --value 604800
```

`default_ttl_seconds` is always clamped to this ceiling, so lowering `max_ttl_seconds` below the current default pulls the default down with it.

### `max_clients_per_room`

Despite the name, this does **not** cap room membership — the daemon does not currently reject a `JOIN` when a room is "full". It bounds how many connected clients the daemon includes in the per-room **presence** payload (the admin rooms list / detail view); `connectedCount` in that payload still reports the true total, so this only keeps the per-client array from growing unwieldy for a very large room. Defaults to `50`, seeded on install; the daemon reads it live off `WsConfig`, so a change applies on the next [config reload](ws-sync-server.md#reloading-config-without-a-restart) (or restart) — no need to bounce the process.

### `freeform_auto_append_cap`

This integer sets the per-room cap for the **freeform auto-prune** policy. Default mode rooms and single-mode rooms are unaffected — the key is read only when the freeform branch in `PlaylistService` fires.

In a freeform room, any connected client can jump to a new video and the server auto-appends it. Without a cap, movie-night rooms grow unbounded toward the global 1000-entry per-room cap. With the cap, every auto-append (or any other playlist growth via `merge()` while the room is in freeform mode) triggers a pruning pass that drops the oldest `auto_appended` entries first, until the playlist fits within the cap. Curated entries are never auto-dropped; the entry the cursor currently points at is also never auto-dropped, regardless of source.

If pruning can't bring the playlist back under cap because every remaining entry is either curated or the cursored entry, the offending mutation is rejected with `freeform_cap_full` instead of silently growing past the cap. The owner has to clear some entries (or promote auto-appended entries to curated and then back to auto-appended after editing) before more auto-appends can land.

The default is `100`. To raise it for a long-running room series, or lower it for stricter pruning:

```bash
docker exec -u www-data master-nextcloud-1 php /var/www/html/occ config:app:set playbacksync freeform_auto_append_cap --value 250
```

The value is clamped to the range `[1, 1000]` — the lower bound prevents a zero cap from making every auto-append fail, and the upper bound matches `PlaylistService::PER_ROOM_CAP` so freeform never exceeds the global ceiling. Values outside that range are silently clamped on read.

The cap is read on every relevant mutation via the `FreeformConfig` value object, so changes take effect on the next request — no daemon restart needed for the HTTP path. The WebSocket daemon does read it once at boot via the same factory, so an in-flight daemon picks up cap changes only after a restart (`occ playbacksync:ws-serve` is the typical entry point).

## Background jobs

The app declares one background job, [`PruneExpiredRoomsJob`](../lib/BackgroundJob/PruneExpiredRoomsJob.php), in the `<background-jobs>` section of [`appinfo/info.xml`](../appinfo/info.xml). When you enable the app, Nextcloud reads that section and adds the job to its global job list (the `oc_jobs` table). When you disable the app, the job is removed.

| Job                       | Interval | What it does                                                       | Idempotent? |
|---------------------------|----------|--------------------------------------------------------------------|-------------|
| `PruneExpiredRoomsJob`    | 3600 s   | `DELETE FROM oc_playbacksync_rooms WHERE expires_at <= now`        | Yes         |

You can list and inspect background jobs with:

```bash
docker exec -u www-data master-nextcloud-1 php /var/www/html/occ background-job:list 2>&1 | grep PlaybackSync
```

That gives you the job's row ID. To force it to run immediately rather than waiting for the cron worker:

```bash
docker exec -u www-data master-nextcloud-1 php /var/www/html/occ background-job:execute <ID> --force-execute
```

The `--force-execute` flag bypasses the "not due yet" check, which is what you want when manually testing.

If your Nextcloud instance does not have the cron worker running (i.e. you're on AJAX or webcron mode), the prune job will only run when somebody loads a Nextcloud page. That's fine for the friend-group threat model — expired rooms stay invisible to API callers thanks to the read-side filter — but it does mean the table can grow if your instance is rarely visited. For a busy instance with cron enabled, the table effectively self-cleans within an hour of any room expiring.

## The development build loop

The frontend uses Vite. The relevant scripts are declared in [`package.json`](../package.json) and break down by intent as follows:

| Script              | What it does                                                          | When to use                                                                                  |
|---------------------|-----------------------------------------------------------------------|----------------------------------------------------------------------------------------------|
| `npm run build`     | Production bundle: minified, tree-shaken, CSS inlined.                | Before committing, before manually testing inside Nextcloud, before any release.            |
| `npm run dev`       | Development one-shot build. Unminified, easier to debug.              | Quick rebuild after a single edit when you don't want a long-running watcher.                |
| `npm run watch`     | Development build with file watching.                                  | The default during active feature work — edit, save, reload page.                            |
| `npm run lint`      | Runs ESLint over `src/`.                                              | CLI sanity check; editor integrations usually surface the same warnings live.                |
| `npm run lint:fix`  | Same as `lint` but applies auto-fixes for fixable issues.             | Cleaning up after a refactor where import order or formatting drifted.                      |
| `npm run stylelint` | Runs Stylelint over `src/` `<style>` blocks.                          | CSS/SCSS hygiene check. Rarely needed because most styles are scoped and tiny.               |
| `npm run stylelint:fix` | Stylelint with auto-fixes.                                       | Same trigger as `lint:fix` but for stylesheets.                                              |
| `npm run test:php`  | Runs PHPUnit inside the Nextcloud Docker container.                   | Backend regression check before committing or after refactoring `lib/`.                      |
| `npm run test:php:testdox` | Same as `test:php` with the human-readable testdox formatter. | When you want to read the test report as English sentences instead of dots.                  |

The `build` output goes to `js/playbacksync-main.mjs` plus a couple of license artifacts. Those files are committed to the repository, because Nextcloud expects to find pre-built bundles at install time — there is no "build on install" step in the Nextcloud app deployment model.

The Nextcloud PHP side does not have an equivalent watcher because PHP files are picked up on the next request — there is nothing to compile. After editing a PHP file, the next API call or page load will execute the new code automatically, with one caveat: if you change autoloading (new namespaces, new class files), Nextcloud's classmap may need to be regenerated by disabling and re-enabling the app, or by running `occ maintenance:repair`. In practice, just adding new methods to existing classes never needs that.

## Automated tests (PHPUnit)

The PHP backend has a unit-test suite under [`tests/Unit/`](../tests/Unit/) that runs against the global PHPUnit binary already installed inside the Nextcloud Docker container. There is no separate `composer install` step — the suite uses Nextcloud's own autoloader and a tiny PSR-4 shim in [`tests/bootstrap.php`](../tests/bootstrap.php) for the test classes themselves.

The fastest way to run the suite is the npm wrapper script, which invokes PHPUnit inside the container so you don't have to remember the `docker exec` incantation:

```bash
npm run test:php           # progress dots
npm run test:php:testdox   # human-readable per-test report
```

If you prefer to run PHPUnit directly:

```bash
docker exec -u www-data master-nextcloud-1 sh -c \
  'cd /var/www/html/apps-extra/playbacksync && phpunit'
```

What's covered, and at what level:

| File                                                                 | Covers                                                                                                  | Style              |
|----------------------------------------------------------------------|---------------------------------------------------------------------------------------------------------|--------------------|
| [`tests/Unit/Service/RoomServiceTest.php`](../tests/Unit/Service/RoomServiceTest.php) | Domain rules: validation, ownership, admin gate, TTL handling, password/UUID generation, hashing.       | Pure unit (mocks). |
| [`tests/Unit/Controller/RoomControllerTest.php`](../tests/Unit/Controller/RoomControllerTest.php) | HTTP plumbing: 401 guard, exception → status mapping, response shape, share-link construction.           | Pure unit (mocks). |
| [`tests/Unit/BackgroundJob/PruneExpiredRoomsJobTest.php`](../tests/Unit/BackgroundJob/PruneExpiredRoomsJobTest.php) | The hourly prune job calls `deleteExpired` with the current time in milliseconds and is idempotent.      | Pure unit (mocks). |
| [`tests/Unit/Db/RoomTest.php`](../tests/Unit/Db/RoomTest.php)        | Entity getters/setters and BIGINT-to-int type coercion sanity.                                          | Pure unit.         |

What's deliberately *not* covered yet:

- The mapper (`RoomMapper`) — those are integration tests that need a live database connection. The end-to-end checks in the [Manual end-to-end testing](#manual-end-to-end-testing) section below exercise the same SQL paths via the API, which is good enough until we wire up an integration-test profile.
- The migration — same reason. Enabling/disabling the app exercises the migration directly.
- The frontend — no JavaScript test runner is configured yet. Pinia store actions and the API service are the highest-value targets if/when we add Vitest.

Tests are pure unit tests: every dependency is mocked via `PHPUnit\Framework\MockObject`, no database connection is opened, no HTTP requests are made, and a fixed `ITimeFactory` is injected so `created_at`/`expires_at` calculations are deterministic.

Each test method has a short PHPDoc above it stating what the test verifies, so scrolling through a file gives a quick "what does this guard against" overview without having to read the assertions themselves.

## Manual end-to-end testing

For the API surface, `curl` plus HTTP Basic auth (`-u username:password`) is the simplest way to exercise endpoints from outside the browser. The dev environment ships with a handful of pre-seeded users; the ones most relevant to PlaybackSync testing are:

| Username    | Password    | Role        | What it's good for                                              |
|-------------|-------------|-------------|-----------------------------------------------------------------|
| `admin`     | `admin`     | Admin       | Default smoke test; bypasses `restrict_to_admins`.              |
| `alice`     | `alice`     | Normal user | Default non-admin path; testing 403 under `restrict_to_admins`. |
| `bob`, `jane` | (= name)  | Normal user | Cross-user isolation tests (B can't see A's room).              |
| `user1`–`user6` | (= name) | Normal user | Bulk-data scenarios when you need many independent accounts.   |

See [api.md](api.md) for end-to-end examples of each endpoint.

For the database side, the dev environment runs MariaDB in a separate container:

```bash
docker exec master-database-mysql-1 \
  mysql -u nextcloud -pnextcloud nextcloud \
  -e "SELECT uuid, owner_user_id, expires_at FROM oc_playbacksync_rooms"
```

That's useful for confirming a room actually got persisted, for inspecting the password-hash column to make sure plaintext isn't leaking in (the prefix should always be `3|$argon2id$...`), and for inserting deliberately-expired rows to test the prune job.

To force-execute the prune job in this environment, find its ID with `background-job:list` and execute it as shown above. The expired rows should disappear immediately.

## Production deployment notes

For the moment there is no production deployment of PlaybackSync, so this section is mostly forward-looking. When the app does ship as a real Nextcloud app:

The bundle artifacts under `js/` and `css/` need to be committed to the repository — Nextcloud expects to find pre-built bundles when an app is installed from a tarball. There is no "build on install" step. This is why `package.json` has a build script that produces files in version control rather than in a dist/ directory we'd `.gitignore`.

The `info.xml` file's version field needs to be bumped on every release that includes a migration, so that `occ upgrade` actually runs the new migration. Bumping the version on releases that don't add migrations is fine but optional.

Operators configure the app from the **Administration settings → PlaybackSync** page (or `occ config:app:set`): room behaviour (`restrict_to_admins`, the TTL bounds, `max_clients_per_room`, `freeform_auto_append_cap`), WebSocket tuning, and daemon binding. A few things remain code-level constants and need a release to change — notably the password length and the prune-job interval.
