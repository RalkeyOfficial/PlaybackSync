# Content Model — Single Mode (UI completion)

## Context

[CONTENT_MODEL_SINGLE.md](../../../CONTENT_MODEL_SINGLE.md) describes a per-room "single mode" toggle that locks the playlist: no additions, removals, or reorders, but the cursor can still move between existing entries. JOIN steers stale joiners (does not disconnect). Single + freeform are mutually exclusive.

A read-only audit confirms the backend, WS protocol, persistence, error codes (`single_mode_locked`, `toggle_conflict`), HTTP API client, and Pinia store wiring are **already complete** (delivered as part of the playlist+cursor substrate, protocol, and default-mode specs). The remaining gaps are end-user surfaces that make single-mode rooms actually usable from the dashboard:

1. **Seed entry in create dialog.** Today a user ticks "single mode" and submits — they get a room with an empty, immutable playlist. The Rick Astley scenario (the canonical use case) can't be completed via UI. The dialog must collect the one video on creation and submit it as `initialEntries: [{ source: 'curated', ... }]` with `bootstrapUrl` aligned to it.
2. **Post-creation toggle in `PlaylistEditor` header.** The backend exposes `POST /api/v1/rooms/{uuid}/settings` and the Pinia store wraps it as `updateSettings()`, but there is no UI for flipping `singleMode` / `freeformMode` after the room exists. This blocks "I finished curating, lock it now" and "I want to add a sequel, unlock it".
3. **Multi-entry lock warning.** Per the doc: toggling single mode on a playlist with >1 entry should warn the owner ("This will lock the playlist. Existing entries stay, but no new ones can be added.") before applying.
4. **oEmbed title pre-fetch.** When the owner pastes a YouTube/Vimeo URL in the single-mode seed field, fetch the title server-side and auto-populate the entry `label`. Owners can still hand-edit. Backend endpoint does not exist yet.

Intended outcome: an owner can create a single-mode room with one video end-to-end from the dashboard with a fetched title; can later toggle the mode off and curate the room into a series, or lock a multi-entry series with a confirmation warning.

## Critical files

### Backend (new endpoint + helpers)
- **New** [lib/Service/VideoUrlParser.php](../../../lib/Service/VideoUrlParser.php) — Pure-PHP helper that maps a URL to `(providerId, videoId, pageUrl)`. YouTube (`watch?v=`, `youtu.be/`, `embed/`) and Vimeo at minimum; falls back to `providerId: 'generic'` + URL hash for the video id (matches what the extension would produce). Single place for URL → entry-key resolution.
- **New** [lib/Service/OembedLookupService.php](../../../lib/Service/OembedLookupService.php) — Calls the provider's oEmbed endpoint via `\OCP\Http\Client\IClientService`, returns `{ title, author, thumbnailUrl }`. Timeout: 3s. Caches per-URL in `\OCP\ICache` for 1h to keep dialog snappy on retries.
- **New** [lib/Controller/MetadataController.php](../../../lib/Controller/MetadataController.php) — `POST /api/v1/metadata/lookup` accepting `{ pageUrl }`. Composes `VideoUrlParser` + `OembedLookupService`, returns `{ providerId, videoId, pageUrl, label, providerName }`. Errors: `unsupported_url` (parser couldn't extract), `lookup_failed` (oEmbed call failed — still returns the parsed identity but without a label so the UI can fall back). Auth: `@NoAdminRequired`, throttled via existing bruteforce / rate-limit annotations matching `RoomController`.
- [appinfo/routes.php](../../../appinfo/routes.php) — register the metadata route.
- [lib/Service/RoomService.php](../../../lib/Service/RoomService.php) — `createRoom()` already accepts `initialEntries`; verify that when `singleMode = true` it tolerates a single curated entry whose `pageUrl` matches `bootstrapUrl`. No behaviour change expected, just a read-only confirmation.
- **New** [tests/Unit/Service/VideoUrlParserTest.php](../../../tests/Unit/Service/VideoUrlParserTest.php) — covers YouTube short/long/embed forms, Vimeo, generic fallback, malformed input.

### Frontend (the bulk of the work)
- [src/components/RoomCreateDialog.vue](../../../src/components/RoomCreateDialog.vue) — when `singleMode` is on:
  - The existing "Bootstrap URL" field's helper text changes to "The video everyone will watch." (`NcTextField` already in place).
  - On blur of the URL (debounced 400ms), call the new `metadataApi.lookup()`. Show an inline preview row beneath the field: `[provider chip] · [title]` (or "Title not found, will use URL" on lookup failure). A second `NcTextField` for the seed-entry `label` appears, pre-filled with the fetched title and overridable by the owner.
  - On submit, the payload includes `initialEntries: [{ providerId, videoId, pageUrl: bootstrapUrl, label, source: 'curated' }]`.
  - When `singleMode` is off, behaviour is unchanged (the bootstrap field stays as-is; no `initialEntries`).
- [src/components/PlaylistEditor.vue](../../../src/components/PlaylistEditor.vue) — replace the read-only mode badge at lines 8–10 with a compact `NcSelect` dropdown bound to a single computed `modeChoice` ('default' | 'single' | 'freeform'). Three options with localized labels. The current value is shown as the picker's value; the dropdown opens on click.
  - On change, map the picked value to a `(singleMode, freeformMode)` pair and call `roomsStore.updateSettings(uuid, singleMode, freeformMode)`.
  - If the user picks "Single mode" *and* `entries.value.length > 1`, intercept first: open a `NcDialog` confirm (mirroring "Clear playlist?" at lines 163–187) with copy "Lock the playlist? Existing entries stay, but no new ones can be added until you toggle single mode off." Buttons: Cancel / Lock playlist. On cancel, revert `modeChoice` to the prior value so the dropdown snaps back; on confirm, fire `updateSettings`.
  - Mutual exclusion: handled by the picker only emitting one of three states (Default = both off; Single = singleMode true; Freeform = freeformMode true), so the impossible `(true,true)` combination can't be sent.
  - Keep the colored mode-badge styling by applying the existing `modeBadgeClass` to the `NcSelect` wrapper (or rendering a small color chip alongside the dropdown) so the at-a-glance "what mode is this" cue is preserved.
- [src/types/room.ts](../../../src/types/room.ts) — confirm `InitialPlaylistEntry` shape matches what the create dialog will submit; widen if needed.
- **New** [src/services/metadataApi.ts](../../../src/services/metadataApi.ts) — single function `lookup(pageUrl): Promise<{providerId, videoId, pageUrl, label, providerName} | null>`. Uses `@nextcloud/axios` with the route generator pattern already used by `playlistApi.ts`.
- [src/stores/rooms.ts](../../../src/stores/rooms.ts) — confirm `updateSettings()` (line 173) returns `boolean` and the `toggle_conflict` toast already exists (it does, line 185); no change expected.
- [l10n/en.js](../../../l10n/en.js) and [l10n/nl.js](../../../l10n/nl.js) — every new string keyed in both, real Dutch translations per [CLAUDE.md](../../../CLAUDE.md).

### Reuse (do not reimplement)
- `RoomController` exception → wire-code translation pattern (see lines 378, 434, 476, 500, 534 for `single_mode_locked`; line 321 for `toggle_conflict`).
- `OCP\Http\Client\IClientService` (standard Nextcloud HTTP client, used elsewhere in Nextcloud apps for outbound calls).
- Pinia store error-toast pattern already in [src/stores/rooms.ts](../../../src/stores/rooms.ts) for `single_mode_locked` (line 212) and `toggle_conflict` (line 185).
- `NcDialog`-based confirmation pattern from [PlaylistEditor.vue](../../../src/components/PlaylistEditor.vue) "Clear playlist?" at lines 163–187 — mirror it for the lock-warning confirmation.
- `@nextcloud/vue` components per [CLAUDE.md](../../../CLAUDE.md): no native primitives.

## Tasks

### Task 1 — Save spec documentation

Create `agent-os/specs/2026-05-16-1500-content-model-single-mode/` with:

- `plan.md` — this file.
- `shape.md` — scope, decisions (URL field doubles as seed in single mode; mode picker inside PlaylistEditor header; oEmbed cached server-side; URL parser covers YouTube + Vimeo + generic fallback), and the four-gap framing from the Context section.
- `standards.md` — full content of `agent-os/standards/backend/php-conventions.md` and `agent-os/standards/frontend/vue-conventions.md`.
- `references.md` — pointers to [CONTENT_MODEL_SINGLE.md](../../../CONTENT_MODEL_SINGLE.md), the default-mode spec at `agent-os/specs/2026-05-14-2000-content-model-default-mode/`, [PlaylistEditor.vue](../../../src/components/PlaylistEditor.vue), [RoomCreateDialog.vue](../../../src/components/RoomCreateDialog.vue), and [RoomController.php](../../../lib/Controller/RoomController.php) (for the controller annotation + error-code pattern).
- `visuals/` — empty (user opted out of mockups).

### Task 2 — Backend: URL parser + oEmbed + metadata endpoint

1. `VideoUrlParser::parse(string $pageUrl): ?ParsedVideo` returning `{ providerId, videoId, normalizedPageUrl }`. Supported providers: `youtube` (handles `watch?v=`, `youtu.be/<id>`, `embed/<id>`, `shorts/<id>`), `vimeo` (`vimeo.com/<id>`). Generic fallback: `providerId: 'generic'`, `videoId: substr(sha1(pageUrl), 0, 16)`, `normalizedPageUrl = pageUrl`. Returns `null` only if the input isn't a valid http(s) URL.
2. `OembedLookupService::fetch(string $pageUrl, string $providerId): ?array` — calls YouTube oEmbed (`https://www.youtube.com/oembed?url=...&format=json`) or Vimeo oEmbed (`https://vimeo.com/api/oembed.json?url=...`); skips for `generic`. 3s timeout. Cache key: `playbacksync.oembed.<sha1(pageUrl)>`, TTL 3600s. Returns `{ title, providerName, thumbnailUrl }` or `null` on failure.
3. `MetadataController::lookup()` mapped to `POST /api/v1/metadata/lookup`:
   - Body: `{ pageUrl: string }`.
   - Calls parser → returns `unsupported_url` (HTTP 400) if `null`.
   - Calls oEmbed → uses result if present, else returns the parsed identity with `label: null` (HTTP 200, never a hard failure on lookup).
   - Response: `{ providerId, videoId, pageUrl, label, providerName }`.
   - Annotations: `@NoAdminRequired`, throttled.
4. `appinfo/routes.php` — register the route.
5. `tests/Unit/Service/VideoUrlParserTest.php` — every supported URL form + malformed input + generic fallback.
6. Run `docker exec -u www-data master-nextcloud-1 sh -c "cd /var/www/html/apps-extra/playbacksync && phpunit"`.

### Task 3 — Frontend: `metadataApi.ts`

Single-function service mirroring `playlistApi.ts`. Returns `null` on network / 400 errors (caller treats absence as "no label fetched"). Uses Nextcloud route generator for the URL.

### Task 4 — Frontend: create dialog seed entry

Edit `RoomCreateDialog.vue`:

- Add a `label` ref + a `lookupPending` ref + a `lookupResult` ref `({ providerId, videoId, providerName } | null)`.
- Watch `bootstrapUrl` debounced 400ms: when `singleMode === true` and the URL passes the existing `bootstrapUrlError` check, call `metadataApi.lookup`. Set `label.value` from the result if the user hasn't already typed one (track a `labelTouched` flag).
- Template: when `singleMode === true`, render under the bootstrap URL field:
  - `NcLoadingIcon` while `lookupPending`.
  - A small preview line (`<p>` with provider chip + title) when `lookupResult` is set.
  - A second `NcTextField` for `label` (`:label="Video title"`, optional, helper "We'll auto-fill this from the page when we can").
- Helper text on the bootstrap URL field gets a single-mode variant: "The video everyone will watch. The playlist will be locked to just this one." (otherwise the existing "The page participants will be redirected to.").
- `canSubmit` gains a guard: when `singleMode === true`, also require `bootstrapUrl` to have parsed successfully (i.e. `lookupResult !== null` *or* a failed lookup but URL was valid — already covered since `lookupResult` is set even on oEmbed miss).
- Submit payload (single-mode branch): append `initialEntries: [{ providerId: lookupResult.providerId, videoId: lookupResult.videoId, pageUrl: bootstrapUrl, label: label.value || null, source: 'curated' }]`.
- Reset all new refs in the `watch(() => props.open, …)` block.

### Task 5 — Frontend: mode picker in PlaylistEditor header

Edit `PlaylistEditor.vue`:

- Replace the static badge at lines 8–10 with `NcSelect` bound to a computed `modeChoice` (`'default' | 'single' | 'freeform'`). Options: localized labels with the same three modes; `:reduce` to the string key; `:clearable="false"`.
- Compute getter: derives from `props.room.singleMode` / `freeformMode`. Setter (or `@update:modelValue` handler) maps the picked key to a `(singleMode, freeformMode)` pair:
  - `'default'` → `(false, false)`
  - `'single'` → `(true, false)`
  - `'freeform'` → `(false, true)`
- If the new choice is `'single'` and `entries.value.length > 1`, set `confirmingLock = true` (new ref) — opens an `NcDialog` mirroring the existing "Clear playlist?" confirm at lines 163–187, with copy: "Lock the playlist? Existing entries stay, but no new ones can be added until you toggle single mode off." Buttons: Cancel / Lock playlist. On cancel, the local `modeChoice` ref is reverted to the previous value (use a pending-mode ref so the dropdown doesn't flicker). Only after confirmation does `roomsStore.updateSettings` fire.
- Otherwise call `roomsStore.updateSettings(props.room.uuid, singleMode, freeformMode)` directly.
- Preserve the colored badge cue: apply `modeBadgeClass` to a small `<span>` chip next to the dropdown, or to the `NcSelect` wrapper itself.
- `toggle_conflict` toast already exists in the store — no new handling needed (it can't be triggered by this UI since the picker is exclusive, but the server-side check remains a defence-in-depth path).
- Confirm the `singleMode`/`freeformMode` reactivity already flows from the room object so the picker reflects the new mode immediately after `updateSettings` resolves (it does — see `isSingleMode` at line 244 sourcing from `props.room.singleMode`).

### Task 6 — l10n pass

Every string added in Tasks 4–5 keyed in both `l10n/en.js` and `l10n/nl.js`. Real Dutch translations (e.g. "Lock the playlist?" → "Afspeellijst vergrendelen?"). Run a grep diff to confirm parity. Remove any keys made dead by this work.

### Task 7 — Manual verification

Per [CLAUDE.md](../../../CLAUDE.md): start the dev server and exercise the feature in a browser.

Walk all of the following end-to-end with two browser windows (owner + viewer):

1. **Rick Astley flow.** Open the create dialog. Tick "Single mode". Paste `https://www.youtube.com/watch?v=dQw4w9WgXcQ`. Wait ~400ms; confirm the title "Rick Astley — Never Gonna Give You Up" appears in the preview line and pre-fills the label field. Submit. The room opens with a one-entry locked playlist. Open `RoomDetailDialog` → Playlist tab; confirm "Add entry" and "Clear all" are disabled with the locked tooltip.
2. **Stale-tab steering still works.** From a second browser, open a different YouTube video, then join the room via the share link. Confirm the tab navigates to the Rick Astley URL (steering — single mode does not punish stale joiners, per the doc).
3. **Mode picker toggles.** As the owner, open the mode dropdown in the playlist header. Pick "Default mode". Confirm the picker reflects the new value, the colored mode chip updates, "Add entry" enables, and `updateSettings` was called. Add a sequel via the normal flow. Cursor now movable across two entries.
4. **Toggle-on warning.** With two entries present, open the dropdown and pick "Single mode". Confirm the "Lock the playlist?" dialog appears with the warning copy. Cancel — the dropdown snaps back to "Default mode", no API call fires. Re-open, confirm — the playlist becomes immutable, the picker stays on "Single mode".
5. **Mutual exclusion.** Pick "Freeform mode" from the picker while in Single. Confirm the picker emits `(false, true)` (not `(true, true)`) so `toggle_conflict` never fires from the UI; round-trip with the backend succeeds.
6. **Unsupported URL.** In the create dialog with Single ticked, paste a non-video URL (`https://example.com/about`). Confirm the lookup returns `unsupported_url`, the preview shows "Could not detect a video on this page", and submit is blocked. Switch to default mode and confirm the dialog reverts (bootstrap field accepts the URL as a generic landing page).
7. **oEmbed fallback.** Paste a valid YouTube URL but simulate the oEmbed call failing (e.g. block `youtube.com/oembed` via devtools network tab). Confirm the preview shows "Title not found, will use URL" and the label field stays empty but submit still works; the persisted entry has `label: null`.

## Verification

- `phpunit` passes: `docker exec -u www-data master-nextcloud-1 sh -c "cd /var/www/html/apps-extra/playbacksync && phpunit"`.
- `npm run lint` and `npm run build` pass.
- Type-check via `vue-tsc` if configured (`npm run typecheck` if available).
- Manual walkthrough of all seven scenarios above with two browser windows.
- l10n parity: `grep -c "':" l10n/en.js` matches `grep -c "':" l10n/nl.js`; no untranslated keys.
- Cross-check: open a single-mode room created via Task 4, then issue a `PLAYLIST_UPDATE` from devtools / a raw WS connection — confirm the existing `single_mode_locked` error path still fires (no regression on the already-shipped backend enforcement).
