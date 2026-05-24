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
import { loadCreds, saveCreds } from '@/src/background/storage'
import { forgetTab, getTab, recordIdentity, recordStatus } from '@/src/background/tabs'
import { connect, sendBuffer, sendEvent, type WsCallbacks } from '@/src/background/ws'

const session = createSession()
/** Tracks the latest `playerState` per tab so we can detect buffer transitions. */
const lastPlayerStateByTab = new Map<number, 'playing' | 'paused' | 'buffering'>()

/**
 * Callbacks the WS client hands back to this entrypoint. Shared between
 * `bootstrap()` (boot-time connect when storage already had creds) and
 * the `credentials` message handler (runtime connect on share-URL
 * pickup) so the two paths can't drift.
 */
const wsCallbacks: WsCallbacks = {
	dispatchCommand: (tabId, cmd) => dispatchCommand(tabId, cmd),
	onTerminal: (reason, code) => {
		console.error('[playbacksync:bg] terminal close', { reason, code })
	},
}

export default defineBackground(() => {
	console.log('[playbacksync:bg] worker booted')

	void bootstrap()

	chrome.runtime.onMessage.addListener(
		(msg: ContentToBackground, sender: chrome.runtime.MessageSender) => {
			// Wrap async work in an IIFE so the listener returns `undefined`
			// synchronously. Returning a Promise / `true` would tell Chrome
			// to hold the message channel open for a `sendResponse` call we
			// never make.
			void (async () => {
				await routeMessage(sender.tab?.id, msg)
			})()
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
			+ 'follow a room share link or seed manually via DevTools to connect',
		)
		return
	}
	connect(creds, session, wsCallbacks)
}

async function routeMessage(tabId: number | undefined, msg: ContentToBackground): Promise<void> {
	// The `credentials` arm is browser-runtime-global and has no tabId
	// requirement, so it's handled before the tab-scoped guard below.
	if (msg.kind === 'credentials') {
		await handleCredentials(msg.syncUrl, msg.syncPassword)
		return
	}

	// Every other arm is tab-scoped and useless without a sender tab.
	if (tabId === undefined) return

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

/**
 * First-write-wins handler for the share-URL credential handoff. When
 * `pbsync` storage already has an entry, the new credentials are
 * ignored so a stale share-link revisit can't accidentally hop rooms.
 * Switching rooms is the future "leave room" flow's job (clear, then
 * pickup runs on the next link click).
 *
 * @param syncUrl WebSocket URL produced by `ShareController::buildWebSocketUrl`.
 * @param syncPassword Plaintext one-time password the visitor typed at the Basic Auth prompt.
 */
async function handleCredentials(syncUrl: string, syncPassword: string): Promise<void> {
	const existing = await loadCreds()
	if (existing) {
		console.log('[playbacksync:bg] share-URL creds ignored; pbsync already populated')
		return
	}
	await saveCreds({ syncUrl, syncPassword })
	console.log('[playbacksync:bg] share-URL creds accepted; connecting')
	connect({ syncUrl, syncPassword }, session, wsCallbacks)
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
