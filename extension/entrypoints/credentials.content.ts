/**
 * One-shot content script for the share-URL → background credential
 * handoff. Runs at `document_start` on every adapter host so we sniff
 * the URL before any client-side router has had a chance to munge the
 * query string; activates only when the URL carries *both* `sync_url`
 * and `sync_password` (the exact params
 * `ShareController::buildRedirectUrl` appends to `room.bootstrapUrl`).
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
 * The URL is intentionally **not** stripped after handoff: the password
 * is already in the address bar at the moment the browser performs the
 * server-side 302, so an `history.replaceState` here is closing the
 * barn door after the horse has bolted. Hardening that path (fragment
 * handoff, server-set cookie, etc.) is a server-side concern and out of
 * scope for this slice.
 */

import { ADAPTER_MATCHES } from '@/src/adapters/host-matches'
import type { ContentToBackground } from '@/src/messages'

export default defineContentScript({
	matches: [...ADAPTER_MATCHES],
	runAt: 'document_start',
	main() {
		const params = new URLSearchParams(window.location.search)
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
