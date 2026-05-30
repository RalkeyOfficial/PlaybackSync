# Admin "restart the WS daemon" button

## Context

Operators currently restart the PlaybackSync WebSocket daemon by hand — `docker compose … restart`, `systemctl restart`, or re-running `occ playbacksync:ws-serve`. This change adds a one-click **Restart daemon** button in admin settings so an operator never needs a terminal.

This is **Design A** from `EXTENSION_TODO.md`: the daemon exits gracefully on request and the **external supervisor** (the `restart: unless-stopped` sidecar, or systemd) starts a fresh process. Both prerequisites already landed (commit 4264dc8): the supervised sidecar and the graceful `$loop->stop()` shutdown path in `WsServe.php`.

The button only triggers an **exit**; the supervisor does the actual restart. With no supervisor the daemon stops and won't come back — surfaced by the post-restart readiness poll as a clear error.

### Decisions (confirmed with user)
- **Placement:** standalone "Restart daemon" button in the **Daemon binding** section, **and** an auto-prompt ("Restart now to apply?") after a successful save of that section.
- **No-supervisor UX:** poll `/api/v1/ws/status` (~20–30 s) with a spinner; success → toast; timeout → error toast naming the supervisor requirement + operator-guide pointer. Confirm dialog warns up front.

### How the restart works (verified mechanism)
The daemon route responds `200` then `Loop::get()->stop()` on a 0.25 s timer (so the 200 flushes first). `$server->run()` returns, `WsServe::execute()` returns `Command::SUCCESS`, the `occ` process exits 0 **on its own** — not a `docker stop`/`kill`, so `restart: unless-stopped` restarts it. The old process is gone ~0.25 s after responding, so a ~2 s grace before polling lets poll-until-`available:true` detect the **new** daemon — no status-endpoint change.

## Tasks

1. **Spec docs** — this folder (`plan.md`, `shape.md`, `standards.md`, `references.md`).
2. **Daemon route** — `lib/WebSocket/Admin/PresenceHttpServer.php`: `RESTART_ROUTE = '/admin/restart'`; after the HMAC check, `POST /admin/restart` → `respond(200, ['result' => 'restarting'])` then `Loop::get()->addTimer(0.25, fn => Loop::get()->stop())`. Add `use React\EventLoop\Loop;`.
3. **Client + exception** — `lib/Service/Exceptions/DaemonRestartFailedException.php` (mirror `KickFailedException`); `lib/Service/AdminRestartClient.php` (mirror `AdminKickClient`, canonical `"POST\n/admin/restart\n{nowMs}"`, ~1 s timeout, `200` → return else throw).
4. **Controller + route** — `restartDaemon(): DataResponse` on `AdminSettingsController` (inject `AdminRestartClient`; catch `DaemonRestartFailedException` → 502; return `['status' => 'restart_initiated']`). Route `admin_settings#restartDaemon → POST /api/v1/admin/ws/restart`. No event-log entry (the restart wipes the in-memory log).
5. **Frontend API + store** — `restartDaemonWs()` in `adminSettingsApi.ts`; `restarting` flag + `restartDaemon()` in `adminSettings.ts` (POST → ~2 s grace → poll `fetchWsStatus()` ≤~20 s until available → refresh wsStatus store → success/timeout toast).
6. **Frontend UI** — Restart button in Daemon binding section + reusable confirm `NcDialog` (mirror regenerate), opened by the button and by a successful `save('daemon')`.
7. **l10n** — new keys in `l10n/en.js` + `l10n/nl.js` (real Dutch).

## Verification
- PHP `php -l` + `phpunit` (in container); `npx eslint` + `npm run dev`.
- E2E (sidecar up): Restart → confirm → spinner → toast; `docker inspect playbacksync-ws --format '{{.RestartCount}}'` incremented; `/healthz` uptime reset. Save a `ws_port` change → auto-prompt → restart. No-supervisor: stop supervisor → poll times out → error toast.

## Standards
- **backend/php-conventions**, **frontend/vue-conventions** (see `standards.md`).

## Non-goals
- Restart in the user-facing `WsStatusBadge` popup (admins only). A daemon "stop" control or richer status telemetry.
