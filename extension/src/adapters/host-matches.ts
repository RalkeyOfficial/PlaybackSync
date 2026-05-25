/**
 * Single source of truth for the hosts the bundled site adapters
 * recognise. Consumed by:
 *
 * - `wxt.config.ts` — populates the manifest's `host_permissions`.
 * - `entrypoints/content.ts` — limits where the adapter runtime is
 *   injected.
 * - `entrypoints/credentials.content.ts` — limits where the share-URL
 *   sniffer is injected. The redirect target is always one of the
 *   adapter hosts (the per-room `bootstrapUrl`), so the sniffer never
 *   needs a wider scope than the adapters themselves.
 *
 * Adding a new adapter means appending its host patterns here as well
 * as registering its factory in `src/adapters/runtime.ts`. Keep both
 * sides aligned — a missing entry here will leave a new adapter
 * dead-on-arrival in production builds even when the registry knows
 * about it, because the content script will never inject on the page.
 *
 * Reviewers (notably AMO) reject `<all_urls>` without an exceptionally
 * strong justification. An enumerated allowlist is the path of least
 * resistance and the smallest possible attack surface.
 */
export const ADAPTER_MATCHES = [
	'*://miruro.tv/*',
	'*://www.miruro.tv/*',
	'*://miruro.to/*',
	'*://www.miruro.to/*',
	'*://miruro.bz/*',
	'*://www.miruro.bz/*',
	'*://miruro.ru/*',
	'*://www.miruro.ru/*',
] as const
