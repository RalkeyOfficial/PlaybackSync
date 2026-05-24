import { deliverCommand, start, type RuntimeBridge } from '@/src/adapters/runtime'
import type { BackgroundToContent, ContentToBackground } from '@/src/messages'

export default defineContentScript({
	matches: ['<all_urls>'],
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
