# PlaybackSync — Documentation

PlaybackSync is a Nextcloud app that lets a small group of friends watch videos together in sync without anybody needing to relay the video stream itself. The server only coordinates "who is at what timestamp, and is the video currently playing or paused" — the video bytes still come from whatever streaming site the participants are watching, just like they would if everybody were watching alone. That design choice is what makes PlaybackSync viable on a low-bandwidth self-hosted Nextcloud instance: synchronizing playback positions costs almost nothing in terms of network traffic, while relaying actual video to a half-dozen friends would saturate most home connections.

This documentation is aimed at the developer maintaining the app — the kind of read you do six months from now when you've forgotten exactly why the password is hashed twice or why the rooms table doesn't have a `last_state` column yet. It is not user-facing documentation; for the end-user view (one paragraph that says "click create, copy the link, share with friends"), the in-app strings already cover that.

## How to read these documents

Start with [architecture.md](architecture.md) if you want the big picture: what the layers are, how a request flows from a button click in the browser all the way to a row in the database, and where the boundaries are between PlaybackSync code, Nextcloud platform code, and third-party libraries. Once you have that map in your head, the layer-specific documents will make a lot more sense.

If you are diving into a specific change — fixing a bug in the create-room flow, adding a new API endpoint, tweaking the dialog UX — go to the layer-specific document directly. The [backend.md](backend.md) document covers everything that runs server-side in PHP, organized by the same layered structure you'd see in `lib/`. The [frontend.md](frontend.md) document covers the Vue 3 single-page app under `src/`, including how the Pinia store coordinates the dialogs and how the components are split.

The [api.md](api.md) document is the reference for the HTTP surface — endpoints, payloads, status codes, and worked-out `curl` examples. It is also the contract that both the backend controller and the frontend API service have to honor; if you change one, this is where you reconcile them.

Finally, [configuration.md](configuration.md) covers the operational side: what `IAppConfig` keys exist, how to set them with `occ`, how the background job that prunes expired rooms is wired up, and the basic dev-loop workflow inside the Nextcloud Docker dev environment.

## Where the docs end and other things begin

Anything project-shaping — the mission, the roadmap, individual feature specs — lives under [`agent-os/`](../agent-os/) rather than here. The [agent-os/product/](../agent-os/product/) folder has the mission, target users, and roadmap; the [agent-os/specs/](../agent-os/specs/) folder has per-feature shape documents that explain *why a particular slice of the codebase exists and what alternatives were considered*. Those documents are the historical record; the docs in this folder describe what the code currently is.

The legacy Node.js implementation lives untouched under [`OLD_CODE/`](../OLD_CODE/). It is a useful reference for the WebSocket protocol design and the playback-state model, both of which will be ported into the Nextcloud app in a later phase. The [`OLD_CODE/docs/`](../OLD_CODE/docs/) folder in particular has the protocol diagrams and the drift-correction algorithm; treat those as the design intent for Phase 2.

## Current status, briefly

The MVP foundation is in place: users can create, list, and delete rooms through the Nextcloud UI; rooms persist in the Nextcloud database; expired rooms are cleaned up by a background job. There is no WebSocket sync server yet, no public participant join flow, and no browser extension — those are deliberately deferred so each can be built and verified in isolation. See [`agent-os/product/roadmap.md`](../agent-os/product/roadmap.md) for what is planned next.
