/**
 * Background service worker entrypoint. Pools one WS client per syncing
 * tab; routes messages from content scripts (intent / status / identity
 * / fail) into the matching per-tab runtime; dispatches authoritative
 * commands back to that tab.
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
import type { VideoRefWithMeta } from '@/src/background/protocol'
import {
	type SessionState,
	createSession,
	hasConverged,
	inSettleWindow,
	recordCommand,
	shouldSuppress,
} from '@/src/background/session'
import {
	clearCreds,
	loadAllCreds,
	loadCreds,
	saveCreds,
	wipeIfFreshBrowserSession,
} from '@/src/background/storage'
import { forgetTab, getTab, recordIdentity, recordStatus } from '@/src/background/tabs'
import { forgetIconForTab, initGreyscaleDefaults, setColored } from '@/src/background/icon'
import {
	getDerivedStatus,
	initPopupBroadcast,
	notifyPopupCredsCleared,
	registerPopupPort,
	setPopupCreds,
} from '@/src/background/popupBroadcast'
import {
	connect,
	disconnect,
	hasRuntime,
	reportCatalog,
	reportIdentity,
	sendBuffer,
	sendCursorChangeRequest,
	sendEvent,
	type WsCallbacks,
} from '@/src/background/ws'

/** Per-tab session state. One entry per pooled WS runtime. */
const sessions = new Map<number, SessionState>()

/**
 * Tabs that the user soft-left (auto-leave on out-of-playlist or
 * single-mode click). Their `pbsync.tab.<tabId>` slot stays so a Rejoin
 * click can reconnect in one step, but until then, status messages from
 * the still-running content script must NOT trigger an auto-reconnect
 * via {@link ensureConnected} — that would defeat the whole point of
 * the soft-leave and loop the room through join/leave cycles every
 * heartbeat. The flag is cleared by explicit Rejoin, hard Leave room,
 * and tab close.
 */
const softLeftTabs = new Set<number>()

/**
 * Build the WS callback set for a given tab. The runtime closes over
 * `tabId` so `dispatchCommand` and `onLifecycleChange` don't need to
 * carry it.
 */
function makeCallbacks(tabId: number): WsCallbacks {
	return {
		dispatchCommand: (cmd) => dispatchCommand(tabId, cmd),
		onTerminal: (reason, code) => {
			// Terminal codes (ROOM_NOT_FOUND, ROOM_EXPIRED, ROOM_DELETED, KICKED,
			// AUTH_FAILED, CLIENT_ID_IN_USE) all mean this tab's stored creds
			// are dead — no reconnect can succeed, so wipe them now rather than
			// re-attempting on the next service-worker boot. Logged at `warn`
			// (not `error`) because these are expected protocol outcomes; in
			// MV3, any `console.error` from a service worker is surfaced on the
			// browser's extension-management page as a red error notification.
			console.warn('[playbacksync:bg] terminal close', { tabId, reason, code })
			void tearDownTab(tabId)
		},
		onLifecycleChange: () => recomputeIconForTab(tabId),
	}
}

/**
 * Wipe one tab's persisted credentials and per-tab session state, and
 * clear its popup mirror. Shared between the owner-driven `leave_room`
 * flow and the server-driven terminal-close flow so the two can't drift
 * on what counts as "this tab's session is over".
 *
 * Does not call `disconnect(tabId)` — callers that need it (e.g.
 * `leave_room`) invoke it themselves first; terminal closes have
 * already torn the socket down by the time `onTerminal` fires.
 */
async function tearDownTab(tabId: number): Promise<void> {
	await clearCreds(tabId)
	sessions.delete(tabId)
	softLeftTabs.delete(tabId)
	notifyPopupCredsCleared(tabId)
	setColored(tabId, false)
}

/**
 * Reconcile one tab's toolbar icon with its current runtime state.
 * Color when the WS room is `joined`, greyscale otherwise. Cheap to
 * call — idempotent.
 *
 * @param tabId The tab whose icon to repaint.
 */
function recomputeIconForTab(tabId: number): void {
	setColored(tabId, getDerivedStatus(tabId) === 'joined')
}

export default defineBackground(() => {
	console.log('[playbacksync:bg] worker booted')

	initPopupBroadcast(sessions)
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

	// chrome.tabs.onRemoved fires synchronously before the tab id can be
	// reused for a new tab, so the cleanup below is safe against id reuse.
	// forgetIconForTab runs *first* so the synchronous setColored(false)
	// triggered from disconnect's onLifecycleChange short-circuits — calling
	// chrome.action.setIcon on a tab that just went away surfaces as an
	// "Unchecked runtime.lastError: No tab with id" warning even when the
	// returned promise is caught, so the safest fix is to never make the
	// call in the first place.
	chrome.tabs.onRemoved.addListener((tabId: number) => {
		forgetIconForTab(tabId)
		disconnect(tabId)
		notifyPopupCredsCleared(tabId)
		void clearCreds(tabId)
		forgetTab(tabId)
		sessions.delete(tabId)
		softLeftTabs.delete(tabId)
	})
})

/**
 * Port name the toolbar popup uses for {@link chrome.runtime.connect}.
 * Must match the popup's call site verbatim.
 */
const POPUP_PORT_NAME = 'pbsync-popup'

/**
 * Service-worker boot path. Wipes orphan storage on the first boot of a
 * fresh browser session, then reconnects every tab whose creds slot
 * still has a live `chrome.tabs.id`. Slots whose tab no longer exists
 * are pruned.
 */
async function bootstrap(): Promise<void> {
	await wipeIfFreshBrowserSession()
	const all = await loadAllCreds()
	if (all.size === 0) {
		console.log(
			'[playbacksync:bg] no per-tab creds in chrome.storage.local; '
			+ 'follow a room share link to connect',
		)
		return
	}
	for (const [tabId, creds] of all) {
		try {
			await chrome.tabs.get(tabId)
		} catch {
			// Tab no longer exists — orphan slot from a previous worker
			// generation. Prune.
			await clearCreds(tabId)
			continue
		}
		ensureConnectedWithCreds(tabId, creds)
	}
}

/**
 * Lazy WS bootstrap for a single tab. If a runtime is already pooled
 * for this tab, no-op. Otherwise read the per-tab creds slot, build a
 * fresh session, and connect.
 *
 * Called from the message routes that imply this tab should be syncing
 * (`status` once the adapter is reporting, `credentials` right after
 * share-URL pickup).
 *
 * @param tabId Browser tab id whose runtime to bring up.
 */
async function ensureConnected(tabId: number): Promise<void> {
	if (hasRuntime(tabId)) return
	const creds = await loadCreds(tabId)
	if (!creds) return
	ensureConnectedWithCreds(tabId, creds)
}

function ensureConnectedWithCreds(tabId: number, creds: { syncUrl: string; syncPassword: string; clientId?: string }): void {
	if (hasRuntime(tabId)) return
	const session = createSession()
	sessions.set(tabId, session)
	setPopupCreds(tabId, { syncUrl: creds.syncUrl })
	connect(tabId, creds, session, makeCallbacks(tabId))
}

async function routeMessage(tabId: number | undefined, msg: ContentToBackground): Promise<void> {
	// Every arm is tab-scoped now — `credentials` writes to the
	// capturing tab's slot, so a sender tab id is required.
	if (tabId === undefined) return

	switch (msg.kind) {
		case 'credentials':
			await handleCredentials(tabId, msg.syncUrl, msg.syncPassword)
			return
		case 'intent': {
			const session = sessions.get(tabId)
			if (!session) return
			if (!hasConverged(session)) {
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
			if (inSettleWindow(session)) {
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
			if (shouldSuppress(session, msg.intent)) {
				console.log('[playbacksync:bg] suppressed echo intent', {
					tabId, type: msg.intent.type,
				})
				return
			}
			sendEvent(tabId, msg.intent)
			return
		}
		case 'status': {
			recordStatus(tabId, msg.adapterId, msg.state)
			// Soft-left tabs intentionally stay disconnected until Rejoin,
			// even though the content script is still polling status.
			if (!softLeftTabs.has(tabId)) void ensureConnected(tabId)
			const session = sessions.get(tabId)
			if (session) {
				const prev = session.lastPlayerState
				if (prev !== msg.state.playerState) {
					if (msg.state.playerState === 'buffering') {
						sendBuffer(tabId, 'BUFFER_START', msg.state.currentPos)
					} else if (prev === 'buffering') {
						sendBuffer(tabId, 'BUFFER_END', msg.state.currentPos)
					}
					session.lastPlayerState = msg.state.playerState
				}
			}
			return
		}
		case 'identity':
			recordIdentity(tabId, msg.adapterId, msg.identity)
			// The WS runtime's first-JOIN deferral is gated on identity +
			// catalog; feed it the wire-shape `VideoRef` built from the
			// adapter's identity plus the entrypoint-captured `pageUrl`.
			reportIdentity(tabId, {
				providerId: msg.identity.providerId,
				videoId: msg.identity.videoId,
				pageUrl: msg.pageUrl,
			})
			return
		case 'catalog':
			reportCatalog(tabId, msg.catalog)
			return
		case 'cursor_trigger':
			await handleCursorTrigger(tabId, msg.target)
			return
		case 'fail':
			console.warn('[playbacksync:bg] adapter failed', {
				tabId, adapterId: msg.adapterId, reason: msg.reason,
			})
			disconnect(tabId)
			await clearCreds(tabId)
			forgetTab(tabId)
			sessions.delete(tabId)
			softLeftTabs.delete(tabId)
			forgetIconForTab(tabId)
			return
	}
}

/**
 * Per-tab share-URL credential handoff. Each tab writes to its own
 * `pbsync.tab.<tabId>` slot, so multi-tab and multi-room joins coexist
 * without first-write-wins fighting.
 *
 * @param tabId Browser tab id of the page that captured the share URL.
 * @param syncUrl WebSocket URL produced by `ShareController::buildWebSocketUrl`.
 * @param syncPassword Plaintext one-time password the visitor typed at the Basic Auth prompt.
 */
async function handleCredentials(tabId: number, syncUrl: string, syncPassword: string): Promise<void> {
	await saveCreds(tabId, { syncUrl, syncPassword })
	console.log('[playbacksync:bg] share-URL creds accepted; connecting', { tabId })
	ensureConnectedWithCreds(tabId, { syncUrl, syncPassword })
}

/**
 * Resolve a user-initiated cursor trigger emitted by the adapter when
 * the user clicks an in-page navigation control. The local navigation
 * has already happened (or is happening) — this decides only what to
 * tell the room about it. Behaviour matrix:
 *
 * | mode     | target in playlist | not in playlist           |
 * | -------- | ------------------ | ------------------------- |
 * | default  | send request       | soft-leave                |
 * | single   | soft-leave         | soft-leave                |
 * | freeform | send request       | send request (server auto-appends) |
 *
 * "Soft-leave" tears down the per-tab WS runtime but **keeps** the
 * stored creds slot, so the popup can offer a one-click Rejoin without
 * the user re-typing or re-following the share link. Distinct from
 * `leave_room` (hard leave) which also wipes credentials.
 *
 * Freeform forwards every click unconditionally: the server's
 * `CursorService::resolveAndApply` auto-appends the not-in-playlist
 * target in the same transaction as the cursor move (capped by
 * `freeform_auto_append_cap`, oldest `auto_appended` entries pruned
 * first). This is freeform's whole intent — "clicks are cursor changes,
 * the playlist is a side effect" — so deferring to the server's
 * existing branch is preferable to a separate extension-side
 * `PLAYLIST_UPDATE` round-trip.
 *
 * @param tabId Browser tab the trigger came from.
 * @param target Full video identity the user clicked toward.
 */
async function handleCursorTrigger(tabId: number, target: VideoRefWithMeta): Promise<void> {
	const session = sessions.get(tabId)
	if (!session) {
		// No active room on this tab — nothing to announce, nothing to
		// leave. Adapter probably attached listeners before the WS came
		// up; harmless.
		return
	}

	if (session.mode === 'freeform') {
		console.log('[playbacksync:bg] cursor_trigger forwarding (freeform)', {
			tabId, videoId: target.videoId,
		})
		sendCursorChangeRequest(tabId, target)
		return
	}

	const inPlaylist = session.playlist.some(
		(entry) => entry.providerId === target.providerId && entry.videoId === target.videoId,
	)

	if (session.mode === 'single' || !inPlaylist) {
		console.log('[playbacksync:bg] cursor_trigger soft-leaving', {
			tabId, mode: session.mode, videoId: target.videoId, inPlaylist,
		})
		await softLeaveTab(tabId)
		return
	}

	console.log('[playbacksync:bg] cursor_trigger forwarding as CURSOR_CHANGE_REQUEST', {
		tabId, videoId: target.videoId,
	})
	sendCursorChangeRequest(tabId, target)
}

/**
 * Tear down a tab's WS runtime and per-tab session **without** wiping
 * its stored creds slot. The popup re-renders to `disconnected` (creds
 * present + no socket), surfacing a Rejoin affordance. Contrast with
 * {@link tearDownTab}, which is the hard-leave path used by terminal
 * close codes and the popup's `leave_room` envelope.
 *
 * @param tabId Browser tab to soft-leave.
 */
async function softLeaveTab(tabId: number): Promise<void> {
	disconnect(tabId)
	sessions.delete(tabId)
	softLeftTabs.add(tabId)
	// Deliberately NOT calling clearCreds / notifyPopupCredsCleared —
	// the credentials slot stays so Rejoin works in one click.
	// `disconnect()` already broadcasts the `disconnected` snapshot via
	// `notifyDisconnected`, and recomputes the toolbar icon.
}

/**
 * Re-establish the WS runtime for a tab using its still-stored creds
 * after a soft-leave. No-op if the runtime is already up (the popup
 * shouldn't normally surface Rejoin in that case, but be defensive) or
 * if the creds slot was somehow wiped before the user clicked.
 *
 * @param tabId Browser tab the popup is bound to.
 */
async function handleRejoinRoom(tabId: number): Promise<void> {
	if (hasRuntime(tabId)) {
		console.log('[playbacksync:bg] rejoin_room ignored: runtime already up', { tabId })
		softLeftTabs.delete(tabId)
		return
	}
	const creds = await loadCreds(tabId)
	if (!creds) {
		console.warn('[playbacksync:bg] rejoin_room with no stored creds', { tabId })
		softLeftTabs.delete(tabId)
		return
	}
	console.log('[playbacksync:bg] popup requested rejoin_room', { tabId })
	softLeftTabs.delete(tabId)
	ensureConnectedWithCreds(tabId, creds)
}

/**
 * Handle a popup → background message. Three arms:
 *
 * - `leave_room` — hard leave: tear down the WS socket, wipe creds,
 *   clear the popup mirror. The mirror clear broadcasts a
 *   `no_credentials` snapshot, which is what the popup re-renders to.
 * - `rejoin_room` — re-establish the WS runtime using still-stored
 *   creds after a soft-leave (auto-leave on out-of-playlist click).
 * - `subscribe` — handled by `popupBroadcast.ts` via the port directly.
 *
 * @param msg The decoded envelope from the popup port.
 */
async function handlePopupMessage(msg: PopupToBackground): Promise<void> {
	switch (msg.kind) {
		case 'leave_room': {
			console.log('[playbacksync:bg] popup requested leave_room', { tabId: msg.tabId })
			disconnect(msg.tabId)
			await tearDownTab(msg.tabId)
			return
		}
		case 'rejoin_room':
			await handleRejoinRoom(msg.tabId)
			return
		case 'subscribe':
			// Handled by popupBroadcast.ts via the port directly.
			return
	}
}

function dispatchCommand(tabId: number, cmd: AuthoritativeCommand): void {
	const session = sessions.get(tabId)
	if (!session) {
		console.warn('[playbacksync:bg] dispatch with no session', { tabId })
		return
	}
	// Arm the suppression window *before* the command lands, so the
	// reflected native event from the adapter is dropped.
	recordCommand(session, cmd)
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

