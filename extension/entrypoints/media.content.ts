/**
 * Media content-script entrypoint. Runs inside the embed player frame (e.g.
 * the cross-origin `strm.cx` iframe) with `allFrames: true`, and bootstraps the
 * media runtime — the half of a site adapter that owns the `<video>`. It
 * forwards every outbound call to the background via
 * `browser.runtime.sendMessage`; inbound `command` messages are routed straight
 * into the runtime, which applies play/pause/seek/nudge to the element.
 *
 * The `matches` allowlist is sourced from `src/adapters/embed-matches.ts`
 * (embed hosts only) so the manifest's `host_permissions` and the media
 * content-script matches cannot drift apart. It deliberately does **not** share
 * `ADAPTER_MATCHES` with the page runtime: the page half stays top-frame /
 * page-host only, while this half rides `allFrames` scoped to embed hosts.
 *
 * This file knows nothing about identity, catalog, navigation, or the WS
 * protocol — the media runtime owns adapter lifecycle, the background owns the
 * WebSocket, and the page frame owns everything URL-derived.
 */

import { deliverCommand, setRoomActive, start, type MediaBridge } from '@/src/adapters/media/runtime'
import { EMBED_MATCHES } from '@/src/adapters/embed-matches'
import type { BackgroundToContent, ContentToBackground } from '@/src/messages'

export default defineContentScript({
	matches: [...EMBED_MATCHES],
	allFrames: true,
	runAt: 'document_idle',
	main() {
		// Latched once the extension worker has been torn down (dev reload / any
		// extension reload). Content scripts outlive their host extension, so the
		// runtime keeps polling `adapter.getState()` at 1 Hz and each send throws
		// synchronously — without the latch the frame console floods with
		// "Extension context invalidated". Mirrors `entrypoints/content.ts`.
		let contextInvalidated = false
		const send = (msg: ContentToBackground) => {
			if (contextInvalidated) return
			if (!browser.runtime?.id) {
				contextInvalidated = true
				return
			}
			try {
				void browser.runtime.sendMessage(msg).catch(() => {
					// Background worker may be sleeping (MV3); a dropped message is
					// fine until the next event re-wakes it.
				})
			} catch {
				// `sendMessage` throws synchronously (not as a rejected promise)
				// when the context is invalidated mid-flight. Latch and swallow.
				contextInvalidated = true
			}
		}

		const bridge: MediaBridge = {
			sendIntent(adapterId, intent) {
				send({ kind: 'intent', adapterId, intent })
			},
			sendStatus(adapterId, state) {
				send({ kind: 'status', adapterId, state })
			},
			sendMediaHello(adapterId) {
				send({ kind: 'media_hello', mediaAdapterId: adapterId })
			},
			sendFail(adapterId, reason) {
				send({ kind: 'fail', role: 'media', adapterId, reason })
			},
		}

		browser.runtime.onMessage.addListener((msg: unknown) => {
			const m = msg as BackgroundToContent
			// Only `command` and `room_active` are actionable in the media frame;
			// `notice` renders in the page frame's on-page UI, so it's ignored here.
			if (m.kind === 'command') deliverCommand(m.command)
			else if (m.kind === 'room_active') setRoomActive(m.active)
			// Fire-and-forget: return undefined so the browser doesn't hold the
			// message channel open waiting for a sendResponse we never call.
		})

		start(bridge)
		// Adapter activation is gated on room membership; announce readiness so the
		// background lazily connects a stored-creds tab and replies `room_active`.
		send({ kind: 'content_ready' })
	},
})
