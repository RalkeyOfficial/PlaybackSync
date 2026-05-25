# Product Roadmap

## Phase 1: MVP (shipped)

The Nextcloud app side is feature-complete for a small-friend-group launch.

- **Room lifecycle** — create, delete, expire, password-protect, and share rooms via the dashboard; argon2id-hashed passwords; public share endpoint (`GET /apps/playbacksync/r/{uuid}`) gated on HTTP Basic Auth and `IThrottler`.
- **WebSocket sync daemon** — long-running `occ playbacksync:ws-serve` (Ratchet + ReactPHP). Server-authoritative time, drift correction with rate-nudge and hard-seek thresholds, per-connection rate limits, tombstone-based reconnect with `lastEventId` replay.
- **Content-model protocol** — playlist + cursor data substrate with `CURSOR_CHANGE_REQUEST` / `CURSOR_CHANGE` / `PLAYLIST_UPDATE` wire frames and a full per-mode reaction matrix (default / single / freeform with auto-prune cap).
- **Dashboard** — Vue + Pinia app for room management, live presence, owner-driven play/pause/seek/reset, kick, single/freeform toggles, curated playlist CRUD, cross-room and per-room event log via SSE.
- **Loopback admin bridge** — HMAC-signed `127.0.0.1:8766` HTTP endpoint that lets the PHP request layer drive the daemon (presence enrichment, playback commands, kick, broadcast-after-write, healthcheck).
- **Healthcheck** — daemon `/healthz` plus a `#[PublicPage]` `/api/v1/health` passthrough so external probes (k8s, status pages) can reach a stable URL.
- **Randomized nicknames** — anonymous viewers get a Reddit-style display name (`WittyFalcon42`) preserved across reconnects.

## Phase 2: Browser extension (in progress)

Scaffold lives in [`extension/`](../../extension/) (WXT, Chromium + Firefox).

Goal: a browser extension that runs on supported streaming sites, opens one
authoritative WebSocket per syncing tab from its background worker (each tab
is a distinct client; multi-room and multi-tab joins are supported in the
same browser), observes and controls the page's `<video>` element from a
content script, and applies server commands deterministically without
feedback loops. The extension is the second first-class client (alongside
the dashboard) and closes the loop on the "watch together on
Crunchyroll/etc." workflow.

Concrete work items:

- JOIN handshake with `clientId` + `lastEventId` persistence; reconnect with the same `clientId` on bare 1006 drops within the tombstone window; branch by typed `ERROR` code for terminal vs retryable closes.
- Content-script video adapter that observes play/pause/seek and applies server `STATE` / `CURSOR_CHANGE` / `SYNC_ADJUST` frames, suppressing feedback loops.
- `currentlyShowing` + `catalogFragment` reporting on JOIN so the daemon can steer / seed / auto-append per mode.
- Toolbar popup for room status, join via share link, and a clear "leave room" action.
- Cross-browser packaging (Chromium MV3 + Firefox MV2 from the same source).

## Deferred / V2

- *(none currently committed — see [`MISSING_FEATURES.md`](../../MISSING_FEATURES.md) for items that came up during Phase 1 review but were not promoted)*
