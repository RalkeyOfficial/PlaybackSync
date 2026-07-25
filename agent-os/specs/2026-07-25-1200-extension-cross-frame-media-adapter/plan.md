# Cross-Frame Media Adapter (miruro → strm.cx embed)

## Context

miruro changed its watch page: the `<video>` no longer lives in the miruro
document. The page renders `#app … strmcx-embed` (an **open** shadow root)
containing an `<iframe src="https://strm.cx/?embed=1">` — a **cross-origin**
frame — and the real Vidstack `media-player → media-provider → <video>` (blob
src) lives inside that strm.cx document. The extension's content script runs
top-frame only, and Same-Origin Policy walls off the iframe, so
`MiruroAdapter.resolveVideo()` (`waitForElement('strmcx-player media-provider
video')` against the top document) can never resolve — every miruro sync is dead
on arrival.

Confirmed live with a throwaway probe (`extension/../debug-ext/`, an unpacked
diagnostic extension): a content script injected into the strm.cx frame sees
`video=YES`, `readyState 4`, a blob source, within ~1 s on its own, and reports
it up via `window.top.postMessage`.

Root cause is architectural: `BaseAdapter` **fused identity and video** in one
sealed lifecycle running in one frame. The video and the identity now live in
two frames (different origins). This isn't miruro-specific — third-party embed
players (strm.cx and others) are a recurring pattern and the extension is
explicitly multi-site — so the fix generalises the adapter model to **span
frames**.

## Decisions (locked from shaping)

- **Two roles, two content scripts, two runtimes.** A `PageRole` (top frame:
  identity/catalog/cursor/nav-guard) and a `MediaRole` (embed frame: the
  `<video>` and all playback I/O). Role is decided by *which* content script is
  running, not by runtime branching — a cross-origin boundary is a separate JS
  realm, so capability flags on one class cannot span it.
- **Bridge through the background, not direct `postMessage`.** Keeps all
  cross-frame traffic inside the extension (invisible to both pages' JS),
  survives iframe reloads (the background persists), reuses existing plumbing.
- **Background is frameId-aware.** Capture `sender.frameId`; route
  `play`/`pause`/`seek`/`nudge_rate` → media frame, `cursor_change` + notices →
  page frame. Broadcast fallback when `mediaFrameId` is unknown; stale-id
  pruning on a failed targeted send.
- **Media-frame `fail` is soft.** A videoless embed must not tear down the room
  the page frame established — the media fail just forgets the media frame.
  Page-frame `fail` keeps today's teardown (creds-clear behaviour unchanged; the
  new `resolveReady()` wait makes spurious identity misses rare).
- **The generic media adapter carries no miruro knowledge.** `strmcx` plays
  whatever `<video>` the embed hosts; one media adapter serves every page site
  embedding strm.cx.
- **Nav-guard and `miruro/url.ts` untouched.** The guard is entirely
  top-frame/URL-based and keeps working — miruro keeps `?ep=` in the top URL.
- **No `<all_urls>`.** strm.cx is a tightly enumerated `EMBED_MATCHES` entry.
- **Roadmap patch:** Phase 2 gains a cross-frame-adapter work item (Task 1).

## Critical files

### Created
- `extension/entrypoints/media.content.ts` — media-role content script (`EMBED_MATCHES`, `allFrames`), boots the media runtime with a media bridge.
- `extension/src/adapters/embed-matches.ts` — `EMBED_MATCHES` single source of truth for embed hosts (strm.cx).
- `extension/src/adapters/media/base.ts` — `MediaBaseAdapter`: video mechanics lifted verbatim from the old `base.ts` (teardown, autoplay hold, intent wiring, command switch, `getState`/`setPlaybackRate`).
- `extension/src/adapters/media/runtime.ts` — media runtime: select by `canHandleFrame`, 1 Hz status poll, nudge math, `deliverCommand`, emits `media_hello`.
- `extension/src/adapters/media/registry.ts` — `MEDIA_ADAPTERS` + `selectMediaAdapter`.
- `extension/src/adapters/strmcx/index.ts` — generic strm.cx `MediaRole`: `resolveVideo` (plain `video` in-frame), `holdsAutoplay`. No `ensurePlayable` override (the embed self-loads).

### Modified
- `extension/src/adapters/types.ts` — split `Adapter`/`AdapterContext` into `PageRole`/`MediaRole` + `PageContext`/`MediaContext`; add `FrameRole`.
- `extension/src/adapters/base.ts` → `PageBaseAdapter` — identity/catalog/cursor only; new `resolveReady()` hook; `handlePageCommand` handles just `cursor_change`.
- `extension/src/adapters/runtime.ts` → page runtime — drop status/intent/nudge (moved to media runtime); keep navigation listeners.
- `extension/entrypoints/content.ts` — page bridge (`sendIdentity`/`sendCatalog`/`sendCursorTrigger`/`sendFail(role:'page')`); drops intent/status.
- `extension/entrypoints/background.ts` — `sender.frameId` threading; `tabFrames` map; role-scoped `fail`; frameId-targeted `dispatchCommand`/`dispatchNotice` + broadcast fallback + stale-id pruning; `media_hello` → learn `mediaFrameId` + resync.
- `extension/src/messages.ts` — add `media_hello`; add `role: FrameRole` to `fail`.
- `extension/src/background/tabs.ts` — `recordStatus` preserves the page `adapterId` (no longer clobbered by the media id).
- `extension/wxt.config.ts` — `host_permissions: [...ADAPTER_MATCHES, ...EMBED_MATCHES]`.
- `extension/src/adapters/miruro/index.ts` — reduced to `PageBaseAdapter`; add `resolveReady` (wait for `strmcx-embed`); remove video/ensurePlayable/hold.
- `extension/src/adapters/_template/index.ts` — page template (`templatePageAdapterFactory`).
- `extension/docs/{adapter-contract,architecture,adapter-miruro,README}.md` — document the two roles + media-frame model.

## Tasks

### Task 1 — Save spec documentation
Create this spec folder; patch `agent-os/product/roadmap.md` (Phase 2 item); update the four extension docs above and `README.md` §Spec history. **Done.**

### Task 2 — Contract refactor (`types.ts`)
`PageRole`/`MediaRole`, `PageContext`/`MediaContext`, `FrameRole`. **Done.**

### Task 3 — Split the base
`base.ts` → `PageBaseAdapter` (+`resolveReady`); new `media/base.ts` → `MediaBaseAdapter` (video mechanics verbatim). **Done.**

### Task 4 — Page runtime
`runtime.ts` + `content.ts`: identity/catalog/cursor/nav + `cursor_change`; drop video paths. **Done.**

### Task 5 — Media runtime
`media/runtime.ts`, `media/registry.ts`, `media.content.ts`, `embed-matches.ts`, `wxt.config.ts`. **Done.**

### Task 6 — Background bridge
`background.ts`, `messages.ts`, `tabs.ts`: frameId capture, `tabFrames`, role-scoped fail, frameId-targeted dispatch + fallback, `media_hello` resync. **Done.**

### Task 7 — Adapters
Reduce `miruro/index.ts` to page role (+`resolveReady`); create generic `strmcx/index.ts`. **Confirm the in-iframe selectors live** (Verification 1) before treating this closed. **Done pending live selector check.**

### Task 8 — Build + live sync test
`npm run compile` + `npm run lint` clean; `npm run build` + `npm run build:firefox`. **Done.** Two-browser sync smoke: **pending user.**

## Verification

1. **Confirm strm.cx internals live** (before finalising the media adapter):
   reload `debug-ext/`, open a miruro watch page (devtools closed), read the
   panel's `— subframes —` line. Confirm the in-iframe `<video>` selector (plain
   `video` today), that no manual-load button is needed (probe showed
   `paused=true rs=4` with no interaction), and enumerate any other embed hosts
   across miruro's servers to seed `EMBED_MATCHES`.
2. `cd extension && npm run compile` (tsc) and `npm run lint` — clean.
3. **Build both targets** — `npm run build && npm run build:firefox`. Confirm
   the built manifests carry strm.cx in `host_permissions` and `media.js` with
   `all_frames: true`; page/credentials scripts stay top-frame.
4. Load unpacked (Chrome) / temporary add-on (Firefox); open a miruro watch page:
   - page frame reports identity + catalog (JOIN fires); media frame resolves the
     video and sends `media_hello`.
   - **Two-browser sync smoke** (per `MEMORY.md` WS-server dev startup): join the
     same room from two profiles; verify play/pause/seek mirror, and that an
     episode switch (`cursor_change`) navigates only the top frame (embed not
     yanked to a miruro URL).
   - Cold start: autoplay held until the room's first command.
   - Iframe reload mid-session → `media_hello` re-learns `mediaFrameId` and
     resyncs to room playback.
5. Confirm no `chrome.*` in executable code; `debug-ext/` unloaded before shipping.

## Out of scope

- Other embed hosts beyond those enumerated in Verification 1 (each = a new
  `MediaRole` + `EMBED_MATCHES` entry; the registry supports it).
- Per-room multiplexed WS (still parked; per-tab client model unchanged).
- Softening page-frame `fail` credential teardown (kept as-is).
- A media-role `_template` (the `strmcx` adapter is the reference for now).
- `debug-ext/` — throwaway diagnostic, not shipped.
