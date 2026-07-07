/**
 * One-shot content script for the share-URL → background credential
 * handoff. Runs at `document_start` on every adapter host so we read the
 * URL fragment before the site's own JS can touch it; activates only when
 * the fragment carries *both* `sync_url` and `sync_password` (the exact
 * params `ShareController::buildRedirectUrl` encodes into the fragment).
 *
 * The credentials ride the URL **fragment**, not the query string. A
 * fragment is never sent to the streaming site's server, so a server-side
 * canonicalising redirect (e.g. miruro rewriting a slug-less `/watch/<id>`
 * to its slugged form, dropping unknown query params) cannot strip them —
 * browsers re-attach the fragment across such a redirect (RFC 7231
 * §7.1.2). It also means the room password never reaches the streaming
 * site's servers at all.
 *
 * The `matches` allowlist is sourced from
 * `src/adapters/host-matches.ts` so the sniffer is scoped to the same
 * set of hosts the adapter runtime supports — the redirect target is
 * always one of those hosts, so widening it would only add review
 * friction without enabling any real flow.
 *
 * Behaviour:
 *
 * - Both params present → post a single `credentials` message to the
 *   background and exit. The background is first-write-wins: it ignores
 *   the message if `pbsync` storage is already populated. That means a
 *   share-link re-visit while a room is already joined is a no-op, not
 *   a room-switch.
 * - Either param missing → return silently. No console noise, no
 *   message sent. Normal browsing produces zero traffic from this
 *   script.
 *
 * The fragment is intentionally **not** stripped after handoff: it stays
 * a purely local artifact (never transmitted), and a `history.replaceState`
 * here would fire the adapter runtime's `pbsync:locationchange` guard for
 * no real gain.
 */

import { ADAPTER_MATCHES } from '@/src/adapters/host-matches'
import type { ContentToBackground } from '@/src/messages'

export default defineContentScript({
	matches: [...ADAPTER_MATCHES],
	runAt: 'document_start',
	main() {
		const params = new URLSearchParams(window.location.hash.replace(/^#/, ''))
		const syncUrl = params.get('sync_url')
		const syncPassword = params.get('sync_password')
		if (!syncUrl || !syncPassword) return

		const msg: ContentToBackground = { kind: 'credentials', syncUrl, syncPassword }
		// `chrome.runtime.id` is undefined once the worker has been torn
		// down (dev reload, manual extension reload); `sendMessage` would
		// then throw synchronously as "Extension context invalidated"
		// instead of returning a rejected promise. Pre-check to avoid the
		// throw and the `Uncaught` it would surface on the extension page.
		if (!chrome.runtime?.id) return
		try {
			void chrome.runtime.sendMessage(msg).catch(() => {
				// Background worker may be waking (MV3); the share link is
				// also typically opened in a fresh tab where the worker
				// boots in response to this very message, so transient send
				// errors are expected and recoverable on the next event.
			})
		} catch {
			// Context invalidated between the check and the call — page is
			// orphaned; nothing actionable here.
		}
	},
})
