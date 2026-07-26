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

import { deliverCommand, reevaluate, setRoomActive, start, type RuntimeBridge } from '@/src/adapters/runtime'
import { ADAPTER_MATCHES } from '@/src/adapters/host-matches'
import { initNotifications, showNotice } from '@/src/ui/notifications'
import type { BackgroundToContent, ContentToBackground } from '@/src/messages'

export default defineContentScript({
	matches: [...ADAPTER_MATCHES],
	runAt: 'document_idle',
	main(ctx) {
		// Register the on-page notification UI. Lazy: the shadow root only
		// mounts once the first notice arrives, so pages that never sync pay
		// nothing.
		initNotifications(ctx)
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
			sendIdentity(adapterId, identity, guardNavigation) {
				// `pageUrl` is captured here (not by the adapter) so the
				// adapter contract stays focused on identity comparison.
				// The background needs the full URL to build the wire-format
				// `JOIN.currentlyShowing` field; see messages.ts.
				send({ kind: 'identity', adapterId, identity, pageUrl: location.href, guardNavigation })
			},
			sendFail(adapterId, reason) {
				send({ kind: 'fail', role: 'page', adapterId, reason })
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
			else if (m.kind === 'notice') showNotice(m.notice)
			else if (m.kind === 'room_active') setRoomActive(m.active)
			else if (m.kind === 'reevaluate') reevaluate()
			// Fire-and-forget: return undefined so the browser doesn't hold the
			// message channel open waiting for a sendResponse we never call.
		})

		start(bridge)
		// Adapter activation is gated on room membership; announce readiness so the
		// background lazily connects a stored-creds tab and replies `room_active`.
		send({ kind: 'content_ready' })
	},
})
