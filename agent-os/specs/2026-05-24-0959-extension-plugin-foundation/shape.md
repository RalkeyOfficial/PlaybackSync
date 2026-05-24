# Extension Plugin Foundation — Shaping Notes

## Scope

Define the adapter (plugin) interface for the PlaybackSync browser extension and build the content-side runtime that selects and loads adapters. Ship one `_template` adapter that demonstrates the contract end-to-end on a smoke-test page; defer the WebSocket client, real site adapters, credential pickup, and popup UI to follow-up specs.

## Decisions

- **Workshop v1 design = starting reference, revisable.** The contract shapes (intent vs commands, exactly-one-adapter-per-tab, statically bundled, `_template` baseline, "explicit failure over silent desync") are adopted from [OLD_CODE/extension/docs/playback_sync_extension_architecture_adapter_based_design_workshop_v_1.md](../../../OLD_CODE/extension/docs/playback_sync_extension_architecture_adapter_based_design_workshop_v_1.md). Specifics may flex — most notably the workshop's **"fatal on identity change"** rule, which is relaxed here to "tear-down + re-evaluate on URL change" because the v2 protocol's `CURSOR_CHANGE` makes server-driven navigation a normal flow.
- **Identity field rename.** Workshop calls it `episodeId`; this spec uses `videoId` to match the v2 wire format at `docs/ws-protocol.md` (JOIN.currentlyShowing).
- **`_template` activates on `?pbsync-template` query param.** Keeps the adapter inert on real sites while giving devs a single page-agnostic smoke-test path. Doubles as the file new-site adapter PRs copy from.
- **Content-script `matches: <all_urls>`** for the plugin model — every page must give the runtime a chance to evaluate the registry. This will show a more visible install prompt and is **flagged for re-evaluation pre-store-submission** (where an explicit allowlist may be preferred). Documented here so the trade-off isn't re-litigated mid-build.
- **No automated tests in this slice.** Surface area is small (one runtime, one template adapter, a message envelope). Verification is the manual repro path in `plan.md` §Verification. A test rig comes when the WS client lands.

## Context

- **Visuals:** None provided.
- **References:** Workshop v1 design doc; OLD_CODE adapter-runtime + content/background skeletons; `docs/ws-protocol.md` for v2 wire-format naming.
- **Product alignment:** This is the foundation slice under [agent-os/product/roadmap.md](../../product/roadmap.md) Phase 2 ("Browser extension — in progress"). The roadmap's work items (JOIN handshake, content-script adapter, `currentlyShowing` reporting, popup, packaging) all sit on top of the contract this spec defines.
- **Credential flow exists already.** `ShareController::buildRedirectUrl` at [lib/Controller/ShareController.php:121](../../../lib/Controller/ShareController.php#L121) emits `?sync_url=&sync_password=` on the share-link redirect. This slice does not consume them yet — that's a follow-up spec.

## Standards Applied

None of the existing standards under `agent-os/standards/` apply directly. They cover PHP (Nextcloud conventions), Vue (Nextcloud Vue components / l10n / Pinia), and Vite build setup. The extension is a separate **WXT / TypeScript** project with its own ESLint config at `extension/eslint.config.mjs`. See `standards.md` for the explicit note so the next extension spec doesn't re-search.
