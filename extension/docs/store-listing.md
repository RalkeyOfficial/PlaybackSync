# Store Listing

Copy and metadata for the Chrome Web Store and Mozilla Add-ons (AMO) submissions. Update this file when the listing changes — the dashboards diverge over time, but this is the canonical source.

The store ID, public listing URL, screenshot files and the support email all live outside this file (per-environment), so this doc only carries text that is reviewed in PR.

## Short description (≤132 characters)

> Sync video playback across a Nextcloud-hosted room — one tab is authoritative, every joined tab follows in real time.

131 characters. The 132-character ceiling is Chrome's; AMO allows 250 but uses the same field for the summary, so the shorter line works for both.

## Long description

```text
PlaybackSync keeps a group of viewers on the same frame of the same video, even when nobody is in the same room.

How it works
- You run the PlaybackSync app on your own Nextcloud instance. It creates rooms with a one-time password and a share link.
- Each viewer opens the share link in a fresh tab. The extension picks up the room credentials from the redirect, joins the room, and starts following the authoritative timeline.
- When one viewer plays, pauses, or seeks, the room broadcasts that command and every other viewer's tab applies it. Small drifts are absorbed by tiny, inaudible playback-rate nudges; large jumps trigger a real seek.

What it supports today
- Streaming sites the extension has a dedicated site adapter for. The first release ships with adapters for the miruro family of sites (miruro.tv, miruro.to, miruro.bz, miruro.ru). Adding a new site is a code change — open a pull request.

What it does not do
- It does not bypass paywalls, DRM, geo-restrictions, or any other access control. If a viewer can't play the video on their own, the extension cannot change that.
- It does not host video or proxy traffic. The video plays directly from whichever site the room was opened on.
- It does not collect analytics, telemetry, crash reports, or any other data. The extension talks only to the Nextcloud-hosted sync daemon you point it at; see the privacy policy linked below.

Self-hosted by design
The extension is useless without a Nextcloud server running the PlaybackSync app. You are in control of the daemon, the rooms, the passwords, and the data — the extension authors, and the store have no part in the room session at all.

Source code, issue tracker, and the Nextcloud-app side of the project: https://github.com/RalkeyOfficial/PlaybackSync
Privacy policy: <hosted URL>
```

Free fields (homepage URL, support email, repository link) are filled in at submission time and are not in scope for this file.

## Category and labels

- **Chrome Web Store category:** Productivity. Secondary fits would be Entertainment, but Productivity matches the "watch-party for self-hosted users" framing better and avoids store-side categorisation as a video-streaming tool.
- **Chrome single purpose:** "Synchronise video playback across viewers in a self-hosted PlaybackSync room." Chrome requires a single-purpose description that matches the manifest and the listing copy — keep these three in lockstep.
- **AMO categories:** Other / Tabs (no perfect match — "Tabs" works because the extension's UX is a per-tab room indicator).

## Reviewer notes (private dashboard field)

Both stores have a free-text "notes to reviewer" box. Submit the following verbatim — the wording matches manifest permissions and the privacy policy, which is what reviewers cross-check.

```text
What the extension does

PlaybackSync synchronises a HTML5 <video> element across multiple viewers
who have all joined the same room on a Nextcloud server running the
PlaybackSync app. Each viewer must independently load the same streaming
page; the extension only co-ordinates play / pause / seek between them.

Permissions justification

- "storage": persists the room URL and one-time password in
  chrome.storage.local so the session survives service-worker restarts
  and page reloads. Cleared when the user clicks "Leave room" in the
  toolbar popup.

- "alarms": drives the WebSocket heartbeat and reconnect backoff on the
  background service-worker (MV3 workers idle out — chrome.alarms is the
  required wake-up mechanism).

- "tabs": needed to track which tab is currently being synced so the
  toolbar icon can flip between greyscale (idle) and colour (synced),
  and so authoritative commands from the room are delivered to the right
  tab. The extension does not read tab URLs or titles outside of the
  host_permissions allowlist.

- host_permissions: an enumerated allowlist of the streaming sites the
  bundled site adapters support (currently the miruro family). Adding a
  new site is a code change in src/adapters/runtime.ts plus a manifest
  bump in src/adapters/host-matches.ts. There is no wildcard or
  catch-all match.

How to test

1. Install the extension.
2. Visit https://www.miruro.to/watch/166617/fatestrange-fake?ep=4 . The
   extension stays idle (greyscale toolbar icon) — without a room
   credential it does nothing.
3. To exercise the full sync path you need a Nextcloud instance running
   the PlaybackSync app. The README at <repository URL> walks through
   the local development setup, including how to seed the credential
   manually so a reviewer can reproduce the synced state without
   spinning up a server.

Data handling

No analytics, telemetry, crash reports, or third-party services. The
only network traffic the extension produces is the WebSocket connection
to the sync daemon URL the user explicitly supplies via the share link.
Full data-handling statement at <privacy policy URL>.
```

When the listing actually goes live, replace each `<...>` placeholder with the real URLs.

## Screenshots

Stores require 1280×800 (Chrome) or at least 1000×750 (AMO). Five shots cover the listing without padding it:

1. **Idle state.** Adapter-supported page open, toolbar icon greyscale, popup says "No room". Establishes the "does nothing without a room" framing the reviewer notes promise.
2. **Connecting.** Toolbar icon greyscale (still — that flip is per-tab), popup amber pill "Connecting", room URL visible. Shows the share-URL handoff has happened.
3. **Joined, synced tab.** Toolbar icon colour, popup green pill "Joined", cursor block showing provider + label + clickable `pageUrl`. The money shot.
4. **Two tabs side-by-side mid-playback.** A second viewer's tab at the same timestamp. Demonstrates the actual product value.
5. **Leave Room.** Popup with the Leave Room button highlighted, or the state right after — pill grey, cursor block gone. Demonstrates the "user is in control" framing required for any extension that stores credentials.

Capture against `https://www.miruro.to/watch/166617/fatestrange-fake?ep=4` so reviewers can reproduce. Avoid copyrighted thumbnails — let Vidstack render the player UI without a poster frame, or pause on a colour bar.

## Promo tile

- Small: 440×280 (Chrome). The colour `icon-128` on a flat background with the wordmark, no taglines.
- AMO: no equivalent required at submission time. Skip until requested.

## Versioning policy for listings

- The manifest version is the source of truth — bump it before a release, not after. The store dashboards reject re-submitting the same version number.
- 0.x means pre-stable and is allowed by both stores, but flag it in the description ("Beta — feedback welcome at <issue tracker>").
- AMO additionally requires uploading the source code for any release that uses bundled / minified output. The `npm run build` and `npm run build:firefox` outputs in `extension/.output/` are bundled, so each AMO submission needs an accompanying source archive of the `extension/` directory with the README's build instructions intact.

## Pre-submission checklist

- [ ] `npm run zip` and `npm run zip:firefox` succeed locally.
- [ ] `web-ext lint` is clean against `.output/firefox-mv2/`.
- [ ] Manifest version bumped beyond the last submitted version.
- [ ] Privacy policy URL resolves and matches [`privacy.md`](privacy.md).
- [ ] Repository URL in the long description and reviewer notes resolves.
- [ ] Screenshots regenerated against the current popup UI.
- [ ] AMO submission has a source archive attached.
