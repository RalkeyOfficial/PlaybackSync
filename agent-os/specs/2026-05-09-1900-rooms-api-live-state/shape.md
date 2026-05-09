# Rooms API — Live-State Expansion — Shaping Notes

## Scope

Expand the rooms REST API (`GET /api/v1/rooms`, `GET /api/v1/rooms/{uuid}`) with live state from the WS daemon: connected clients (anonymous, by `clientId`), live playback state (`playerState`, `videoPos`), content identity (`providerId`, `episodeId`, `pageUrl`, `contentKey`), and `lastActivityMs`. Add a focused `GET /api/v1/rooms/{uuid}/clients` for presence-only consumers.

Surface the new fields on the existing rooms page (`RoomCard.vue`): client chips per room, a playback chip, and a live-status dot.

## Decisions

- **Identity is anonymous `clientId` only.** Daemon-generated random hex string, exposed verbatim. No NC userId — the Chrome extension is the only client and has no NC account binding. Matches today's JOIN flow and the OLD_CODE precedent (`connectedClients: Map<ClientId, ClientConnection>`).
- **Bridge: loopback HTTP admin port on the daemon, HMAC-signed.** New port (default `127.0.0.1:8766`), `Ratchet\Http\HttpServer` mounted on the same React event loop. PHP calls it via `OCP\Http\Client\IClientService` with a 200 ms timeout per request. Single batched call per rooms-API request (one HTTP round-trip, N rooms enriched).
- **Failure mode is graceful degradation, not an error.** Any failure path (daemon down, HMAC mismatch, timeout, malformed body) → `live: null` per room and a single warn-log per request. Rooms list still renders.
- **Additive-only spec change.** No renamed fields, no removed fields. Stay on v1; clients ignore unknown fields. New `live` key is always present in the response (may be `null`).
- **Identical live shape on list and detail.** Per-room client list capped at 50; `connectedCount` reflects the true total when truncated.
- **Live state is ephemeral. No DB writes.** Heartbeats every ~5 s would create a write storm against `oc_*`; presence shouldn't survive a daemon restart anyway.

## Q&A summary

**Q: Add a new spec or extend the existing rooms spec?** → Extend in place. Additive, backward-compatible. New endpoint `/clients` is purely a focused presence surface.
**Q: What identity for "connected users"?** → Anonymous `clientId` (random UUID-like). Chrome extension isn't tied to NC users; OLD_CODE used the same model.
**Q: Both list and detail surfaces?** → Yes, both — the rooms page wants to show presence per card.
**Q: Source of truth?** → WS daemon (live presence). DB is unsuitable; cache (memcache/APCu) was rejected by user as "awful" and would be unreliable across processes.
**Q: PHP↔daemon bridge — shared cache, DB table, or HTTP?** → User asked me to research and pick. Chose **loopback HTTP + HMAC** because: (a) Nextcloud Talk's signaling-server uses the same pattern, (b) OLD_CODE already exposed HTTP introspection (`/metrics`) co-located with the WS server, (c) presence is in-memory and ephemeral by nature, (d) DB writes from heartbeats would be a storm, (e) APCu is per-process and the daemon is a separate `occ` process so can't share with PHP-FPM workers.
**Q: What other expansion fields beyond connected users?** → Live playback state, content identity, last activity timestamp.
**Q: How to display anonymous client IDs in the UI?** → Truncate (e.g. first 6 chars) with a stable color hash; "you" identified locally by the Chrome extension's stored `clientId` from `ROOM_STATE`.

## Context

- **Visuals:** None provided. UI changes are small (chips on existing card layout) — described inline in the plan.
- **References:** Prior spec `agent-os/specs/2026-05-09-1700-ws-sync-server/` for the daemon architecture, `docs/ws-protocol.md` for the existing WS protocol surface, `OLD_CODE/server/src/types/room.ts` for the historical `connectedClients: Map<ClientId, ClientConnection>` shape, Nextcloud Talk's signaling-server backend protocol as the architectural analog for HTTP+HMAC daemon bridges.
- **Product alignment:** `agent-os/product/` exists; no specific constraints surfaced that affect this spec.

## Standards Applied

- `backend/php-conventions` — strict types, OCP-only imports, attribute-based controller annotations, `APP_ID` const.
- `frontend/vue-conventions` — `@nextcloud/vue` components, camelCase props, `<script setup lang="ts">`, l10n in both `l10n/en.js` and `l10n/nl.js` with real Dutch translations.
