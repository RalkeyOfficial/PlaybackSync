# References for Suggest-a-Mode-from-Bootstrap-URL

## Similar Implementations

### URL host parser (style to mirror)

- **Location:** `src/util/parseVideoUrl.ts`
- **Relevance:** The new `src/util/suggestMode.ts` classifier mirrors its structure — a
  pure function, `new URL()` with a try/catch, an `http(s)` protocol guard, and
  `host = url.hostname.toLowerCase().replace(/^www\./, '')` host normalization.
- **Key patterns:** Recognises the same hosts (YouTube family, Vimeo, Crunchyroll). It
  already reads `searchParams.get('v')` but discards `list=`; the new util reads
  `searchParams.has('list')` to distinguish a playlist URL from a standalone video.

### Host component

- **Location:** `src/components/RoomCreateDialog.vue`
- **Relevance:** Holds the `bootstrapUrl` `NcTextField`, the `singleMode` / `freeformMode`
  toggles, the `bootstrapUrlError` validation computed, the `props.open` reset watcher,
  and the `watch([bootstrapUrl, singleMode], …)` — all of which the suggestion logic
  hooks into.
- **Key patterns:** `computed`-driven helper/label text already keys off mode state; the
  suggestion note follows the same reactive style.

### NcNoteCard precedent

- **Location:** `src/components/PlaylistAddDialog.vue:60`, `src/components/PlaylistEditor.vue:134`
- **Relevance:** Existing in-app `NcNoteCard` usage (with `type` and a default slot) to
  match for markup and import style (`@nextcloud/vue/components/NcNoteCard`).

### Correct NcCheckboxRadioSwitch event (Task 2 fix)

- **Location:** `src/views/AdminSettings.vue:100`, `src/views/AdminSettings.vue:195`
- **Relevance:** Shows the correct `:modelValue` + `@update:modelValue` pairing for
  `@nextcloud/vue` 9.8.0. `RoomCreateDialog.vue` used the legacy `@update:checked` event,
  which v9 never emits — the cause of the dead toggles.

## Product framing

- `MODES_UX.md` — plain-language description of Default vs Freeform that motivates the
  mapping (Default = playlist drives the cursor; Freeform = active person drives it).
- `agent-os/product/roadmap.md` §"Phase 2: Browser extension" — product-side framing.
