# PlaybackSync debug probe

An **unpacked** browser extension for developing and diagnosing PlaybackSync
site adapters — without opening devtools (devtools itself can perturb lazy
player mounts, so it contaminates measurements). It draws an on-page panel that
works across frames, including cross-origin embed iframes (e.g. `strm.cx`).

This is a **development tool**, not part of the shipping extension — it's kept
in the repo so it stays available, but nothing here is built or bundled into
`extension/`.

## What it shows

The panel (draggable, collapsible sections, remembers its position) runs in the
top frame; a headless probe runs in every subframe and reports up via
`postMessage`, so a `<video>` locked inside a cross-origin iframe is still
visible — and controllable — from the panel.

- **Summary** — url, frame count, whether the embed host and a `<video>` are present, and which frame the video lives in.
- **Frames** — every frame (top + subframes) with host and video/readyState.
- **Selectors (the headline feature)** — a live watchboard of the selectors PlaybackSync's adapters use (embed host, episode list, `video`, `media-provider`, cold-start load button, …). Each row shows a **match count per frame** (`top:N`, `strm:N`), green when found, red when not. Click a row to outline + scroll to the match (top frame) or log where it matched. **Add your own selectors** in the input — they're pushed into every frame and evaluated there too.
- **Video state** — for whichever frame owns the video: src, `currentTime`/`duration` + %, buffered %, paused/playing, `playbackRate`, `readyState`/`networkState` (labelled), dimensions.
- **Playback controls** — play / pause / seek ±10s / seek-to-0 / rate 0.5–2×, acting on the video wherever it lives (relayed into the embed frame). Lets you confirm the video is controllable the way the real adapter drives it.
- **Advanced** — scroll-into-view, force-eager (Vidstack `load=eager`), synthesized Space on the load button, inspect-embed (shadow + iframe dump), deep-scan (composed path to `<video>`), **copy report** (full snapshot) / copy log / clear.
- **Log** — timestamped: video events (play/pause/seeking/ratechange/…) from every frame, `attachShadow` calls (from the MAIN-world hook), frame appearance, selector highlights.

## Load it (Chrome / the `npm run dev` browser)

1. `chrome://extensions` → enable **Developer mode**.
2. **Load unpacked** → select this `debug-ext/` folder.
3. Open a supported page (see `matches` in `manifest.json`). The panel appears. **Keep devtools closed.**

Reload from `chrome://extensions` after editing any file.

## Files

| File | World | Role |
|------|-------|------|
| `manifest.json` | — | MV3; matches miruro + strm.cx, `all_frames`. Add hosts here to probe other sites. |
| `main-world.js` | MAIN (`document_start`) | Read-only: reports every `attachShadow` call so the shadow tree can be watched. Does not mutate the page. |
| `overlay.js` | ISOLATED (`document_start`) | The panel (top frame) + the headless per-frame probe (subframes). All heavy DOM scanning is coalesced behind a 300 ms scheduler so page hydration can't freeze it. |

## Using it to develop a new adapter

1. Open the target site. Watch the **Selectors** board: red rows are selectors that don't match here — the video/player ones going green tells you where (and in which frame) the media lives.
2. Add candidate selectors in the input until you find stable ones that match exactly the element you want, in the right frame.
3. Use **Playback controls** to confirm that element is actually a controllable `<video>` from a content script in that frame — that's exactly what a `MediaRole` adapter does.
4. **copy report** to paste the selector/frame/video picture back into a discussion.

## Extending to other sites

Add host patterns to **both** `content_scripts` blocks in `manifest.json` (the
MAIN-world and ISOLATED entries), reload, and the panel works there too. Keep it
scoped rather than `<all_urls>` so it only injects where you're actually
working.

## Firefox note

`world: "MAIN"` content scripts need Firefox 128+. Load via `about:debugging` →
**Load Temporary Add-on** → pick `manifest.json`. On older Firefox the panel
still works but the `attachShadow` log won't (MAIN-world injection unavailable).
