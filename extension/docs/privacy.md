# Privacy Policy

This document is the source of truth for the data-handling claims the extension makes. It is referenced by the store listing ([`store-listing.md`](store-listing.md)) and is the text that should be hosted at the privacy-policy URL submitted to the Chrome Web Store and Mozilla Add-ons.

Last reviewed: 2026-05-25.

## Summary

PlaybackSync is a "bring your own server" extension. It connects to a WebSocket endpoint on the Nextcloud instance you point it at, and to no other server. It does not collect analytics, telemetry, crash reports, or behavioural data. It does not send any data to the extension authors, to Anthropic, to Mozilla, to Google, or to any third party.

If you do not run a Nextcloud server with the PlaybackSync app installed, the extension produces zero network traffic.

## What the extension stores on your device

The extension stores exactly one object in browser-local storage (`chrome.storage.local`), under the key `pbsync`:

| Field | Value | When it is written |
|-------|-------|--------------------|
| `syncUrl` | The WebSocket URL of the room you joined (e.g. `wss://your-nextcloud.example/index.php/apps/playbacksync/ws/<room-uuid>`) | Once, on first share-link redirect |
| `syncPassword` | The one-time password for the room | Same |
| `clientId` | A server-assigned identifier issued by your Nextcloud server's sync daemon | After the first successful room join |

This object is required for the extension to reconnect to the room after a service-worker restart or a browser restart. Nothing else is stored.

Clicking **Leave Room** in the toolbar popup deletes the entire `pbsync` object. Uninstalling the extension also deletes it, per the browser's standard cleanup behaviour for `chrome.storage.local`.

The schema is documented in full in [`storage.md`](storage.md).

## What the extension transmits over the network

While a room is active, the extension keeps an outbound WebSocket open to the `syncUrl` you supplied. Over that connection it sends:

- The `clientId` and `syncPassword` to (re)authenticate, exactly once per connection.
- Play / pause / seek events you trigger on the synced video, with the playback position at the moment of the event.
- A periodic heartbeat (every 5 seconds) carrying the current playback position and play / pause state, so the room can detect when a viewer has drifted.
- A page-identity message identifying which video the viewer is currently watching — provider name (e.g. `miruro`), a video identifier derived from the URL (e.g. `<showId>-ep<episodeNumber>`), and a normalised version of the page path. No browsing history, cookies, or other page contents are transmitted.

The extension transmits **only** to the `syncUrl` you have supplied. It does not connect to any other endpoint, does not contact the extension authors' infrastructure (there is none), and does not contact the browser vendor's infrastructure beyond standard browser-level update checks that are out of the extension's control.

## What the extension does not do

- It does not include analytics, telemetry, crash reporting, A/B testing, or remote-config systems.
- It does not load third-party scripts.
- It does not read tab URLs or page contents on any site outside the enumerated host allowlist declared in the manifest's `host_permissions` field.
- It does not modify pages on any site outside that allowlist.
- It does not have access to your browser history, bookmarks, downloads, cookies for unrelated sites, password manager, or any other browser data.
- It does not bypass paywalls, DRM, geo-restrictions, or any other access control on the streaming sites it supports.
- It does not host or proxy video. The video plays directly from whichever streaming site you have opened.

## Permissions and what they are used for

| Manifest permission | Why the extension needs it |
|---------------------|----------------------------|
| `storage` | Persists the `pbsync` object described above. |
| `alarms` | Wakes the background service-worker on a schedule so the WebSocket heartbeat can fire (MV3 service-workers idle out and need an alarm to wake). |
| `tabs` | Identifies which tab is currently being synced so the toolbar icon can flip between greyscale (idle) and colour (synced) and so room commands are routed to the right tab. The extension does not read tab URLs or titles outside the host allowlist. |
| `host_permissions` (enumerated) | The exact list of streaming sites the bundled site adapters support. Currently: `miruro.tv`, `miruro.to`, `miruro.bz`, `miruro.ru`. Adding a site requires a code change and a new extension release. |

## Data controller

There is no central data controller. The Nextcloud server you connect to is operated by you (or by whoever set up the PlaybackSync room you joined). The extension is a client that connects to that server on your behalf.

If you joined a room hosted by someone else, ask them how they handle the data their sync daemon receives.

## Your rights

Because the extension does not transmit data to any party other than the Nextcloud server you have explicitly chosen, the standard data-subject rights (access, deletion, portability) apply to that server's operator, not to the extension or its authors.

To wipe the data the extension itself stores: click **Leave Room** in the toolbar popup, or uninstall the extension.

## Children

The extension has no minimum age requirement, but it should only be used together with content the user is legally permitted to view. The streaming sites the bundled adapters target are operated by independent third parties; the extension does not control or endorse the content on them.

## Changes to this policy

The canonical version of this document lives in the project source tree at [`extension/docs/privacy.md`](privacy.md). Any change ships in the same release as the change it documents. The hosted version at the URL submitted to the stores is updated from this file.

## Contact

Issues, questions, and corrections: open an issue on the project repository linked from the store listing. There is no separate contact channel.
