/**
 * Background service worker entrypoint. Boots the WS client when
 * credentials are present in `chrome.storage.local`, routes messages
 * from content scripts (intent / status / identity / fail), and
 * dispatches authoritative commands back to the right tab.
 *
 * Everything WS-related lives in `src/background/`; this file is the
 * thin glue that owns `chrome.*` APIs and forwards.
 */

import type { AuthoritativeCommand } from '@/src/adapters/types'
import type { BackgroundToContent, ContentToBackground } from '@/src/messages'
import { createSession, recordCommand, shouldSuppress } from '@/src/background/session'
import { loadCreds } from '@/src/background/storage'
import { forgetTab, getTab, recordIdentity, recordStatus } from '@/src/background/tabs'
import { connect, sendBuffer, sendEvent } from '@/src/background/ws'

const session = createSession()
/** Tracks the latest `playerState` per tab so we can detect buffer transitions. */
const lastPlayerStateByTab = new Map<number, 'playing' | 'paused' | 'buffering'>()

export default defineBackground(() => {
	console.log('[playbacksync:bg] worker booted')

	void bootstrap()

	chrome.runtime.onMessage.addListener(
		(msg: ContentToBackground, sender: chrome.runtime.MessageSender) => {
			const tabId = sender.tab?.id
			if (tabId === undefined) return
			routeMessage(tabId, msg)
		},
	)

	chrome.tabs.onRemoved.addListener((tabId: number) => {
		forgetTab(tabId)
		lastPlayerStateByTab.delete(tabId)
	})
})

async function bootstrap(): Promise<void> {
	const creds = await loadCreds()
	if (!creds) {
		console.log(
			'[playbacksync:bg] no creds in chrome.storage.local.pbsync; '
			+ 'set { syncUrl, syncPassword } and reload the extension to connect',
		)
		return
	}
	connect(creds, session, {
		dispatchCommand: (tabId, cmd) => dispatchCommand(tabId, cmd),
		onTerminal: (reason, code) => {
			console.error('[playbacksync:bg] terminal close', { reason, code })
		},
	})
}

function routeMessage(tabId: number, msg: ContentToBackground): void {
	switch (msg.kind) {
		case 'intent': {
			if (shouldSuppress(session, tabId, msg.intent)) {
				console.log('[playbacksync:bg] suppressed echo intent', {
					tabId, type: msg.intent.type,
				})
				return
			}
			sendEvent(msg.intent)
			return
		}
		case 'status': {
			recordStatus(tabId, msg.adapterId, msg.state)
			const prev = lastPlayerStateByTab.get(tabId)
			if (prev !== msg.state.playerState) {
				if (msg.state.playerState === 'buffering') {
					sendBuffer('BUFFER_START', msg.state.currentPos)
				} else if (prev === 'buffering') {
					sendBuffer('BUFFER_END', msg.state.currentPos)
				}
				lastPlayerStateByTab.set(tabId, msg.state.playerState)
			}
			return
		}
		case 'identity':
			recordIdentity(tabId, msg.adapterId, msg.identity)
			return
		case 'fail':
			console.warn('[playbacksync:bg] adapter failed', {
				tabId, adapterId: msg.adapterId, reason: msg.reason,
			})
			forgetTab(tabId)
			lastPlayerStateByTab.delete(tabId)
			return
	}
}

function dispatchCommand(tabId: number, cmd: AuthoritativeCommand): void {
	// Arm the suppression window *before* the command lands, so the
	// reflected native event from the adapter is dropped.
	recordCommand(session, tabId, cmd)
	const entry = getTab(tabId)
	if (!entry) {
		console.warn('[playbacksync:bg] dispatch to unknown tab', { tabId })
		return
	}
	const payload: BackgroundToContent = { kind: 'command', command: cmd }
	void chrome.tabs.sendMessage(tabId, payload).catch(() => {
		// Tab closed or content script not present; nothing actionable.
	})
}
