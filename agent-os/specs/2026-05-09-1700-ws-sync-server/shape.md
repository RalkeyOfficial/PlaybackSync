# WebSocket Sync Server — Shaping Notes

## Scope

A long-running PHP daemon that synchronises video playback (play/pause/seek/episode-change) across clients connected to the same room. Server-only deliverable — no frontend client and no browser-extension integration in this spec.

The daemon is launched with `occ playbacksync:ws-serve`, binds a local TCP port, and is reachable to clients at `ws[s]://<host>/index.php/apps/playbacksync/ws/{uuid}` via the admin's existing Apache/nginx reverse proxy.

## Decisions

- **Runtime: long-running PHP via occ + Ratchet.** This *is* a long-running PHP process — the standard exception to "PHP has no long-running process". It needs systemd/supervisord; will accumulate memory over weeks (recommend a weekly restart); on restart all rooms drop their connections (clients reconnect — same UX as a transient network blip).
- **WebSocket library: Ratchet (`cboden/ratchet` v0.4).** Most mature ReactPHP-based PHP WS lib; large community.
- **Endpoint URL: `ws[s]://host/index.php/apps/playbacksync/ws/{uuid}`.** Daemon binds `127.0.0.1:8765` by default (configurable via `IAppConfig`). Reverse proxy forwards just `/apps/playbacksync/ws/` to the daemon. Path was chosen instead of the bare `/apps/playbacksync/{uuid}` to avoid colliding with the existing PageController route.
- **Auth: room password sent in `JOIN` message.** Verified with `IHasher::verify()` against the existing `password_hash`. No new auth flow, no tokens. A connection that doesn't `JOIN` within 5s is closed.
- **State model: in-memory only.** No DB writes for playback state, no new columns. Late-join correctness comes from extrapolated time (`videoPos + (now-lastUpdate)/1000` when playing) and a 200-entry event-log ring buffer for reconnect replay. Daemon restart loses all rooms — clients reconnect; acceptable.
- **Protocol: redesigned but informed by OLD_CODE.** All four message groups in v1: core (JOIN/STATE/EVENT/ERROR), drift (HEARTBEAT/SYNC_ADJUST/CLOCK_PING/PONG), episode-change + content identity, buffer (BUFFER_START/END). Drops the unused OLD_CODE messages: `COMMAND`, `SERVER_SHUTDOWN`, `TIME_REPORT`.
- **No client-facing presence.** Members are tracked server-side only; no `MEMBER_JOINED`/`LEFT` broadcasts. Matches OLD_CODE's intentional design.
- **Ops: occ command + sample systemd unit.** Easy setup, no separate Docker container. The dev environment runs the daemon inside the existing PHP container. Production admins copy a systemd unit and a 5-line proxy snippet.

## Q&A summary

**Q: Runtime / hosting?** → PHP long-running via occ.
**Q: Scope of THIS spec?** → Server-only (protocol + connect/join/broadcast). Frontend client and extension come later.
**Q: How closely to follow OLD_CODE protocol?** → Redesign from scratch, informed by OLD_CODE — port the concepts that were marked KEEP, drop the unused ones.
**Q: WebSocket lib?** → Ratchet.
**Q: Auth model?** → Password in JOIN, verified against existing `password_hash`.
**Q: State model?** → User concerned about long-running PHP and rejoin reliability. Resolution: in-memory only is correct here because (a) the occ-launched daemon is *exactly* the long-running exception to PHP-FPM, (b) tombstones + extrapolated time + event-log replay make rejoin flawless without DB writes.
**Q: Endpoint URL?** → User wants `ws://host/index.php/apps/playbacksync/...`. Resolution: ship the daemon on a local port + a reverse-proxy snippet — admins keep the clean URL.
**Q: Message set?** → All four groups (core, drift+clock, episode-change, buffer). No client-facing presence.
**Q: Ops?** → User wants easy setup and rejected separate non-Nextcloud Docker container. Resolution: occ command, systemd unit doc, runs inside Nextcloud's existing environment.

## Context

- **Visuals:** None provided.
- **References:** `OLD_CODE/server/` for protocol design (every decision traces back to a specific file — see `references.md`). Existing rooms feature (`lib/Service/RoomService.php`, `lib/Db/RoomMapper.php`) for password verification and DB lookup patterns.
- **Product alignment:** N/A — `agent-os/product/` exists but no constraints surfaced affect this spec.

## Standards Applied

- `backend/php-conventions` — strict types, OCP-only imports, attribute-based annotations, `APP_ID` constant. Frontend conventions don't apply (no frontend changes in v1).
