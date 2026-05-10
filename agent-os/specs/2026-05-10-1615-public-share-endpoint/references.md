# References for Public Share Endpoint

## Similar Implementations

### OLD_CODE Fastify share route (algorithm reference)

- **Location:** `OLD_CODE/server/src/routes/share.ts`
- **Relevance:** The exact contract this work re-implements. Defines the Basic Auth parsing rules (username ignored, base64 decode, split on first `:`), the 401 + `WWW-Authenticate: Basic realm="Room {uuid}"` failure surface, and the 302 redirect to `targetUrl?sync_url=…&sync_password=…`.
- **Key patterns:**
  - `parseBasicAuth` — header presence check → base64 decode → split. Replicated in `ShareController` directly (PHP `str_starts_with` + `base64_decode` + `explode(':', $creds, 2)`).
  - `buildRedirectUrl` — preserves existing query params (`new URL` + `searchParams.set`). PHP equivalent: `parse_url` + `parse_str` + `http_build_query` + manual reassembly.
  - Status code: explicit 302 (Fastify default for `reply.redirect`). PHP equivalent: pass `Http::STATUS_FOUND` to `RedirectResponse` (its default is 303).

### Public-page controller in this app (Nextcloud-side precedent)

- **Location:** `lib/Controller/HealthController.php`
- **Relevance:** Single in-repo controller using `#[PublicPage]` + `#[NoCSRFRequired]`. `ShareController` mirrors its shape: small constructor with injected dependencies, single public method, no inheritance beyond `Controller`.
- **Key patterns:** attribute-style controller annotations (no PHPDoc tags), explicit response type in the method signature, `JSONResponse`/`DataResponse` over manual header juggling.

### Room service & expiry pattern

- **Location:** `lib/Service/RoomService.php` (`getOwnedRoom`, `verifyPassword`)
- **Relevance:** `getActiveRoom` is the new sibling of `getOwnedRoom` — same not-found-or-expired collapsed surface (`RoomNotFoundException`), but no ownership predicate. `verifyPassword` already exists and does the argon2id check; do not duplicate.
- **Key patterns:** `try { findByUuid } catch (DoesNotExistException) { throw RoomNotFoundException }`; expiry compared with `$room->getExpiresAt() <= $now` where `$now = $this->timeFactory->getTime() * 1000` (ms).

### Reverse-proxy WebSocket URL

- **Location:** `docs/ws-sync-server.md` (line 14: `ws[s]://<nextcloud-host>/index.php/apps/playbacksync/ws/{roomUuid}`)
- **Relevance:** Confirms the path that the Apache/nginx reverse-proxy already forwards to the daemon. `ShareController::buildRedirectUrl` emits `wss://{host}/apps/playbacksync/ws/{uuid}` from `IURLGenerator::getAbsoluteURL` + a scheme rewrite — no new admin setting needed.

### Existing test scaffolding

- **Location:** `tests/Unit/Controller/HealthControllerTest.php`, `tests/bootstrap.php`
- **Relevance:** Direct template for `ShareControllerTest` — same PHPUnit + `createMock` pattern, same namespace (`OCA\PlaybackSync\Tests\Unit\Controller`), same pure-unit-test approach (no Nextcloud bootstrapping at test level beyond what `tests/bootstrap.php` already does).
