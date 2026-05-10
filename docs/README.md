# PlaybackSync — Documentation

PlaybackSync is a Nextcloud app that lets a small group of friends watch videos together in sync without anybody needing to relay the video stream itself. The server only coordinates "who is at what timestamp, and is the video currently playing or paused" — the video bytes still come from whatever streaming site the participants are watching, just like they would if everybody were watching alone. That design choice is what makes PlaybackSync viable on a low-bandwidth self-hosted Nextcloud instance: synchronizing playback positions costs almost nothing in terms of network traffic, while relaying actual video to a half-dozen friends would saturate most home connections.

This documentation is aimed at the developer maintaining the app — the kind of read you do six months from now when you've forgotten exactly why the password is hashed twice or why the rooms table doesn't have a `last_state` column yet. It is not user-facing documentation; for the end-user view (one paragraph that says "click create, copy the link, share with friends"), the in-app strings already cover that.

## How to read these documents

Start with [architecture.md](architecture.md) if you want the big picture: what the layers are, how a request flows from a button click in the browser all the way to a row in the database, and where the boundaries are between PlaybackSync code, Nextcloud platform code, and third-party libraries. Once you have that map in your head, the layer-specific documents will make a lot more sense.

If you are diving into a specific change — fixing a bug in the create-room flow, adding a new API endpoint, tweaking the dialog UX — go to the layer-specific document directly. The shortest path to whatever you're looking for is typically the table below.

| Document                                     | Best for…                                                                                                                                  |
|----------------------------------------------|--------------------------------------------------------------------------------------------------------------------------------------------|
| [architecture.md](architecture.md)           | The system overview, layer responsibilities, end-to-end request flow, where Phase 2 (WebSocket) and Phase 3 (extension) will plug in.      |
| [backend.md](backend.md)                     | PHP code under `lib/`: bootstrap, DB schema, entity & mapper, service rules, controller, routes, background job.                            |
| [frontend.md](frontend.md)                   | Vue code under `src/`: bundle entry, App layout, Pinia store, API service, dialogs, l10n, the `inlineCSS: true` Vite rationale.            |
| [api.md](api.md)                             | The HTTP REST contract: every endpoint with request/response shape tables, status codes, and `curl` examples.                              |
| [configuration.md](configuration.md)         | Operations: enabling the app, `IAppConfig` keys, `occ` commands, the prune background job, the npm scripts, dev-environment users.         |
| [ws-sync-server.md](ws-sync-server.md)       | Operator guide for the WebSocket sync daemon: starting it, sample systemd unit, Apache/nginx proxy snippets, app-config keys.              |
| [install-without-script.md](install-without-script.md) | Step-by-step manual install of the daemon for when the installer script fails or your environment is non-standard. Covers bare-metal and Docker, multiple proxies, common failure modes.            |
| [ws-protocol.md](ws-protocol.md)             | Wire-format contract for the WebSocket sync server: every message, every field, error codes, sequence diagrams.                            |

If you came here looking for product-level material — the mission, the roadmap, individual feature specs — those live separately. See the next section.

## Where the docs end and other things begin

Project-shaping documents — the mission, the roadmap, individual feature specs — live separately, alongside the legacy implementation that's being rewritten. Each lives in a different folder with a different purpose:

| Folder                                       | Purpose                                                                                                       | When to read it                                                       |
|----------------------------------------------|---------------------------------------------------------------------------------------------------------------|-----------------------------------------------------------------------|
| [`docs/`](.)                                 | What the code currently is. Reference material organized by layer.                                            | When implementing or maintaining a feature.                            |
| [`agent-os/product/`](../agent-os/product/)  | Mission, target users, roadmap. The "why we are doing this" file set.                                          | When planning a feature or arguing about scope.                        |
| [`agent-os/specs/`](../agent-os/specs/)      | Per-feature shape documents. The historical record of what was decided and what alternatives were considered.   | When you've forgotten *why* a particular slice of code exists that way.|
| [`OLD_CODE/`](../OLD_CODE/)                  | The archived legacy Node.js implementation, including the WebSocket protocol design and drift-correction algorithm. | When implementing Phase 2 (WebSocket sync) — treat as design intent.   |

## Current status, briefly

The MVP foundation is in place. Users can create, list, and delete rooms through the Nextcloud UI; rooms persist in the Nextcloud database; expired rooms are cleaned up by a background job. There is no WebSocket sync server yet, no public participant join flow, and no browser extension — those are deliberately deferred so each can be built and verified in isolation.

| Phase   | Capability                                  | Status      |
|---------|---------------------------------------------|-------------|
| Phase 1 | Owner-only room CRUD via Nextcloud UI       | **Shipped** |
| Phase 1 | Persistent rooms with TTL + hourly prune job| **Shipped** |
| Phase 2 | WebSocket sync server (drift correction etc.) | Planned   |
| Phase 2 | Public Basic-Auth-gated share endpoint      | **Shipped** |
| Phase 3 | Browser extension for streaming sites       | Planned     |

See [`agent-os/product/roadmap.md`](../agent-os/product/roadmap.md) for the canonical roadmap and what specifically is on deck next.
