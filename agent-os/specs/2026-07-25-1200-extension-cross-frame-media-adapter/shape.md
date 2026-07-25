# Cross-Frame Media Adapter — Shaping Notes

## Scope

miruro moved its player into a cross-origin `strm.cx` iframe, so the top-frame
content script can no longer find or drive the `<video>`. Split the site adapter
into a **page role** (top frame: identity/catalog/cursor/nav-guard) and a
**media role** (embed frame: the `<video>` and playback I/O), bridged by a
frameId-aware background per tab. Ship a generic `strmcx` media adapter reusable
by any site that embeds strm.cx.

After this spec: two content scripts (page top-frame-only, media `all_frames`
scoped to embed hosts), two adapter base classes, and command routing that
targets the frame able to act on each command.

## Decisions

- **Two roles, two content scripts, two runtimes** — role chosen by which script
  runs, not runtime branching (a cross-origin frame is a separate JS realm).
- **Bridge via the background** (not direct `window.postMessage`) — cross-frame
  traffic stays inside the extension, survives iframe reloads, reuses plumbing.
- **Background frameId-aware** — `play`/`pause`/`seek`/`nudge_rate` → media
  frame; `cursor_change` + notices → page frame; broadcast fallback + stale-id
  pruning.
- **Media `fail` is soft** — a videoless embed must not tear down the room the
  page frame established. Page `fail` keeps today's teardown.
- **Generic media adapter** — `strmcx` carries no miruro knowledge; one media
  adapter serves every page site embedding that player.
- **Nav-guard + `miruro/url.ts` untouched** — the guard is top-frame/URL-based
  and keeps working (miruro keeps `?ep=` in the top URL).
- **`resolveReady()` replaces the implicit `<video>`-wait gate** on identity —
  the page adapter waits for `strmcx-embed` so `?ep=` has landed before reading
  identity.
- **Roadmap patch** — Phase 2 gains a cross-frame-adapter work item (Task 1).

## Considered & deferred

- **Minimal proxy (single top-frame adapter + remote `VideoController` over
  direct `postMessage`, background untouched).** Smallest blast radius (2 files,
  5 edits) but a leaky abstraction: the "dumb" iframe host still carries Vidstack
  load-button specifics, `getState` reads a cache that lags the real element,
  listeners fire with no `Event` object, and it's honest only while strm.cx is
  the sole embed. Rejected in favour of the role-split given the multi-site goal
  and the codebase's clean-contract style.
- **Broadcast commands + role-ignore (no background frameId).** Simpler, but a
  broadcast `cursor_change` reaching the embed frame is one default-`location.href`
  override away from navigating the iframe, and notices would mount a second UI
  inside the embed. FrameId targeting removes both failure classes structurally.
- **Other embed hosts.** Only strm.cx is enumerated; the media registry supports
  more, each a small per-host addition.

## Context

- **Visuals:** None. Playback behaviour is unchanged for the viewer; only the
  frame that hosts the `<video>` moved.
- **Diagnosis tool:** `debug-ext/` (throwaway unpacked probe) confirmed the
  video is reachable from inside the strm.cx frame and self-loads. Not shipped.
- **References:** see `references.md`. Memory `miruro-strmcx-iframe-embed.md`
  records the live diagnosis.
- **Product alignment:** Phase 2 of the roadmap; patched in Task 1.

## Standards applied

- **`tooling/build`** — WXT toolchain (`extension/package.json`). Keep
  `npm run compile` and `npm run lint` green; **build both targets**
  (`npm run build` + `npm run build:firefox`) — MV / frameId / `all_frames`
  differences surface at build/runtime, not always at typecheck. Real JSDoc, no
  SPDX/author headers (project rule from `CLAUDE.md`).
- **`frontend/vue-conventions`** — Not applicable; no Vue.
- **`backend/php-conventions`** — Not applicable; no PHP change (the daemon is
  frame-agnostic — both frames are one tab / one client).
