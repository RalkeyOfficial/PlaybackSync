/**
 * Single source of truth for the **embed hosts** the media adapters recognise
 * — third-party player frames that a page site loads in a (usually
 * cross-origin) iframe. Consumed by:
 *
 * - `wxt.config.ts` — spread into the manifest's `host_permissions` so the
 *   extension is allowed to inject the media content script into these frames.
 * - `entrypoints/media.content.ts` — limits where the media runtime is
 *   injected (with `allFrames: true`, so it reaches the embed sub-frame).
 *
 * Kept separate from `host-matches.ts` (the page-site hosts) so the two
 * scopes don't blur: the page runtime + credential sniffer must stay
 * top-frame-and-page-host only, while the media runtime rides `allFrames`
 * scoped to embed hosts. Adding a new embedded player means appending its host
 * here as well as registering its factory in `src/adapters/media/registry.ts`.
 *
 * Reviewers (notably AMO) reject `<all_urls>` without an exceptionally strong
 * justification. An enumerated allowlist is the path of least resistance and
 * the smallest possible attack surface.
 */
export const EMBED_MATCHES = [
	'*://strm.cx/*',
	'*://*.strm.cx/*',
] as const
