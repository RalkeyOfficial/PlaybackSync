# Event Log (SSE) — Shaping Notes

## Scope

Surface PlaybackSync's already-existing in-memory event ring buffer to two audiences:

1. **Room owners** — see a chronological live feed of *who did what* in their room (playback, presence, lifecycle, owner actions), embedded in the existing `RoomDetailDialog`.
2. **Nextcloud admins** — see a cross-room operational feed (admin "Recent activity") in `AdminSettings.vue`.

Transport is **Server-Sent Events** (`EventSource`) end-to-end: the daemon emits records on a long-lived HTTP response, PHP proxies them with HMAC auth on the loopback hop. No polling, no manual refresh.

## Decisions

- **Persistence stays in-memory.** No DB tables, no migrations. Events live in the daemon's existing per-room ring + a new global ring; both clear on daemon restart. UI surfaces a "log was reset" hint on restart via a `meta` SSE record carrying `daemonStartedAtMs`.
- **All four event sources captured.** Playback (already wired), presence (join/leave/kick), room lifecycle (create/rename/delete — `room_expired` *not* emitted; no cron sweep), admin actions (settings updated, admin secret rotated).
- **Actor semantics renamed.** Today `Admin/PlaybackController` records owner-initiated playback commands with `clientId: 'admin'`. Replaced with a typed `actor` field: `client | owner | admin | system`. Only Nextcloud-administrator actions (settings updates, secret rotation) use `actor: 'admin'`.
- **Per-room visibility = the room owner.** Same gate as `RoomService::getOwnedRoom`. Admins don't act on other people's rooms in any existing flow, so this is not a privacy concern.
- **Per-room UX: tabs.** `RoomDetailDialog` becomes a two-tab dialog (`Overview` | `Event log`). EventSource opens only when the tab is active.
- **Admin UX: settings section.** New `NcSettingsSection` "Recent activity" appended to `AdminSettings.vue`.
- **Back-pressure protection.** Daemon caps per-subscriber write buffer at `ws_sse_max_buffered_bytes` (default 256 KiB); a stuck consumer is dropped.
- **PHP-FPM worker pinning** is accepted as a known constraint — this product targets small friend-group Nextcloud installs (per `agent-os/product/mission.md`). If it becomes a problem, v2 can move SSE to a public token-gated daemon path mirroring how `/apps/playbacksync/ws/{uuid}` already works.

## Context

- **Visuals:** None — user asked for "technical and stylish while usable".
- **References studied:** `AdminKickClient` (HMAC loopback signing), `PlaybackController` (existing owner-initiated admin action pattern), `RoomDetailDialog.vue` + `RoomCard.vue` (current dashboard composition), `AdminSettings.vue` (existing admin surface).
- **Product alignment:** Fits Phase-1 polish + Phase-2 operational story. Mission emphasizes "low-end self-hosted" — keeping events in memory and avoiding DB churn aligns with that.

## Standards Applied

- **backend/php-conventions** — strict_types, `OCA\PlaybackSync\` namespace, OCP-only imports, no SPDX/author headers (CLAUDE.md reinforcement).
- **frontend/vue-conventions** — `<script setup lang="ts">`, `@nextcloud/vue` components over native, `t('playbacksync', …)` for every string, Pinia stores, `<style scoped>`, icons via `vue-material-design-icons`.
- **tooling/build** — Vite multi-entry: dashboard bundle (`src/index.ts`) and admin bundle (`src/adminSettings.ts`) both receive new code.

## Open notes carried forward

- **`renameRoom`** is mentioned in the lifecycle event vocabulary but no service method exists today. Leave a TODO at the obvious call site so when rename lands the event hook is wired automatically.
- **User display-name resolution** for `actorId` (Nextcloud userId) is lazy + memoized client-side. Raw userId is the acceptable fallback.
- **`@nextcloud/vue` 9.8 tabs** — no first-class tab primitive; the dialog ships a small ARIA `role="tablist"` locally. Promote to a shared component only if a second consumer appears.
