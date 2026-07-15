/**
 * Content-script entrypoint. Runs on every adapter host (workshop §2
 * rule 3: unsupported pages stay silent) and bootstraps the adapter
 * runtime with a {@link RuntimeBridge} that forwards every outbound
 * call to the background via `browser.runtime.sendMessage`. Inbound
 * `command` messages from the background are routed straight into the
 * runtime, which dispatches them to the active adapter.
 *
 * The `matches` allowlist is sourced from `wxt.config.ts#ADAPTER_MATCHES`
 * so the manifest's `host_permissions` and the content-script matches
 * cannot drift apart.
 *
 * This file deliberately knows nothing about the protocol — the
 * runtime owns adapter lifecycle, the background owns the WebSocket.
 */

import { deliverCommand, start, type RuntimeBridge } from '@/src/adapters/runtime'
import { ADAPTER_MATCHES } from '@/src/adapters/host-matches'
import type { BackgroundToContent, ContentToBackground } from '@/src/messages'

export default defineContentScript({
	matches: [...ADAPTER_MATCHES],
	runAt: 'document_idle',
	main() {
		// Latched once the extension worker has been torn down (typical in
		// dev: `wxt dev` reload, or any extension reload). Content scripts
		// outlive their host extension, so the runtime keeps polling
		// `adapter.getState()` at 1 Hz and each send throws synchronously —
		// without the latch the page console floods with `Uncaught Error:
		// Extension context invalidated` and Chrome surfaces that on the
		// extension-management page.
		let contextInvalidated = false
		const send = (msg: ContentToBackground) => {
			if (contextInvalidated) return
			// `browser.runtime.id` is the canonical "is this script still
			// attached to a live extension" probe — it goes `undefined` the
			// moment the worker is gone, before any `sendMessage` call has
			// a chance to throw.
			if (!browser.runtime?.id) {
				contextInvalidated = true
				return
			}
			try {
				void browser.runtime.sendMessage(msg).catch(() => {
					// Background worker may be sleeping (MV3); message dropped
					// is fine until the next event re-wakes it.
				})
			} catch {
				// `sendMessage` throws synchronously (not as a rejected
				// promise) when the context is invalidated mid-flight, so
				// the `.catch()` above doesn't see it. Latch and swallow.
				contextInvalidated = true
			}
		}

		const bridge: RuntimeBridge = {
			sendIntent(adapterId, intent) {
				send({ kind: 'intent', adapterId, intent })
			},
			sendIdentity(adapterId, identity, guardNavigation) {
				// `pageUrl` is captured here (not by the adapter) so the
				// adapter contract stays focused on identity comparison.
				// The background needs the full URL to build the wire-format
				// `JOIN.currentlyShowing` field; see messages.ts.
				send({ kind: 'identity', adapterId, identity, pageUrl: location.href, guardNavigation })
			},
			sendStatus(adapterId, state) {
				send({ kind: 'status', adapterId, state })
			},
			sendFail(adapterId, reason) {
				send({ kind: 'fail', adapterId, reason })
			},
			sendCatalog(adapterId, catalog) {
				send({ kind: 'catalog', adapterId, catalog })
			},
			sendCursorTrigger(adapterId, target) {
				send({ kind: 'cursor_trigger', adapterId, target })
			},
		}

		browser.runtime.onMessage.addListener((msg: unknown) => {
			const m = msg as BackgroundToContent
			if (m.kind === 'command') deliverCommand(m.command)
		})

		void start(bridge)
	},
})
