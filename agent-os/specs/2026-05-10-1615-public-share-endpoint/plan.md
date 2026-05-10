# Public Share Endpoint — `GET /apps/playbacksync/r/{uuid}`

## Context

The PlaybackSync Nextcloud app already advertises a "share link" of the form `/index.php/apps/playbacksync/r/{uuid}` in its API responses (`lib/Controller/RoomController.php:174`) and the dashboard surfaces it to room owners — but the route itself doesn't exist yet. Anyone clicking a share link today gets a 404.

`MISSING_FEATURES.md` documents this as a Phase 2 gap. The OLD_CODE reference implementation (Fastify, `OLD_CODE/server/src/routes/share.ts`) defines the contract: a public Basic-Auth password gate that, on success, 302-redirects the visitor to `room.targetUrl` with two appended query params (`sync_url`, `sync_password`) so a downstream consumer (browser extension, embedded player) can join the synchronized room.

This change implements that endpoint inside the Nextcloud app, matching OLD_CODE's behavior, plus Nextcloud-native brute-force protection via `IThrottler`.

## Scope (Shape)

- **Route**: `GET /apps/playbacksync/r/{uuid}` — public, no Nextcloud login required.
- **Auth**: HTTP Basic Auth. Username ignored. Password validated against `Room::passwordHash` via existing `RoomService::verifyPassword`.
- **Failure modes**:
  - Unknown / expired room → `404` with generic body. Per OLD_CODE/CLAUDE.md "Never mention 'expired' in client-facing errors" — same surface as not-found.
  - Missing `Authorization` header → `401` with `WWW-Authenticate: Basic realm="Room {uuid}"` (triggers browser prompt). **Not** throttled (matches OLD_CODE: only failed *attempts* count).
  - Wrong password → `401` with same `WWW-Authenticate` header. **Throttled** via `$response->throttle(['action' => 'playbacksync_share'])`.
- **Success**: `302 Found` with `Location` = targetUrl + merged query params `sync_url=wss://{host}/apps/playbacksync/ws/{uuid}` and `sync_password={plaintext from Basic Auth}`. Existing query params on targetUrl are preserved; existing `sync_url` / `sync_password` keys (if any) are overwritten — same semantics as `URL.searchParams.set` in OLD_CODE.
- **No changes** to the DB schema, frontend, or WS daemon.

## Decisions

- **New `ShareController`** (not a method on `RoomController`) — keeps `#[PublicPage]` from leaking to authenticated room CRUD. Mirrors `HealthController`'s pattern.
- **New `RoomService::getActiveRoom(string $uuid): Room`** — public lookup with expiry check, no ownership check. Throws `RoomNotFoundException` for both not-found and expired.
- **WS URL** — derived via `IURLGenerator::getAbsoluteURL('/apps/playbacksync/ws/' . $uuid)` then scheme rewrite (`https→wss`, `http→ws`). Reverse-proxy path documented in `docs/ws-sync-server.md:14`.
- **Brute-force** — annotate the action with `#[BruteForceProtection(action: 'playbacksync_share')]` and `#[AnonRateLimit(limit: 60, period: 60)]`. The middleware handles sleep-on-throttle automatically; the controller just calls `$response->throttle(...)` on failed-password responses.
- **Match OLD_CODE exactly** for redirect status (`302`), Basic Auth parsing semantics, password-in-redirect (plaintext), and "username ignored".

## Tasks

1. **Save spec docs** — this folder.
2. **`RoomService::getActiveRoom`** — public lookup mirroring `getOwnedRoom` minus ownership.
3. **`ShareController`** — new controller, single `show(string $uuid)` action with `#[PublicPage]` + `#[NoCSRFRequired]` + `#[BruteForceProtection]` + `#[AnonRateLimit]` attributes.
4. **Redirect builder** — private helper that swaps scheme on the WS URL, merges query params into targetUrl preserving existing keys + fragments.
5. **Route** — add `share#show` to `appinfo/routes.php`.
6. **Tests** — `tests/Unit/Controller/ShareControllerTest.php` covering 11 cases (see Test plan).
7. **Docs** — update `docs/api.md` and `MISSING_FEATURES.md`.

## Test plan (Task 6)

Mirrors `tests/Unit/Controller/HealthControllerTest.php`. Mocks `RoomService`, `IURLGenerator`, `IRequest`. Covers:

- Unknown UUID → 404, no `WWW-Authenticate`.
- Expired room → identical 404 surface.
- No `Authorization` header → 401 + `WWW-Authenticate`, **not** throttled.
- Malformed `Basic` header → same 401, not throttled.
- Wrong password → 401, `WWW-Authenticate`, throttled with `action=playbacksync_share`.
- Valid auth + simple targetUrl → 302 with `Location` containing both `sync_url` and `sync_password`.
- Valid auth + targetUrl with existing query → merged.
- Valid auth + targetUrl with fragment → fragment preserved after query.
- `http://` IURLGenerator → `Location` contains `ws://` not `wss://`.
- Password containing `:` round-trips intact.
- Username present but ignored.

## Verification (end-to-end)

1. PHPUnit: all new `ShareControllerTest` cases pass.
2. Inside the dev container, create a room and exercise the endpoint via `curl`:
   - No auth → 401 + `WWW-Authenticate`.
   - Wrong password (repeated) → 401 with growing throttle delay.
   - Correct password → 302 with sync params on `Location`.
   - Unknown UUID → 404.
3. Browser test: paste share link → native prompt → enter password → redirected to target with sync params.
4. Expired room → 404, identical to unknown.
