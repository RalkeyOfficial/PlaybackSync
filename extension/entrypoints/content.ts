/**
 * Content-script entrypoint. Runs on every adapter host (workshop §2
 * rule 3: unsupported pages stay silent) and bootstraps the adapter
 * runtime with a {@link RuntimeBridge} that forwards every outbound
 * call to the background via `chrome.runtime.sendMessage`. Inbound
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
		const send = (msg: ContentToBackground) => {
			void chrome.runtime.sendMessage(msg).catch(() => {
				// Background worker may be sleeping (MV3); message dropped is fine
				// until the next event re-wakes it.
			})
		}

		const bridge: RuntimeBridge = {
			sendIntent(adapterId, intent) {
				send({ kind: 'intent', adapterId, intent })
			},
			sendIdentity(adapterId, identity) {
				send({ kind: 'identity', adapterId, identity })
			},
			sendStatus(adapterId, state) {
				send({ kind: 'status', adapterId, state })
			},
			sendFail(adapterId, reason) {
				send({ kind: 'fail', adapterId, reason })
			},
		}

		chrome.runtime.onMessage.addListener((msg: BackgroundToContent) => {
			if (msg.kind === 'command') deliverCommand(msg.command)
		})

		void start(bridge)
	},
})
