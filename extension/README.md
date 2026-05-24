# PlaybackSync — Browser Extension

WXT-based browser extension that synchronises video playback across a PlaybackSync room. One source builds Chromium MV3 and Firefox MV2.

For deeper documentation see [`docs/`](docs/) — architecture, protocol-client, adapter contract, storage schema.

## First-time setup

```sh
npm install
```

The `postinstall` hook runs `wxt prepare`, which generates `.wxt/tsconfig.json` (the file the root `tsconfig.json` extends from). Run it manually if you ever need to regenerate:

```sh
npx wxt prepare
```

## Development

```sh
npm run dev           # Chromium (launches a fresh browser profile with HMR)
npm run dev:firefox   # Firefox
```

WXT's runner only auto-discovers browsers installed in standard locations. For anything else (Thorium, Brave Beta, Chromium snap, Firefox flatpak, …) create a local `web-ext.config.ts` — gitignored, per-machine — for example:

```ts
import { defineRunnerConfig } from 'wxt'

export default defineRunnerConfig({
	binaries: {
		chrome: '/usr/bin/thorium-browser-avx2',
	},
})
```

## Production build

```sh
npm run build         # → .output/chrome-mv3/
npm run build:firefox # → .output/firefox-mv2/
npm run zip           # zip the build for distribution
```

## Layout

```
entrypoints/
  background.ts        # service worker / background page; boots the WS client
  content.ts           # injected on every page; selects an adapter
  popup/               # toolbar popup (placeholder)
src/
  adapters/            # plugin contract + per-site adapters (_template is the baseline)
  background/          # WS client: protocol, session, ws, storage, tabs
  messages.ts          # content ↔ background envelope
public/
  template-test.html   # smoke-test page for the _template adapter
docs/                  # architecture, protocol-client, adapter contract, storage
wxt.config.ts          # manifest + build config (replaces hand-written manifest.json)
```

## Smoke test against a real sync daemon

The WS client connects on background-worker boot if credentials are present in `chrome.storage.local.pbsync`. To exercise the full v2 protocol end-to-end:

1. **Start the daemon.** In the Nextcloud app container:
   ```sh
   occ playbacksync:ws-serve
   ```
2. **Create a room.** From the PlaybackSync dashboard (`/apps/playbacksync/`), create a room. Copy the WebSocket URL and the one-time password from the create-room dialog.
3. **Seed the creds.** With `npm run dev` running, open the extension's background-worker DevTools (chrome://extensions → PlaybackSync → "service worker") and run:
   ```js
   chrome.storage.local.set({
     pbsync: {
       syncUrl: 'wss://<host>/index.php/apps/playbacksync/ws/<uuid>',
       syncPassword: '<password>',
     },
   })
   ```
   Reload the extension (chrome://extensions → reload). The background console should log `connecting → open → JOIN sent → ROOM_STATE`.
4. **Drive the test.** Open two tabs of `chrome-extension://<id>/template-test.html?pbsync-template`. Play / pause / seek in tab A — tab B should mirror within a few hundred milliseconds. The background console shows `EVENT` frames going out and `STATE` frames coming back; the suppressed-echo path keeps the round-trip from looping.
5. **Reconnect check.** Stop the daemon, wait a few seconds, restart it. The background console should log reconnect attempts with exponential backoff and, once it succeeds, a `ROOM_STATE` carrying `recentEvents` (the events the tombstone replayed).

If you don't have a daemon handy, the extension still compiles, lints, and loads — it just sits idle without creds and prints a one-line hint into the background console.

## Documentation policy

Everything in this directory follows the documentation policy declared in `agent-os/specs/2026-05-24-1230-extension-ws-client/`: per-file module JSDoc, per-export JSDoc, per-feature markdown under [`docs/`](docs/). Don't merge code that adds new exports without docs.
