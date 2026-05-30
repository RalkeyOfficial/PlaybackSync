# Suggest a Mode from the Bootstrap URL

## Context

When creating a room in PlaybackSync, the owner pastes a **bootstrap URL** and then
manually decides the playlist behaviour via two toggles in
[RoomCreateDialog.vue](../../../src/components/RoomCreateDialog.vue): *Single* and
*Freeform* (both off = *Default*). Nothing helps them pick. The
[EXTENSION_TODO.md](../../../EXTENSION_TODO.md) §"Other changes" item asks the modal to
inspect the URL and **suggest a mode**: a plain video (e.g. a single YouTube watch URL)
is a good fit for *Freeform* ("movie night"), whereas a URL that already implies a list/
catalog (YouTube `?list=`, miruro, Crunchyroll) is fine on the *Default* planned-playlist
behaviour and needs no nudge.

This is a **frontend-only** change. At room-creation time the Nextcloud dashboard can
only classify by URL *shape* — the browser extension's catalog detection
(`scrapeCatalog`, `#episodes-list-container`) is not reachable here, and no backend
field changes. The existing parser [parseVideoUrl.ts](../../../src/util/parseVideoUrl.ts)
already recognises the relevant hosts but discards the YouTube `list=` param, so a small
sibling classifier is the natural home for the logic.

**Outcome:** when the pasted URL looks like a standalone video and the form is still on
Default, the modal shows a dismissable `NcNoteCard` hint with a one-click "Use freeform
mode" button. It never silently overrides the owner's choice, and per the confirmed
mapping it stays quiet for list/catalog/unknown URLs.

## Decisions (confirmed with user)

- **UX:** Hint note + Apply button (`NcNoteCard`). Never auto-flip the toggle behind the
  user's back.
- **Mapping (TODO as-is):**
  - plain YouTube / Vimeo video → suggest **freeform**
  - YouTube with `?list=` → **default** (no nudge)
  - miruro / Crunchyroll watch URLs → **default** (no nudge)
  - unknown host → **no suggestion**
- **Single mode is never suggested** — it stays a deliberate owner choice.
- **Only the freeform direction is surfaced.** The classifier returns the full
  classification (`'default' | 'freeform' | null`) for testability, but the modal renders
  a note only for `'freeform'` while the form is still on Default. Nudging *back* to
  Default is a deliberate non-goal (honours "suggest nothing (default)").

## Task 1: Save spec documentation

Create `agent-os/specs/2026-05-30-1110-suggest-mode-from-bootstrap-url/` with plan.md,
shape.md, standards.md, references.md, and an empty visuals/ folder.

## Task 2: Fix the broken Single / Freeform toggles (pre-existing bug)

The two `NcCheckboxRadioSwitch` toggles in `RoomCreateDialog.vue` (lines 83–99) don't
respond to clicks. On `@nextcloud/vue` 9.8.0 the component emits **`update:modelValue`**,
but these two switches listen for the legacy **`@update:checked`** event (lines 87 and
97), which v9 never fires — so `onSingleModeChange` / `onFreeformModeChange` are never
called and the mode never changes. Every other switch in the app already uses the correct
event (e.g. `AdminSettings.vue:100`, `AdminSettings.vue:195`).

Fix: change `@update:checked` → `@update:modelValue` on both switches. No handler-body
changes needed — they already take the boolean payload.

## Task 3: Add the URL classifier util

New file `src/util/suggestMode.ts`, mirroring the host-parsing style of `parseVideoUrl.ts`
(same URL construction, `protocol` guard, `host = hostname.toLowerCase().replace(/^www\./, '')`).

```ts
export type ModeSuggestion = 'default' | 'freeform'

/** Classify a bootstrap URL into the mode that best fits it, or null when unknown. */
export function suggestMode(rawUrl: string): ModeSuggestion | null
```

Logic:
- Invalid / non-http(s) URL → `null`.
- YouTube hosts (`youtube.com`, `m.youtube.com`, `music.youtube.com`, `youtu.be`):
  `url.searchParams.has('list')` → `'default'`, otherwise → `'freeform'`.
- Vimeo (`vimeo.com`, `player.vimeo.com`) → `'freeform'`.
- miruro family (`miruro.tv` / `.to` / `.bz` / `.ru`) → `'default'`.
- Host ends with `crunchyroll.com` → `'default'`.
- Anything else → `null`.

Keep it a pure function with no Vue deps so it stays trivially unit-testable.

## Task 4: Wire the hint into RoomCreateDialog.vue

- Import `NcNoteCard` and `suggestMode`.
- Add `suggestionDismissed = ref(false)`.
- Add `computed` `modeSuggestion = suggestMode(bootstrapUrl.value.trim())` guarded by
  `bootstrapUrlError.value === null`.
- Add `computed` `showFreeformSuggestion` true when
  `modeSuggestion === 'freeform' && !singleMode.value && !freeformMode.value && !suggestionDismissed.value`.
- Template: render `NcNoteCard type="info"` immediately before the modes fieldset, gated
  by `v-if="showFreeformSuggestion"`, with body text + an `NcButton` ("Use freeform mode")
  and a tertiary dismiss button.
  - "Use freeform mode" → `freeformMode.value = true`. The note self-hides.
  - Dismiss → `suggestionDismissed.value = true`.
- Reset `suggestionDismissed.value = false` in the `props.open` open-reset watcher and in
  the existing `watch([bootstrapUrl, singleMode], …)`.

## Task 5: Localization keys

Add to **both** `l10n/en.js` and `l10n/nl.js` (real Dutch translation):

- Note body, e.g. `"This looks like a standalone video. Freeform mode lets whoever’s picking lead — a good fit for movie nights."`
- Button: `"Use freeform mode"`
- Dismiss: reuse existing `"Dismiss"` if present, else add one.

## Verification

No frontend unit-test runner is wired (only `OLD_CODE` has tests; `package.json` has no
`test` script). Verify manually:

1. `npm run build` — compiles, ESLint passes.
2. Open **Create a new room**; confirm Single/Freeform switches toggle on click and stay
   mutually exclusive (Task 2).
3. Suggestion cases: plain YouTube → note + apply flips Freeform; YouTube `?list=` → no
   note; miruro/Crunchyroll watch → no note; non-video host → no note; Single on + plain
   YouTube → no note; dismiss then edit URL → note re-offers.
4. Both `l10n/en.js` and `l10n/nl.js` carry the new keys; Dutch renders under `nl`.

## Out of scope

- Backend changes (mode flags already exist).
- Extension-side catalog detection feeding the suggestion.
- Suggesting Single mode, or nudging *back* to Default for list/catalog URLs.
