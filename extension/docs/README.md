# PlaybackSync Extension — Documentation

The browser-extension side of PlaybackSync. Two-process architecture, plugin-based site support, talks to the [Nextcloud-app](../../) sync daemon over WebSocket.

This directory is the source of truth for *how the extension is shaped and why*. The wire format itself lives in the top-level [`docs/ws-protocol.md`](../../docs/ws-protocol.md); everything else has its own page here.

## Where to start

- **New to the codebase?** Read [`architecture.md`](architecture.md) first — the three-layer picture (background WS client / content runtime / per-site adapters) is the lens for everything else.
- **Writing a new site adapter?** [`adapter-contract.md`](adapter-contract.md) is the tutorial. Copy `src/adapters/_template/` and follow along.
- **Working on the protocol client?** [`protocol-client.md`](protocol-client.md) covers JOIN, reconnect, clock-sync, heartbeats, suppression — the WS-side concerns.
- **Setting up creds for dev?** [`storage.md`](storage.md) shows the `chrome.storage.local` shape and the DevTools snippet to seed it.
- **Touching the toolbar popup?** [`popup.md`](popup.md) covers the snapshot channel, the `PopupStatus` state machine, and the leave-room flow.
- **Submitting to a browser store?** [`store-listing.md`](store-listing.md) is the canonical copy + reviewer-notes source; [`privacy.md`](privacy.md) is the hosted privacy policy.

## Index

| Page | What's in it |
|------|--------------|
| [`architecture.md`](architecture.md) | Three-layer split, message envelope, where state lives, anchored-room pull-back + navigation-guard |
| [`protocol-client.md`](protocol-client.md) | Connection lifecycle, reconnect, heartbeat, clock-sync, drift handling, suppression, viewer-driven cursor changes + navigation-guard |
| [`adapter-contract.md`](adapter-contract.md) | `Adapter` / `AdapterContext` / `LocalIntent` / `AuthoritativeCommand` / `ContentIdentity` / `VideoState`, `guardNavigation` + the `videoIdForUrl` matcher, autoplay-hold — how to write an adapter |
| [`storage.md`](storage.md) | Per-tab `chrome.storage.local['pbsync.tab.<tabId>']` schema; cold-boot sentinel; dev-time creds workflow |
| [`popup.md`](popup.md) | Toolbar popup: snapshot channel, `PopupStatus`, leave-room flow |
| [`playlist-update.md`](playlist-update.md) | `sendPlaylistUpdate` background API for out-of-flow playlist contributions; freeform-chain rule; mode gating |
| [`store-listing.md`](store-listing.md) | Short / long descriptions, reviewer notes, screenshot brief, pre-submission checklist |
| [`privacy.md`](privacy.md) | Data-handling statement (the version hosted at the privacy-policy URL) |

## Documentation policy

Every TS file under `extension/src/` and every `entrypoints/*.ts` carries a module-level JSDoc block. Every exported symbol carries a JSDoc with a real description and filled-in `@param`/`@returns`. Every architecturally significant feature gets a page here. Don't merge code that adds new exports without docs.

This policy was declared in [`agent-os/specs/2026-05-24-1230-extension-ws-client/`](../../agent-os/specs/2026-05-24-1230-extension-ws-client/) and applies project-wide for the extension going forward.

## Spec history

The extension is being built in slices, each with its own spec under [`agent-os/specs/`](../../agent-os/specs/):

- [`2026-05-24-0959-extension-plugin-foundation`](../../agent-os/specs/2026-05-24-0959-extension-plugin-foundation/) — adapter contract + runtime + `_template`.
- [`2026-05-24-1230-extension-ws-client`](../../agent-os/specs/2026-05-24-1230-extension-ws-client/) — the WS client and documentation policy.

Future slices (credential pickup from share URLs, first real site adapter, popup UI) will add to this list.
