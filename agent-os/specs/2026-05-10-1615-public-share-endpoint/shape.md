# Public Share Endpoint — Shaping Notes

## Scope

Implement `GET /apps/playbacksync/r/{uuid}` — a public, no-Nextcloud-login route that prompts for a Basic Auth password against the room's argon2id hash and on success 302-redirects the visitor to `room.targetUrl` with two appended query parameters (`sync_url`, `sync_password`) so a downstream consumer (browser extension or embedded player) can join the synchronized room. Closes the only remaining "Phase 2 deferred" item from `MISSING_FEATURES.md` that is shaped like a single endpoint.

## Decisions

- **New `ShareController`** instead of a method on `RoomController`. Keeps `#[PublicPage]` from leaking onto the authenticated room CRUD methods. Mirrors `HealthController`'s pattern (single public method, narrow dependency surface).
- **New `RoomService::getActiveRoom(string $uuid): Room`**. The existing `getOwnedRoom` is the closest match but enforces ownership; the public share endpoint must look the room up by UUID alone. We expose the not-found and expired cases with identical 404 surfaces (per `OLD_CODE/CLAUDE.md` — never mention "expired" in client-facing errors).
- **HTTP Basic Auth, not an HTML form**. Matches `OLD_CODE/server/src/routes/share.ts`. Browsers handle the prompt natively; no template needed; no extra page controller.
- **Username is ignored**. Browser may strip the user portion of the URL anyway, and OLD_CODE explicitly only validates the password. Splitting on the first `:` (`explode(':', $creds, 2)`) keeps passwords containing colons intact.
- **Match OLD_CODE redirect semantics exactly** — 302 (not the OCP `RedirectResponse` default of 303), `sync_url=wss://{host}/apps/playbacksync/ws/{uuid}`, `sync_password={plaintext from the Basic Auth header}`, existing target query merged, fragments preserved.
- **WS URL is derived from `IURLGenerator`** (the reverse-proxy mounts `/apps/playbacksync/ws/` to the daemon — see `docs/ws-sync-server.md:14`). We do not introduce a `ws_public_base_url` admin setting until there's evidence we need it; `IURLGenerator` is the same source the rest of the app uses for absolute URLs.
- **Brute-force protection** — combine `#[BruteForceProtection(action: 'playbacksync_share')]` (Nextcloud's `IThrottler`) with `#[AnonRateLimit(limit: 60, period: 60)]`. Argon2id alone is slow but not enough; the throttler adds an IP-based delay on repeated failures and the rate-limit caps total volume from anonymous callers.
- **Only failed *attempts* are throttled** — missing/malformed `Authorization` headers do not register as attempts. This matches the OLD_CODE log/metric story (`share.auth_failed` only fires on bad passwords) and avoids penalizing the very first hit, which by design has no credentials.

## Context

- **Visuals**: None. Browser-native Basic Auth dialog; no app-rendered page.
- **References studied**:
  - `OLD_CODE/server/src/routes/share.ts` — algorithm reference.
  - `lib/Controller/HealthController.php` — `#[PublicPage]` + `#[NoCSRFRequired]` precedent in this app.
  - `lib/Service/RoomService.php` (`getOwnedRoom`, `verifyPassword`) — patterns to reuse without duplicating.
  - `docs/ws-sync-server.md` — confirms WS URL shape `wss://<host>/apps/playbacksync/ws/{uuid}`.
- **Product alignment**: The existing `RoomController::serializeRoom` already publishes a `shareLink` field of the form `/index.php/apps/playbacksync/r/{uuid}` and `docs/api.md` describes it as a "Phase 2 placeholder". This change cashes that promise — no other roadmap items move.

## Standards Applied

- `backend/php-conventions` — strict types, OCP-only imports, attribute-style annotations (`#[PublicPage]`, `#[NoCSRFRequired]`, `#[BruteForceProtection]`, `#[AnonRateLimit]`), no author/license/SPDX headers.

## Non-goals

- Token-based auth (OLD §17 future work).
- HTML password page / themed error page.
- Storing or surfacing the redirect target separately from `room.targetUrl`.
- A separate admin setting for the public WS URL — `IURLGenerator` is sufficient for the standard reverse-proxy deployment described in `docs/ws-sync-server.md`.
- Frontend changes — there is no in-Nextcloud landing page involved.
