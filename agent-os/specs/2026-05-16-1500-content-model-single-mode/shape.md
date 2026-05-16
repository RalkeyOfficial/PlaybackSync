# Single Mode — Shaping Notes

## Scope

Close the four end-user surfaces missing from the otherwise-shipped single-mode feature:

1. **Seed entry in `RoomCreateDialog`** — when "Single mode" is ticked, the bootstrap URL field doubles as the seed-video URL. Submit attaches a single curated `initialEntries[0]` whose `pageUrl` equals the bootstrap URL.
2. **Mode picker in `PlaylistEditor` header** — replace the read-only colored badge with an `NcSelect` dropdown of `Default / Single / Freeform`. Selecting a different mode calls the existing `updateSettings()` store action.
3. **Multi-entry lock warning** — when the user picks "Single mode" while >1 entries exist, intercept with an `NcDialog` confirm before applying.
4. **oEmbed title pre-fetch** — new backend endpoint `POST /api/v1/metadata/lookup` returning `{ providerId, videoId, pageUrl, label, providerName }`. Called from the create dialog 400ms after URL change to populate a label field.

Single mode itself (the persistence flag, WS / HTTP enforcement, JOIN steering, error codes, mutual exclusion against freeform) is already implemented and out of scope here.

## Decisions

- **Bootstrap URL doubles as the seed URL in single mode.** Per the doc, `bootstrapUrl` equals the sole entry's `pageUrl` for single-mode rooms. Reusing the existing field avoids duplicated input and matches the persisted contract.
- **Mode picker is `NcSelect`, not a button menu or row of switches.** Single dropdown component is the cleanest mutual-exclusion guarantee — the picker can only emit one of three keys, so `(singleMode, freeformMode) = (true, true)` is unrepresentable client-side. The colored mode chip from the current badge is preserved as a small `<span>` next to the dropdown so the at-a-glance cue is not lost.
- **oEmbed lookup is server-side, cached per URL.** Calling oEmbed from the browser would require CORS headers we can't depend on; doing it server-side with `\OCP\Http\Client\IClientService` and a 1h `\OCP\ICache` entry keeps the dialog snappy and uniform across providers.
- **URL parser covers YouTube + Vimeo + generic fallback.** Same minimal set the extension would target. Generic fallback uses `providerId: 'generic'` and `videoId: substr(sha1(pageUrl), 0, 16)` so single-mode rooms can be created even for sites we don't have first-class handling for — the lookup still returns the parsed identity (with `label: null`) and the UI lets the owner type a label by hand.
- **`initialEntries` UI is single-mode only.** Default and freeform modes continue to start empty per their respective specs. A future spec can lift `initialEntries` into the always-on path if owners ask.
- **Lock-warning confirmation re-uses the existing "Clear playlist?" `NcDialog` pattern** at `PlaylistEditor.vue:163–187`. Same shape, different copy.
- **Picker cancellation reverts the dropdown.** When the user cancels the lock-warning, the local `modeChoice` ref is snapped back to the prior value so the dropdown doesn't show "Single mode" while the room is actually default mode.

## Context

- **Visuals:** None (user opted out).
- **References:**
  - [CONTENT_MODEL_SINGLE.md](../../../CONTENT_MODEL_SINGLE.md) — canonical doc this spec implements.
  - [CONTENT_MODEL.md](../../../CONTENT_MODEL.md) + [CONTENT_MODEL_TECHNICAL.md](../../../CONTENT_MODEL_TECHNICAL.md) — overview / technical companion.
  - `agent-os/specs/2026-05-14-2000-content-model-default-mode/` — sibling spec; this single-mode spec layers on top of the same playlist-editor surface.
  - `agent-os/specs/2026-05-14-1700-content-model-data-substrate/` — established the persisted `singleMode` column.
  - `agent-os/specs/2026-05-14-1830-content-model-protocol/` — established the WS / HTTP enforcement paths.
- **Product alignment:** N/A — no `agent-os/product/` folder present.

## Audit summary

Backend (lib/Db, lib/Migration, lib/Controller, lib/Service, lib/WebSocket/Handler) and frontend (RoomCreateDialog mode toggles, PlaylistEditor lock disables, playlistApi, stores/rooms toasts, l10n) all implement the single-mode contract today. The only missing pieces are surfaced in the four-gap list above.

## Standards Applied

- `backend/php-conventions` — applies to new `MetadataController`, `VideoUrlParser`, `OembedLookupService`: `declare(strict_types=1)`, `OCP\` imports only, `OCA\PlaybackSync\` namespace, `@NoAdminRequired` annotation, `Application::APP_ID` constant.
- `frontend/vue-conventions` — applies to edits in `RoomCreateDialog.vue`, `PlaylistEditor.vue`, and the new `metadataApi.ts`: `<script setup lang="ts">`, `@nextcloud/vue` imports, `t('playbacksync', …)` for every string, icon `:size` conventions, scoped styles.
