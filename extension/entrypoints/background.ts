import type { ContentToBackground } from '@/src/messages'

export default defineBackground(() => {
	console.log('[playbacksync] background worker booted')

	chrome.runtime.onMessage.addListener((msg: ContentToBackground, sender) => {
		// Placeholder until the WS client lands: every inbound message is just
		// logged. Real protocol routing (JOIN, EVENT, HEARTBEAT, …) plugs in
		// here.
		console.log('[playbacksync:bg]', sender.tab?.id, msg)
	})
})
