# First Real Site Adapter (miruro) — Shaping Notes

## Scope

The extension's plugin foundation, runtime, and v2 WS client have all landed but the only registered adapter is `_template`, gated behind a `?pbsync-template` query param so it's inert on real pages. This slice writes the first real site adapter — for miruro — so an actual sync session can be driven from a real streaming page. Everything else in `EXTENSION_TODO.md` §"Next up" depends on this being able to attach to a real `<video>`.

Concretely, the adapter:

- matches miruro hosts and `/watch/<showId>/<slug>?ep=<ep>` URLs,
- finds the right `<video>` (pages can have multiple),
- presses miruro's manual-load button on cold pages so the `<video>` actually gets a source,
- forwards `play`/`pause`/`seeking` as `LocalIntent`s and applies authoritative commands verbatim,
- reports `{ providerId, videoId, normalizedUrl }` derived from the URL.

## Decisions

- **Enumerated TLDs, not a wildcard.** `(www\.)?miruro\.(tv|to|bz|ru)` — chosen over a `miruro\.[a-z]+` wildcard because miruro is known for rotating TLDs and a hostile actor could register `miruro.evil-tld` if we matched anything. Maintenance cost is one code edit + release per rotation; acceptable for now. Future slice can move the list to app config.
- **Path requires both `showId` and `ep`.** Watch pages without `?ep=` aren't valid sync targets — the episode is part of the identity. Missing either is a hard `ctx.fail` rather than an attempt to recover.
- **Scoped video selector.** `#player-container .player video` instead of `document.querySelector('video')` — the user confirmed multi-`<video>` pages exist (hero/trailer + player). The scoped selector picks the right element without resorting to brittle `:nth-child` paths.
- **MutationObserver-with-timeout for video discovery.** Vidstack hydrates after `document_idle`, so a synchronous lookup at `init` would miss it. 10 s timeout, then `ctx.fail` — strict, per the workshop's "no silent fallback" rule.
- **Eager-but-conditional manual-load.** At `init`, check `video.currentSrc`. If empty, dispatch the synthesized space-key on `#player-container .vds-video-layout button` (the user supplied the exact KeyboardEvent shape that works). After `loadedmetadata`, immediately `video.pause()` so the room's authoritative state takes over. The alternative — lazy-on-first-play — was rejected because it would add latency to every first `play` command and the user's explicit guidance was "at page load, double check that it's actually needed, afterwards the current state of the room should be applied (which for play state defaults to paused)".
- **`videoId = '<showId>-ep<ep>'`, `normalizedUrl = '/watch/<showId>?ep=<ep>'`.** Hostname stripped per workshop §7 ("`miruro.tv` and `miruro.to` are the same logical content"). Slug dropped because it's derived from `showId` and may differ per host / locale; `showId` + `ep` are stable.
- **SPA navigation handled by the runtime, not the adapter.** [`runtime.ts:184-207`](../../../extension/src/adapters/runtime.ts#L184-L207) already monkey-patches `history.pushState` / `replaceState` and tears down + re-evaluates on URL change. Episode-switching via `?ep=` is just another URL change; no adapter-side plumbing needed.
- **No tests.** Matches existing extension posture (the WS-client and share-URL-creds slices both deferred Vitest setup). Verification is `npm run compile` + `npm run lint` + a manual smoke against the live miruro site.

## Context

- **Visuals:** None.
- **References:**
  - [`extension/src/adapters/_template/index.ts`](../../../extension/src/adapters/_template/index.ts) — baseline adapter shape; the miruro adapter forks from this.
  - [`extension/src/adapters/types.ts`](../../../extension/src/adapters/types.ts) — `Adapter` contract, `AdapterContext`, `LocalIntent` / `AuthoritativeCommand` / `ContentIdentity` / `VideoState`.
  - [`extension/src/adapters/runtime.ts`](../../../extension/src/adapters/runtime.ts) — registry, status polling, SPA-navigation tear-down.
  - [`extension/docs/adapter-contract.md`](../../../extension/docs/adapter-contract.md) — "Writing a new adapter, step by step".
  - [`agent-os/specs/2026-05-24-0959-extension-plugin-foundation/`](../2026-05-24-0959-extension-plugin-foundation/) — established the contract; this slice is the first concrete consumer.
  - [`OLD_CODE/extension/src/content/index.ts`](../../../OLD_CODE/extension/src/content/index.ts) — legacy miruro presence was just a hostname check; no real DOM logic to port.
- **Product alignment:** [`agent-os/product/roadmap.md`](../../product/roadmap.md) §"Phase 2: Browser extension" calls out adapters for "miruro, crunchyroll, youtube, …" with miruro as the first concrete target.

## Standards applied

The indexed standards (`backend/php-conventions`, `frontend/vue-conventions`, `tooling/build`) are PHP- and Vue-side — none touch the extension's TypeScript stack. Project-level rules from [`CLAUDE.md`](../../../CLAUDE.md) and the documentation policy from the WS-client spec do apply; see `standards.md`.
