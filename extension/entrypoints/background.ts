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
import type {
	BackgroundToContent,
	ContentToBackground,
	PopupToBackground,
} from '@/src/messages'
import {
	createSession,
	hasConverged,
	inSettleWindow,
	markConverged,
	recordCommand,
	resetConvergence,
	shouldSuppress,
} from '@/src/background/session'
import { clearCreds, loadCreds, saveCreds } from '@/src/background/storage'
import { forgetTab, getTab, pickActiveTab, recordIdentity, recordStatus } from '@/src/background/tabs'
import { forgetIconForTab, initGreyscaleDefaults, setActiveTab } from '@/src/background/icon'
import {
	getDerivedStatus,
	initPopupBroadcast,
	registerPopupPort,
	setPopupCreds,
} from '@/src/background/popupBroadcast'
import { connect, disconnect, sendBuffer, sendEvent, type WsCallbacks } from '@/src/background/ws'

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
		// Terminal codes (ROOM_NOT_FOUND, ROOM_EXPIRED, ROOM_DELETED, KICKED,
		// AUTH_FAILED, CLIENT_ID_IN_USE) all mean the stored credentials are
		// dead — no reconnect can succeed, so wipe them now rather than
		// re-attempting on the next service-worker boot. Logged at `warn`
		// (not `error`) because these are expected protocol outcomes; in
		// MV3, any `console.error` from a service worker is surfaced on the
		// browser's extension-management page as a red error notification.
		console.warn('[playbacksync:bg] terminal close', { reason, code })
		void tearDownSession()
	},
	onLifecycleChange: () => recomputeActiveIcon(),
}

/**
 * Wipe persisted credentials, reset session-level identity, and clear the
 * popup mirror. Shared between the owner-driven `leave_room` flow and the
 * server-driven terminal-close flow so the two can't drift on what counts
 * as "this session is over".
 *
 * Does not call `disconnect()` — callers that need it (e.g. `leave_room`)
 * invoke `disconnect()` themselves first; terminal closes have already
 * torn the socket down by the time `onTerminal` fires.
 */
async function tearDownSession(): Promise<void> {
	await clearCreds()
	session.clientId = null
	session.lastEventId = 0
	session.cursor = null
	session.playlist = []
	session.playlistVersion = null
	resetConvergence(session)
	setPopupCreds(null)
}

/**
 * Reconcile the toolbar icon with current session + tab-cache state.
 * Greyscale-everywhere unless the WS room is `joined`, in which case
 * the freshest-reporting tab gets the color variant. Cheap to call —
 * idempotent and a no-op when the chosen tab hasn't changed.
 */
function recomputeActiveIcon(): void {
	if (getDerivedStatus() !== 'joined') {
		setActiveTab(null)
		return
	}
	const active = pickActiveTab()
	setActiveTab(active ? active[0] : null)
}

export default defineBackground(() => {
	console.log('[playbacksync:bg] worker booted')

	initPopupBroadcast(session)
	void initGreyscaleDefaults()
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

	chrome.runtime.onConnect.addListener((port: chrome.runtime.Port) => {
		if (port.name !== POPUP_PORT_NAME) return
		registerPopupPort(port)
		port.onMessage.addListener((msg: PopupToBackground) => {
			void handlePopupMessage(msg)
		})
	})

	chrome.tabs.onRemoved.addListener((tabId: number) => {
		forgetTab(tabId)
		lastPlayerStateByTab.delete(tabId)
		session.convergedTabs.delete(tabId)
		session.settleUntilByTab.delete(tabId)
		forgetIconForTab(tabId)
		recomputeActiveIcon()
	})
})

/**
 * Port name the toolbar popup uses for {@link chrome.runtime.connect}.
 * Must match the popup's call site verbatim.
 */
const POPUP_PORT_NAME = 'pbsync-popup'

async function bootstrap(): Promise<void> {
	const creds = await loadCreds()
	if (!creds) {
		console.log(
			'[playbacksync:bg] no creds in chrome.storage.local.pbsync; '
			+ 'follow a room share link or seed manually via DevTools to connect',
		)
		setPopupCreds(null)
		return
	}
	setPopupCreds({ syncUrl: creds.syncUrl })
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
			if (!hasConverged(session, tabId)) {
				// Native video events fired before the room's authoritative
				// state has been applied to this tab are not real user actions
				// — typically the site's own resume-position logic firing as
				// the adapter finishes init. Dropping them prevents the joiner
				// from clobbering the room's playback state.
				console.log('[playbacksync:bg] dropping pre-convergence intent', {
					tabId, type: msg.intent.type,
				})
				return
			}
			if (inSettleWindow(session, tabId)) {
				// Same family of cause as pre-convergence drops, but late: the
				// page's auto-resume / auto-play can fire seconds after the
				// adapter has applied the room's first authoritative command,
				// outside the 600 ms echo window. Drop until the settle window
				// elapses so these late writes don't reach the daemon.
				console.log('[playbacksync:bg] dropping settle-window intent', {
					tabId, type: msg.intent.type,
				})
				return
			}
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
			flushPendingConvergence(tabId)
			recomputeActiveIcon()
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
			session.convergedTabs.delete(tabId)
			session.settleUntilByTab.delete(tabId)
			forgetIconForTab(tabId)
			recomputeActiveIcon()
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
	setPopupCreds({ syncUrl })
	console.log('[playbacksync:bg] share-URL creds accepted; connecting')
	connect({ syncUrl, syncPassword }, session, wsCallbacks)
}

/**
 * Handle a popup → background message. Currently a single arm
 * (`leave_room`); future owner-driven affordances (cursor change
 * requests, playlist edits) will add more.
 *
 * On `leave_room`: tear down the WS socket, wipe stored creds, and
 * clear the popup-broadcast mirror. The mirror clear broadcasts a
 * `no_credentials` snapshot, which is what the popup re-renders to.
 *
 * @param msg The decoded envelope from the popup port.
 */
async function handlePopupMessage(msg: PopupToBackground): Promise<void> {
	switch (msg.kind) {
		case 'leave_room': {
			console.log('[playbacksync:bg] popup requested leave_room')
			disconnect()
			await tearDownSession()
			return
		}
	}
}

/**
 * If a convergence target was stashed because no tab had reported status
 * when ROOM_STATE / STATE / SYNC_ADJUST arrived, flush it to the freshest-
 * reporting tab now. Called from the `status` handler right after
 * `recordStatus` so `pickActiveTab` can see the new entry.
 *
 * @param reportingTabId The tab whose status just arrived; only flush when
 *   it is the one `pickActiveTab` picks, so we don't surprise an unrelated
 *   tab with commands meant for the synced video.
 */
function flushPendingConvergence(reportingTabId: number): void {
	const pending = session.pendingConvergence
	if (pending === null) return
	const active = pickActiveTab()
	if (!active || active[0] !== reportingTabId) return
	for (const cmd of pending) dispatchCommand(reportingTabId, cmd)
	markConverged(session, reportingTabId)
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
