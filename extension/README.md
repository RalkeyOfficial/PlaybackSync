# PlaybackSync — Browser Extension

WXT-based browser extension scaffold for [PlaybackSync](..). Targets Chromium
and Firefox from one source.

## First-time setup

```sh
npm install
```

The `postinstall` hook runs `wxt prepare`, which generates `.wxt/tsconfig.json`
(the file the root `tsconfig.json` extends from). Run it manually if you ever
need to regenerate:

```sh
npx wxt prepare
```

## Development

```sh
npm run dev           # Chromium (launches a fresh browser profile with HMR)
npm run dev:firefox   # Firefox
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
  background.ts        # service worker (MV3) / background page (Firefox MV2)
  content.ts           # injected on the sites in `wxt.config.ts` host_permissions
  popup/
    index.html         # toolbar-icon popup
    main.ts
public/
  icon/                # drop icon-16.png, icon-32.png, etc. here (WXT picks them up)
wxt.config.ts          # manifest + build config (replaces hand-written manifest.json)
```

The placeholder `host_permissions` (`miruro.tv/.to`) are inherited from the
old prototype — update them to whatever streaming sites this extension should
attach to.
