# Admin "restart the WS daemon" button — Shaping Notes

## Scope

Add a one-click **Restart daemon** button to the PlaybackSync admin settings so an
operator never has to open a terminal to restart the WebSocket daemon. This is **Design A**
from `EXTENSION_TODO.md`: the daemon exits gracefully on request and the external
supervisor (`restart: unless-stopped` sidecar, or systemd) starts a fresh process.

Both prerequisites already shipped (previous spec, commit 4264dc8): the supervised compose
sidecar and the graceful `$loop->stop()` shutdown path in `WsServe.php`.

## Decisions

- **Daemon mechanism:** a new HMAC-authed `POST /admin/restart` route on the daemon's
  loopback admin server responds `200` then `Loop::get()->stop()`s on a 0.25 s timer.
  `WsServe::execute()` then returns and the `occ` process **exits 0 on its own** — which is
  *not* a `docker stop`/`kill`, so `restart: unless-stopped` restarts it (verified mechanism).
- **Placement:** standalone "Restart daemon" button in the existing **Daemon binding**
  section, **and** an auto-prompt ("Restart now to apply?") after a successful save of that
  section, since binding changes only take effect after a restart.
- **No-supervisor UX:** after triggering, actively poll `GET /api/v1/ws/status` (~20–30 s)
  with a spinner. Success → toast. Timeout → error toast naming the supervisor requirement
  (Docker Compose / systemd) + operator-guide pointer. The confirm dialog warns up front.
- **Readiness detection:** a ~2 s grace before polling guarantees the old process is gone
  (it exits ~0.25 s after responding), so poll-until-`available:true` cleanly detects the
  **new** daemon — no change to the status endpoint needed.
- **No event-log entry for the restart:** the daemon's event log is in-memory and is wiped
  by the very restart we trigger, so recording `daemon_restarted` would be futile. Skipped
  deliberately (a documented deviation from the `regenerateAdminSecret` precedent).

## Context

- **Visuals:** None.
- **References:**
  - `lib/Service/AdminKickClient.php` + `lib/Service/Exceptions/KickFailedException.php` —
    the HMAC loopback admin-client + domain-exception pattern `AdminRestartClient` mirrors.
  - `lib/WebSocket/Admin/PresenceHttpServer.php` — daemon route dispatch + `respond()`;
    `AdminAuthMiddleware` HMAC check runs first.
  - `lib/Controller/AdminSettingsController.php::regenerateAdminSecret()` — closest
    destructive-admin-action precedent (the new `restartDaemon()` mirrors it).
  - `lib/Controller/WsStatusController.php` — `GET /api/v1/ws/status` → `{available, reason}`,
    `#[NoAdminRequired]`; the poll target.
  - `src/views/AdminSettings.vue` regenerate-secret flow (button + `NcDialog` + `regenerating`
    spinner), `src/stores/adminSettings.ts`, `src/services/adminSettingsApi.ts`,
    `src/stores/wsStatus.ts` (`load()`), `src/services/wsStatusApi.ts` (`fetchWsStatus`).
- **Product alignment:** roadmap §"Phase 2" (daemon + loopback admin bridge + healthcheck);
  TODO "Other changes" frames this as Design A, unblocked by the supervision work.

## Standards Applied

- **backend/php-conventions** — new daemon route, `AdminRestartClient`, exception, controller
  action: `declare(strict_types=1)`, only `OCP\` imports, meaningful PHPDoc, no SPDX/author headers.
- **frontend/vue-conventions** — `@nextcloud/vue` components (`NcButton`, `NcDialog`,
  `NcLoadingIcon`), every string via `t('playbacksync', …)` in both `l10n/en.js` and
  `l10n/nl.js`, Pinia store action, `<script setup lang="ts">`.
