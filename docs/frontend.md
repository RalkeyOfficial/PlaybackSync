# Frontend

The frontend lives under [`src/`](../src/) and is a small Vue 3 single-page application bundled by Vite. It is intentionally simple: there is no router, no view-layer state machine, no internationalization framework beyond what Nextcloud provides, and exactly one Pinia store. The whole UI is essentially "a list, a button, and two dialogs", which is why splitting it into anything more elaborate would be over-engineering. This document walks through the moving parts in roughly the order Vue would touch them on a fresh page load.

## Files at a glance

| File                                                                        | Role                          | Talks to store? | Talks to API? |
|-----------------------------------------------------------------------------|-------------------------------|-----------------|---------------|
| [`src/index.ts`](../src/index.ts)                                           | Bundle entry, Vue mount       | No              | No            |
| [`src/App.vue`](../src/App.vue)                                             | Root layout (`NcContent`)     | No              | No            |
| [`src/components/RoomsPanel.vue`](../src/components/RoomsPanel.vue)         | Orchestrator / state owner    | **Yes**         | No            |
| [`src/components/RoomList.vue`](../src/components/RoomList.vue)             | Presentational list           | No              | No            |
| [`src/components/RoomCreateDialog.vue`](../src/components/RoomCreateDialog.vue)   | Create form               | **Yes**         | No            |
| [`src/components/RoomCreatedDialog.vue`](../src/components/RoomCreatedDialog.vue) | One-time password dialog  | No (props only) | No            |
| [`src/stores/rooms.ts`](../src/stores/rooms.ts)                             | Pinia store (single source)   | —               | **Yes**       |
| [`src/services/roomsApi.ts`](../src/services/roomsApi.ts)                   | Typed `axios` wrappers        | No              | **Yes**       |
| [`src/types/room.ts`](../src/types/room.ts)                                 | TypeScript types              | —               | —             |

## Bundle entry and mounting

The bundle's entry point is [`src/index.ts`](../src/index.ts). It does three things and only three things: it creates a Pinia instance, it creates a Vue app from `App.vue`, it installs Pinia, and it mounts the app on `#playbacksync-root`. That mount target is the empty `<div>` rendered by `templates/index.php` from the PHP page response, so there is a clean boundary between Nextcloud's HTML shell (which provides the page chrome, dark theme, top bar, user menu) and the part the Vue app owns (everything inside that div).

There is deliberately nothing else in `index.ts`. We don't register global components, we don't install custom directives, we don't preload state. Pinia's lazy-store pattern means the rooms store doesn't actually exist until the first component that calls `useRoomsStore()` runs, which keeps the entry tree tiny and makes the bundle's startup cost minimal.

## The Vite config and CSS

[`vite.config.ts`](../vite.config.ts) uses `@nextcloud/vite-config`'s `createAppConfig` helper, which knows how to produce a bundle Nextcloud will accept (correct file naming, correct module type, correct license-extraction behavior). The one non-default we care about is `inlineCSS: true`, which makes Vite embed component styles directly into the JavaScript bundle so they get applied as soon as the bundle executes. Without that flag, Vite would emit separate hash-named CSS chunks (`main-DtQcGVuY.chunk.css` and friends) that the page never loads, because the PHP template only enqueues the JS module via `Util::addScript`. The result of *that* is a page where every `@nextcloud/vue` component renders unstyled, which is a confusing failure mode if you don't know what to look for. Inlining CSS sidesteps the whole issue at the cost of a slightly larger bundle.

The other Vite settings — license extraction, third-party-license handling, the additional `css/` directory in `emptyOutputDirectory` (which doesn't actually get created in `inlineCSS: true` mode but is harmless) — are stock Nextcloud-app defaults and don't need to be changed for normal feature work.

## App.vue

[`src/App.vue`](../src/App.vue) is the smallest possible useful App component. It wraps the page in `NcContent` (which provides the dark-theme background and the flexbox layout the Nextcloud shell expects), then puts a single `NcAppContent` inside it, and inside *that* mounts `RoomsPanel`. There is no `NcAppNavigation` and no nav rail at all, by design: every piece of management UI lives inside the dashboard. If we ever need a second view, we will add a router and an `NcAppNavigation` together; until then, neither earns its keep.

`appName="playbacksync"` on `NcContent` is what wires the component into Nextcloud's design tokens, telling it which app's icon and theming to inherit. That string is the same `APP_ID` the PHP side uses, just in lowercase.

## RoomsPanel

[`src/components/RoomsPanel.vue`](../src/components/RoomsPanel.vue) is the orchestrator for the entire feature. It's the only component that talks to the rooms store directly — every other component receives data through props or fires events. That keeps the data flow predictable: if you want to know "where does this room list come from?", the answer is always `RoomsPanel`, never one level deeper.

When mounted, it kicks off `store.load()` to fetch the current user's rooms. While the request is in flight and we have not yet seen any data, it shows a centered loading spinner. Once data has arrived, it either renders `RoomList` (if there are rooms) or `NcEmptyContent` (if there aren't). The reason the loading state is gated on `!store.loaded` rather than just `store.loading` is that subsequent loads — for example, after a refresh action — should not blank out the UI: we want them to feel like a soft refresh, not a full re-render.

`RoomsPanel` also owns the *open state* of the create dialog (a local `ref<boolean>`) and reads the *open state* of the created-room dialog from the store (`store.lastCreated`). That distinction is intentional: a fresh create-form is purely UI state with no need to survive a navigation or a store refresh, while the just-created-room information needs to persist across whatever component lifecycle decisions Vue might make and is therefore a store concern.

## The Pinia store

[`src/stores/rooms.ts`](../src/stores/rooms.ts) is the single source of truth for everything room-related on the client side.

### Store state

| Field          | Type                          | Resets when?                                              | Role                                                                                              |
|----------------|-------------------------------|-----------------------------------------------------------|---------------------------------------------------------------------------------------------------|
| `rooms`        | `Room[]`                      | On every successful `load()`; mutated by `create`/`remove`| The current user's active rooms, newest first.                                                    |
| `loading`      | `boolean`                     | After every `load()` settles                              | True while a list request is in flight. Drives the loading spinner.                               |
| `creating`     | `boolean`                     | After every `create()` settles                            | True while a create request is in flight. Disables form submission, blocks dialog dismissal.      |
| `loaded`       | `boolean`                     | First successful `load()` flips it to `true` permanently  | Distinguishes the cold-start spinner from soft-refresh in-place loads.                            |
| `lastCreated`  | `CreatedRoom \| null`         | Cleared by `dismissLastCreated()`                         | Holds the just-created room **including** the plaintext password, for the one-time-password dialog.|

### Store actions

| Action                       | Calls                              | Side effects on success                                                                  | Side effects on failure                                                |
|------------------------------|------------------------------------|------------------------------------------------------------------------------------------|------------------------------------------------------------------------|
| `load()`                     | `roomsApi.listRooms()`             | Replaces `rooms`; sets `loaded = true`.                                                  | Logs via `@nextcloud/logger`; shows generic error toast.               |
| `create(payload)`            | `roomsApi.createRoom(payload)`     | Prepends to `rooms`; sets `lastCreated` (with password).                                 | Surfaces server-supplied `error` text in toast when present, generic otherwise. |
| `remove(uuid)`               | `roomsApi.deleteRoom(uuid)`        | Filters the room out of `rooms`.                                                         | Logs and shows generic error toast.                                    |
| `sendPlaybackCommand(uuid, action, videoPos?)` | `roomsApi.sendPlaybackCommand()` | Optimistically patches `rooms[i].live.playerState`/`videoPos`; fires `refresh()` to reconcile. | Reverts the optimistic snapshot. On 409 surfaces "no clients are connected"; otherwise shows the server's error text or a generic toast. |
| `dismissLastCreated()`       | none                               | Clears `lastCreated` back to `null`.                                                     | —                                                                      |

The `lastCreated` field is the mechanism by which the create flow shows the password to the user exactly once: when create succeeds, the store sets `lastCreated`, the `RoomsPanel` watches that field, the password dialog opens with the value, and the user dismisses it via `dismissLastCreated()` which clears the field back to `null`. After that, the plaintext password is unrecoverable — there is no "show me again" path.

The actions follow a small, consistent pattern. They wrap the async work in try/catch, surface failures via `@nextcloud/dialogs`'s `showError` toast, log the underlying error through `@nextcloud/logger`, and (where applicable) update the local `rooms` array optimistically — for example, `remove` filters the deleted room out of the array immediately so the UI feels instant, and `create` prepends the new room. There is no rollback logic if the optimistic update turns out to be wrong, which is a deliberate simplification: the friend-group threat model doesn't justify the complexity, and a refresh would correct any inconsistency anyway.

The `extractErrorMessage` helper at the bottom of the file is a small but important detail. When the backend returns a 400 with `{ "error": "bootstrapUrl must be a valid http(s) URL." }`, this helper picks that string out of the axios error structure so the toast can show it instead of a generic "Could not create room." fallback. Validation errors are usually the most useful kind to surface verbatim because the user needs to know exactly what is wrong with their input.

## The API service

[`src/services/roomsApi.ts`](../src/services/roomsApi.ts) is just three exported functions and a private URL helper, but it earns its own file because it is the single place the frontend speaks HTTP. Every component goes through the store; the store goes through this service; the service is the only thing that actually imports `axios` and `generateUrl`. If we ever want to add a request interceptor — say, to inject a request ID, log timings, or retry on flaky networks — this is the only file that needs to change.

| Function               | Verb     | Path                              | Argument type           | Returns                  |
|------------------------|----------|-----------------------------------|-------------------------|--------------------------|
| `listRooms()`          | `GET`    | `/api/v1/rooms`                   | —                       | `Promise<Room[]>`        |
| `createRoom(payload)`  | `POST`   | `/api/v1/rooms`                   | `CreateRoomPayload`     | `Promise<CreatedRoom>`   |
| `deleteRoom(uuid)`     | `DELETE` | `/api/v1/rooms/{uuid}`            | `string`                | `Promise<void>`          |
| `sendPlaybackCommand(uuid, action, videoPos?)` | `POST` | `/api/v1/rooms/{uuid}/playback` | `string`, `PlaybackAction`, `number?` | `Promise<void>` |

The types are defined in [`src/types/room.ts`](../src/types/room.ts) and match the shape the backend's `serializeRoom` produces. Keeping the API service strongly typed means TypeScript catches it immediately if the backend or the frontend drift apart on the field set.

## The dialogs

[`src/components/RoomCreateDialog.vue`](../src/components/RoomCreateDialog.vue) is the form for creating a room. It uses `NcDialog` for the chrome, `NcTextField` for the name and bootstrap-URL inputs, and a plain native `<select>` for the TTL because none of `@nextcloud/vue`'s dropdown components map cleanly to "pick one of four predefined seconds-counts" without overcomplicating things. The validation logic is intentionally lightweight on the client — it checks that the bootstrap URL looks roughly like an http(s) URL — because the backend service is the authoritative validator. We don't want two different sources of truth telling the user different things about what's valid. The new toggle (`singleMode` / `freeformMode`) and `initialEntries` fields the create endpoint accepts are not yet surfaced in this dialog — the per-mode UX specs add those controls later.

The dialog binds its open state via `v-model:open` to its parent `RoomsPanel`, and it suppresses close attempts while a create request is in flight by intercepting the `update:open` event. That's a small UX detail that prevents a user from clicking "Cancel" mid-submission and ending up with a half-confused state where the server creates the room but the dialog is already gone.

[`src/components/RoomCreatedDialog.vue`](../src/components/RoomCreatedDialog.vue) is the one-time password presentation. It opens whenever `store.lastCreated` is non-null and shows the password and share link side by side, each with its own copy button. The copy buttons use the standard `navigator.clipboard.writeText()` API and briefly swap their icon to a checkmark on success, so the user gets visual feedback without needing a toast. There is also an `NcNoteCard` warning that the password will not be shown again, which is the only piece of UX that hammers home the "this is your one chance" semantics — be very careful about removing or weakening that warning, because the password genuinely is unrecoverable once dismissed.

[`src/components/RoomDetailDialog.vue`](../src/components/RoomDetailDialog.vue) is the room detail and live-control modal. It opens from the room card and re-fetches via `roomsApi.getRoom(uuid)` so the live block (presence, playback state) and the persisted cursor reflect current state rather than whatever was cached in the rooms list. Layout is split into discrete sections: status strip, bootstrap URL, share link, timestamps, **Playback**, **Connected viewers**, **Now watching** (the playlist entry referenced by `room.cursorEntryId`), and identifier. The playlist picker / reorder / promote-to-curated controls are not in this dialog yet — they land with the per-mode UX specs.

The Playback section is where the owner drives the room. The header shows a coloured pill — green/playing, orange/buffering with a spinning loader, neutral/paused — alongside the current `videoPos` formatted as `m:ss` or `h:mm:ss`. Below the header sit Play / Pause and Reset-to-start buttons (Play and Pause are the same button; its label flips on `isCurrentlyPlaying`, which treats `buffering` as "playing" so the affordance is "interrupt" rather than "resume"). Each button shows an inline `NcLoadingIcon` while its specific command is in flight, and every control disables while any command is busy so a fast user can't queue conflicting requests.

The seek field accepts `mm:ss`, `h:mm:ss`, or a bare integer (parsed as seconds). The `parseSeekInput` helper right-aligns the parts so a 2-part input is minutes/seconds and a 1-part input is seconds, matching how a clock is read; minutes and seconds must be under 60, hours are unbounded. The placeholder shows the current playback position, and the helper text turns into "Jump to 2:47." once the input parses cleanly so the user gets a sanity check before pressing Go. Invalid input flips the field into error state but does not raise — the Go button just stays disabled.

Every command flows through `roomsStore.sendPlaybackCommand`, which patches the room's `live` block optimistically (Play sets `playerState = 'playing'`, Reset sets `paused` and `videoPos = 0`, and so on), then fires the API call. On success the store kicks off a background `refresh()` so the daemon's authoritative state replaces the optimistic patch; on failure the pre-call snapshot is restored. The 409 `room_not_live` case is treated as a distinct error — the toast says "no clients are connected" — because the daemon's runtime only exists once at least one client has joined, and the dashboard should explain that rather than fall through to a generic "could not send playback command" message.

The Connected viewers section is a proper list: each row has a stable hue-derived colour dot, the truncated client id in monospace, a "Buffering" pill with a spinning loader for any client whose `isBuffering` is true, and a tertiary `NcButton` with an `IconClose` for owner-initiated disconnect. Clicking disconnect opens the existing confirmation dialog and, on confirm, routes through `store.kickClient`. The Now watching section is a single clickable card that links to the cursor entry's `pageUrl`, with the entry's `label` (or `providerId · videoId` when no label is set) as the title and the URL as the subtitle, both single-line ellipsised so the modal stays compact even for verbose pages.

## RoomList

[`src/components/RoomList.vue`](../src/components/RoomList.vue) is fully presentational. It takes a `rooms` prop and emits a `delete` event when the user clicks the delete action on a row. It renders each room as an `NcListItem` with a play-icon, the room's name (or its UUID if there's no name), and a localized "Expires {date}" subname. The component knows nothing about the store, the API, or the network; you could give it a hand-crafted array of `Room` objects and it would render them just fine. That makes it easy to test or to reuse if we ever need a non-store-backed listing surface.

## Internationalization

Every user-facing string in the app goes through `translate()` from `@nextcloud/l10n`, imported as `t` in every component that needs it. The first argument is the app slug `'playbacksync'` (which is what tells Nextcloud which translations bundle to look in), and the second is the source-language English string. Nextcloud's translation tooling looks for these calls at build time and harvests the strings into the `l10n/*.js` files, where translators can replace them with localized versions.

| Helper           | Import from         | Signature                                                  | Use for                                                            |
|------------------|---------------------|------------------------------------------------------------|--------------------------------------------------------------------|
| `translate`      | `@nextcloud/l10n`   | `(app, source, params?) => string`                         | All static UI strings. Aliased as `t` everywhere.                  |
| `translatePlural`| `@nextcloud/l10n`   | `(app, singular, plural, n, params?) => string`            | Plural-aware strings. Not used yet, but worth knowing about.       |
| `getLoggerBuilder` | `@nextcloud/logger` | `() => LoggerBuilder`                                    | Structured client-side logging. Replaces `console.log`/`console.error`. |

| Locale file                          | Language          | Add new keys here?         |
|--------------------------------------|-------------------|----------------------------|
| [`l10n/en.js`](../l10n/en.js)        | English (source)  | **Yes** — always.          |
| [`l10n/nl.js`](../l10n/nl.js)        | Dutch             | Yes if you can translate; mirror the English key otherwise. |

The shape of these files is dictated by Nextcloud (`OC.L10N.register('playbacksync', { ... }, 'nplurals=2; plural=(n != 1);')`), so don't try to be clever with bundlers or generators — keep the files plain JavaScript the way Nextcloud expects them.

## Why no router

A vue-router was considered during planning and was rejected because the entire app fits on one page. Routing introduces history-stack semantics, navigation guards, and a chunk of bundle size that pays for itself only when you actually have multiple distinct views. Until we do, the simplest possible answer — one `App.vue`, one `RoomsPanel`, two dialogs — is the right one. If a second view ever becomes necessary, it will be cheap to add then; pre-installing the abstraction now would be a classic case of designing for hypothetical future requirements that may never arrive.
