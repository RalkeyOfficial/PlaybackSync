/**
 * Background service worker entrypoint. Pools one WS client per syncing
 * tab; routes messages from content scripts (intent / status / identity
 * / fail) into the matching per-tab runtime; dispatches authoritative
 * commands back to that tab.
 *
 * Everything WS-related lives in `src/background/`; this file is the
 * thin glue that owns `chrome.*` APIs and forwards.
 */

import type { AuthoritativeCommand, ContentIdentity } from '@/src/adapters/types'
import type {
	BackgroundToContent,
	ContentToBackground,
	PopupToBackground,
} from '@/src/messages'
import type { CursorRef, VideoRefWithMeta } from '@/src/background/protocol'
import {
	type SessionState,
	buildResyncCommands,
	createSession,
	hasConverged,
	inSettleWindow,
	markConverged,
	recordCommand,
	resetConvergence,
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
import { navigableUrlForCursor, videoIdForUrl } from '@/src/adapters/url-matchers'

/** Per-tab session state. One entry per pooled WS runtime. */
const sessions = new Map<number, SessionState>()

/**
 * Tabs whose active adapter opted into the navigation-guard (via
 * `Adapter.guardNavigation`, echoed on the `identity` message), mapped to
 * that adapter's id. The `chrome.tabs.onUpdated` guard only acts for tabs
 * in this map, so it never fires for adapters that didn't opt in or sites
 * structured differently. The adapter id is kept because the guard resolves
 * a live URL to a room video id through that adapter's matcher (see
 * {@link isRoomUrl} / `src/adapters/url-matchers.ts`) — URL semantics live
 * in the adapter, not in this generic guard. Populated/cleared from the
 * `identity` handler and the teardown paths ({@link tearDownTab}, adapter
 * `fail`, tab removal). Kept independent of {@link sessions} because the
 * `identity` message can arrive before the WS session exists.
 */
const navGuardedTabs = new Map<number, string>()

/**
 * How long the navigation-guard waits before acting on an off-playlist
 * URL. The window lets the DOM-driven pull-back (`pullTabBackToCursor`
 * synth-click, fired from the same user click) land first; the guard
 * then re-reads the live URL and only hard-navigates if the tab is
 * still off-playlist. Non-click departures (home link, address bar,
 * cross-site) have no synth-click, so the guard acts after this delay.
 */
const NAV_GUARD_DEBOUNCE_MS = 300

/** Pending navigation-guard re-check timers, keyed by tab. */
const navGuardTimers = new Map<number, ReturnType<typeof setTimeout>>()

/**
 * Pending reload-convergence fallback timers, keyed by tab. Armed in
 * {@link recheckAndPullBack} when a guard pull-back un-converges a tab,
 * and cancelled once the reload ends — early (the reloaded page reports
 * the cursor identity), on supersession (a fresh pull-back), or on
 * session teardown ({@link clearNavGuard}). Tracked like
 * {@link navGuardTimers} so the timer can never outlive the reload it
 * protects.
 */
const navReloadTimers = new Map<number, ReturnType<typeof setTimeout>>()

/**
 * Safety net for the navigation-guard's re-convergence. A guard pull-back
 * un-converges the session and waits for the reloaded page to report the
 * cursor's `identity` before re-converging (see {@link recheckAndPullBack}
 * and the `identity` route). If that identity never arrives — a
 * stale/redirecting cursor URL, an adapter that won't init — this timeout
 * re-converges anyway so the tab can't get stuck dropping every intent.
 */
const GUARD_RELOAD_CONVERGE_FALLBACK_MS = 4_000

/**
 * How long after the reloaded page reports the cursor `identity` the guard
 * waits before re-applying the room's cached playback (see
 * {@link scheduleGuardResync}). The `identity` message already implies the
 * adapter found a loaded `<video>` (it's reported after the adapter's
 * source wait), so this is a short settle for the player to finish wiring
 * up `currentTime` / `play()` — not a wait for readiness.
 */
const GUARD_RESYNC_SETTLE_MS = 300

/**
 * Safety net for a nav-guard-forwarded cursor change. Forwarding a
 * `CURSOR_CHANGE_REQUEST` un-converges the tab (so the new episode player's
 * autoplay / resume-seek is dropped mid-round-trip); normally the server's
 * `CURSOR_CHANGE` broadcast re-converges it. If the request is rejected or
 * lost, this timeout re-converges anyway so the tab can't get stuck dropping
 * every intent. See {@link forwardCursorChangeFromNav}.
 */
const CURSOR_REQUEST_CONVERGE_FALLBACK_MS = 3_000

/** Pending cursor-change re-convergence fallback timers, keyed by tab. */
const cursorRequestTimers = new Map<number, ReturnType<typeof setTimeout>>()

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
	clearNavGuard(tabId)
	notifyPopupCredsCleared(tabId)
	setColored(tabId, false)
}

/**
 * Disarm the navigation-guard for a tab: drop it from
 * {@link navGuardedTabs} and cancel any pending re-check timer. Called
 * from every path that ends a tab's session.
 *
 * @param tabId The tab to disarm.
 */
function clearNavGuard(tabId: number): void {
	navGuardedTabs.delete(tabId)
	const timer = navGuardTimers.get(tabId)
	if (timer !== undefined) {
		clearTimeout(timer)
		navGuardTimers.delete(tabId)
	}
	clearNavReloadTimer(tabId)
	clearCursorRequestTimer(tabId)
}

/**
 * Cancel a tab's pending cursor-change re-convergence fallback timer, if any.
 * Called when a fresh forward supersedes it and from {@link clearNavGuard} on
 * every session-teardown path.
 *
 * @param tabId The tab whose fallback timer to cancel.
 */
function clearCursorRequestTimer(tabId: number): void {
	const timer = cursorRequestTimers.get(tabId)
	if (timer !== undefined) {
		clearTimeout(timer)
		cursorRequestTimers.delete(tabId)
	}
}

/**
 * Cancel a tab's pending reload-convergence fallback timer, if any. Called
 * when the reload finishes early (the cursor identity arrives), when a
 * fresh pull-back supersedes it, and from {@link clearNavGuard} on every
 * session-teardown path.
 *
 * @param tabId The tab whose fallback timer to cancel.
 */
function clearNavReloadTimer(tabId: number): void {
	const timer = navReloadTimers.get(tabId)
	if (timer !== undefined) {
		clearTimeout(timer)
		navReloadTimers.delete(tabId)
	}
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
		clearNavGuard(tabId)
	})

	// Navigation-guard: pull an anchored-room tab back to the cursor when it
	// navigates to a URL outside the playlist by any means the in-page DOM
	// click listener can't see (home link, address bar, back/forward,
	// cross-site). Only acts for tabs whose adapter opted in via
	// `Adapter.guardNavigation`. See `handleTabNavigation`.
	chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
		if (changeInfo.url === undefined) return
		handleTabNavigation(tabId, changeInfo.url)
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
			void ensureConnected(tabId)
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
		case 'identity': {
			recordIdentity(tabId, msg.adapterId, msg.identity)
			// Arm/disarm the navigation-guard per the active adapter's opt-in,
			// recording the adapter id so the guard can resolve URLs through it.
			if (msg.guardNavigation) navGuardedTabs.set(tabId, msg.adapterId)
			else clearNavGuard(tabId)
			maybeEndGuardReload(tabId, msg.identity)
			// The WS runtime's first-JOIN deferral is gated on identity +
			// catalog; feed it the wire-shape `VideoRef` built from the
			// adapter's identity plus the entrypoint-captured `pageUrl`.
			reportIdentity(tabId, {
				providerId: msg.identity.providerId,
				videoId: msg.identity.videoId,
				pageUrl: msg.pageUrl,
			})
			return
		}
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
			clearNavGuard(tabId)
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
 * | mode     | target in playlist | not in playlist                    |
 * | -------- | ------------------ | ---------------------------------- |
 * | default  | send request       | pull tab back to cursor            |
 * | single   | pull tab back      | pull tab back                      |
 * | freeform | send request       | send request (server auto-appends) |
 *
 * Anchored modes (default, single) treat navigation as something the
 * room politely corrects, not as a signal that the user left. Default's
 * playlist is the source of truth, so an off-list click is yanked back
 * to the cursor's pageUrl; single's locked entry is the only valid
 * destination, so any click that doesn't match it is yanked back. The
 * WS runtime stays connected throughout. Leaving a room is only ever
 * done via the popup's explicit Leave Room button, never inferred from
 * navigation — misclicks on related-video thumbnails would otherwise be
 * destructive.
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
		// pull back. Adapter probably attached listeners before the WS
		// came up; harmless.
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
		console.log('[playbacksync:bg] cursor_trigger pulling tab back to cursor', {
			tabId, mode: session.mode, videoId: target.videoId, inPlaylist,
		})
		pullTabBackToCursor(tabId, session)
		return
	}

	console.log('[playbacksync:bg] cursor_trigger forwarding as CURSOR_CHANGE_REQUEST', {
		tabId, videoId: target.videoId,
	})
	sendCursorChangeRequest(tabId, target)
}

/**
 * Yank the tab back to the room's current cursor by dispatching a
 * synthetic `cursor_change` command through the same content-script
 * channel server-broadcast `CURSOR_CHANGE` frames use. The adapter
 * applies it via its existing receive path (synthetic `.click()` on the
 * matching episode button, falling back to `location.href` when the SPA
 * shortcut isn't viable). The synthetic click is filtered out of the
 * adapter's own cursor-trigger listener via `Event.isTrusted`, so the
 * pull-back doesn't bounce back as a fresh `CURSOR_CHANGE_REQUEST`.
 *
 * No-op when the room has no cursor yet (empty playlist in default
 * mode, pre-JOIN race) — there's nowhere to pull back to. No-op when
 * the cursor's pageUrl matches the click target's URL: the adapter
 * short-circuits on `location.href === pageUrl`, but bailing early
 * here keeps the log line truthful.
 *
 * @param tabId Browser tab to pull back.
 * @param session The tab's session, holding the authoritative cursor.
 */
function pullTabBackToCursor(tabId: number, session: SessionState): void {
	if (!session.cursor) return
	dispatchCommand(tabId, { type: 'cursor_change', pageUrl: session.cursor.pageUrl })
}

/**
 * Resolve the navigation-guard context for a tab, or `null` when the guard
 * must not act: the tab isn't armed, has no session, or has no cursor to act
 * against. Freeform is excluded by default (the pull-back path never coerces a
 * freeform tab); callers on the forward path pass `includeFreeform` because a
 * freeform move *is* a cursor change. Shared by {@link handleTabNavigation},
 * {@link routeGuardedNav}, and {@link recheckAndPullBack} so they can't drift
 * on which tabs the guard may act on; each keeps the extra checks that are
 * uniquely its own (arm-side convergence gating vs. post-debounce live URL
 * re-read).
 *
 * @param tabId The tab to resolve.
 * @param opts.includeFreeform Resolve context for freeform tabs too (forward
 *   path); omit/false to exclude them (pull-back path).
 * @returns The armed adapter id, its session, and the non-null cursor, or
 *   `null` when the guard must not act.
 */
function guardContext(
	tabId: number,
	opts?: { includeFreeform?: boolean },
): { adapterId: string; session: SessionState; cursor: CursorRef } | null {
	const adapterId = navGuardedTabs.get(tabId)
	if (adapterId === undefined) return null
	const session = sessions.get(tabId)
	if (!session || !session.cursor) return null
	if (session.mode === 'freeform' && !opts?.includeFreeform) return null
	return { adapterId, session, cursor: session.cursor }
}

/**
 * Navigation-guard entry point: a guarded tab's URL changed. This is the
 * browser-level detector for *every* way a viewer can move between videos —
 * the player's "Next episode" button, prev/keyboard shortcuts, end-of-video
 * autoplay-advance, back/forward, the address bar, cross-site links — because
 * `chrome.tabs.onUpdated` sees the URL change even when it originates in the
 * page's main world (which the content script's isolated-world history patch
 * cannot). It arms a debounced re-check; {@link routeGuardedNav} then decides
 * per room mode whether the move is a cursor change to *forward*, a departure
 * to *pull back*, or a no-op.
 *
 * The decision is deferred by {@link NAV_GUARD_DEBOUNCE_MS} and then made
 * against the tab's *live* URL, not the URL that triggered this call, so
 * transient intermediate URLs (miruro's slug-canonicalising redirect, a
 * synth-click pull-back landing) collapse into the settled destination.
 *
 * @param tabId The tab whose URL changed.
 * @param url The new URL reported by `chrome.tabs.onUpdated`.
 */
function handleTabNavigation(tabId: number, url: string): void {
	const ctx = guardContext(tabId, { includeFreeform: true })
	if (!ctx) return
	const { adapterId, session, cursor } = ctx
	// A pull-back is already in flight for this tab (reload under way);
	// don't stack another on the intermediate URL changes.
	if (session.awaitingReload) return
	// Join-time mismatch is the server's job: it steers a joiner to the
	// cursor via a unicast CURSOR_CHANGE → in-page synth-click. The guard
	// must stay out of that window or it races the steering with a
	// redundant hard navigation (two refreshes on join) and trips the
	// join-settle seek suppression. Only act once the tab has converged
	// on the room and the settle window has elapsed — i.e. genuine
	// mid-session moves.
	if (!hasConverged(session) || inSettleWindow(session)) return

	let incomingVideoId: string | null
	try {
		incomingVideoId = videoIdForUrl(adapterId, new URL(url))
	} catch {
		incomingVideoId = null
	}
	// Loop-stop / manual return: the URL already resolves to the cursor (a
	// room-driven nav lands here because the frame fold set `session.cursor`
	// to the new videoId before the driven nav completed; a manual return
	// needs no action either). Skip arming.
	if (incomingVideoId !== null && incomingVideoId === cursor.videoId) return

	const existing = navGuardTimers.get(tabId)
	if (existing !== undefined) clearTimeout(existing)
	navGuardTimers.set(tabId, setTimeout(() => {
		navGuardTimers.delete(tabId)
		void routeGuardedNav(tabId)
	}, NAV_GUARD_DEBOUNCE_MS))
}

/**
 * After the debounce, resolve the tab's *live* URL to a room video id and
 * route the move per room mode (partitioned so exactly one branch acts):
 *
 * - resolves to the cursor → no-op (loop-stop / already on cursor).
 * - freeform + resolvable → forward as a cursor change (the server
 *   auto-appends off-playlist targets); freeform + unresolvable (cross-site)
 *   → no-op (freeform never coerces).
 * - default + in-playlist → forward as a cursor change.
 * - single + in-playlist → lightweight synth-click pull-back (playlist locked).
 * - otherwise (default/single off-playlist, any cross-site) → hard-reload
 *   pull-back ({@link recheckAndPullBack}), whose convergence gating is
 *   required to suppress the reloaded player's auto-resume seek.
 *
 * @param tabId The tab to route.
 */
async function routeGuardedNav(tabId: number): Promise<void> {
	const ctx = guardContext(tabId, { includeFreeform: true })
	if (!ctx) return
	const { adapterId, session, cursor } = ctx
	// State can change during the debounce; re-check the arm-side gates.
	if (session.awaitingReload) return
	if (!hasConverged(session) || inSettleWindow(session)) return

	let tab: chrome.tabs.Tab
	try {
		tab = await chrome.tabs.get(tabId)
	} catch {
		// Tab closed between arming and firing; nothing to do.
		return
	}
	const liveUrl = tab.url
	if (!liveUrl) return

	let videoId: string | null
	try {
		videoId = videoIdForUrl(adapterId, new URL(liveUrl))
	} catch {
		videoId = null
	}

	// Loop-stop / already on cursor.
	if (videoId !== null && videoId === cursor.videoId) return

	const entry =
		videoId === null
			? undefined
			: session.playlist.find(
					(e) => e.providerId === cursor.providerId && e.videoId === videoId,
			  )

	if (session.mode === 'freeform') {
		// Cross-site / unresolvable: nothing to forward, and freeform never
		// pulls a tab back — leave it be.
		if (videoId === null) return
		forwardCursorChangeFromNav(tabId, session, {
			providerId: cursor.providerId,
			videoId,
			// Never the raw tab URL — it can carry the `#sync_url…` credential
			// fragment. `navigableUrlForCursor` rebuilds a clean canonical URL.
			pageUrl: navigableUrlForCursor(adapterId, { videoId, pageUrl: liveUrl }) ?? liveUrl,
		})
		return
	}

	if (entry !== undefined) {
		if (session.mode === 'single') {
			// Playlist is locked; yank the tab straight back to the cursor.
			pullTabBackToCursor(tabId, session)
			return
		}
		// default + in-playlist: a legitimate cursor change. Build the target
		// from the playlist entry (already carries clean pageUrl + metadata).
		forwardCursorChangeFromNav(tabId, session, {
			providerId: entry.providerId,
			videoId: entry.videoId,
			pageUrl: entry.pageUrl,
			label: entry.label,
			episodeNumber: entry.episodeNumber,
			seasonNumber: entry.seasonNumber,
		})
		return
	}

	// Off-playlist (default/single) or cross-site (null videoId): hard-reload
	// back to the cursor.
	void recheckAndPullBack(tabId)
}

/**
 * Forward a nav-detected cursor move to the room as a `CURSOR_CHANGE_REQUEST`.
 * Un-converges the tab first so the new episode player's autoplay /
 * auto-resume-seek is dropped (not shipped as a wire `EVENT`) during the
 * request→broadcast round trip — the same gate the `intent` route enforces.
 * The server's `CURSOR_CHANGE` broadcast re-converges the tab; the fallback
 * timer re-converges if that never arrives so a rejected/lost request can't
 * strand the tab dropping every intent.
 *
 * @param tabId The tab the move came from.
 * @param session The tab's session, un-converged here.
 * @param target The video the viewer moved to.
 */
function forwardCursorChangeFromNav(
	tabId: number,
	session: SessionState,
	target: VideoRefWithMeta,
): void {
	console.log('[playbacksync:bg] nav-guard forwarding CURSOR_CHANGE_REQUEST', {
		tabId, mode: session.mode, videoId: target.videoId,
	})
	resetConvergence(session)
	clearCursorRequestTimer(tabId)
	cursorRequestTimers.set(tabId, setTimeout(() => {
		cursorRequestTimers.delete(tabId)
		const s = sessions.get(tabId)
		if (s && !hasConverged(s)) {
			console.warn('[playbacksync:bg] nav-guard cursor-change converge fallback', { tabId })
			markConverged(s)
		}
	}, CURSOR_REQUEST_CONVERGE_FALLBACK_MS))
	sendCursorChangeRequest(tabId, target)
}

/**
 * After the debounce, re-read the tab's live URL and hard-navigate back
 * to the cursor only if it's still off the room's content. Reading the
 * live URL (rather than trusting the URL that armed the timer) is what
 * lets a DOM synth-click that already corrected the tab win the race.
 *
 * @param tabId The tab to re-check.
 */
async function recheckAndPullBack(tabId: number): Promise<void> {
	const ctx = guardContext(tabId)
	if (!ctx) return
	const { adapterId, session, cursor } = ctx

	let tab: chrome.tabs.Tab
	try {
		tab = await chrome.tabs.get(tabId)
	} catch {
		// Tab closed between arming and firing; nothing to do.
		return
	}
	const liveUrl = tab.url
	if (!liveUrl || isRoomUrl(session, liveUrl, adapterId)) return

	// Build the pull-back target from the cursor's canonical identity, not its
	// raw `pageUrl`: the adapter (`navigableUrlForCursor`) reconstructs the
	// `?ep=` from the cursor's `videoId` and preserves the show slug from the
	// cursor's path (so miruro serves it directly instead of bouncing through
	// its slug-canonicalising redirect). Falls back to the raw `pageUrl` for
	// adapters with no builder registered. No credentials are attached — they
	// live in the background's per-tab storage and the socket survives the
	// reload, so the tab stays joined without carrying creds in the URL.
	const target = navigableUrlForCursor(adapterId, cursor) ?? cursor.pageUrl

	console.log('[playbacksync:bg] nav-guard pulling tab back to cursor', {
		tabId, liveUrl, target,
	})
	// `chrome.tabs.update` is a full page load, but the WS lives in the
	// background and survives it — so we deliberately do NOT close the
	// socket (closing it would announce a spurious client_left/_joined flap
	// to the room). Instead re-run the join grace period in place: un-
	// converge now so the reloaded player's autoplay / resume-position
	// intents are dropped, and `awaitingReload` holds convergence off (even
	// against server frames landing mid-reload) until the reloaded page
	// reports the cursor's identity and re-`markConverged`s (see the
	// `identity` route). The fallback re-converges if that identity never
	// comes, so the tab can't get stuck dropping every intent.
	resetConvergence(session)
	session.awaitingReload = true
	// Supersede any prior fallback (a pull-back already in flight) so only
	// one timer is ever live per tab; it's cancelled when the reload ends
	// early (the `identity` route) or the session is torn down.
	clearNavReloadTimer(tabId)
	navReloadTimers.set(tabId, setTimeout(() => {
		navReloadTimers.delete(tabId)
		const s = sessions.get(tabId)
		if (s?.awaitingReload) {
			console.warn('[playbacksync:bg] nav-guard reload converge fallback', { tabId })
			s.awaitingReload = false
			markConverged(s)
		}
	}, GUARD_RELOAD_CONVERGE_FALLBACK_MS))
	void chrome.tabs.update(tabId, { url: target }).catch(() => {
		// Tab closed or navigation blocked; `onRemoved` will clean up.
	})
}

/**
 * After a guard reload lands back on the cursor, re-apply the room's
 * cached playback to the freshly-loaded video. The guard keeps the socket
 * open across the reload, so the daemon sends no fresh `ROOM_STATE` — left
 * alone, the reloaded player would sit at the wrong position / play-state
 * until the next periodic frame (`SYNC_ADJUST`, seconds later), which the
 * user sees as a sluggish snap-back. Instead we replay
 * {@link buildResyncCommands} after a short settle.
 *
 * Guarded against a re-armed pull-back: if another navigation un-converged
 * the tab again within the settle, `awaitingReload` is back on and we skip,
 * leaving that reload's own `identity` to drive the next resync.
 *
 * @param tabId The reloaded tab to resync.
 */
function scheduleGuardResync(tabId: number): void {
	setTimeout(() => {
		const session = sessions.get(tabId)
		if (!session || session.awaitingReload) return
		const cmds = buildResyncCommands(session)
		if (cmds.length === 0) return
		console.log('[playbacksync:bg] nav-guard resyncing reloaded tab to room playback', {
			tabId, playerState: session.lastRoomPlayback?.playerState,
		})
		for (const cmd of cmds) dispatchCommand(tabId, cmd)
	}, GUARD_RESYNC_SETTLE_MS)
}

/**
 * Land the guard pull-back's reload when the reloaded page reports its
 * identity. If the tab is mid-reload from a {@link recheckAndPullBack}
 * hard-nav and this identity matches the cursor, clear the awaiting-reload
 * state, cancel the convergence-fallback, re-`markConverged` so a fresh
 * settle window drops the reloaded player's delayed resume-position seek,
 * and schedule a resync to the room's cached playback. Matching on the
 * cursor (not just any identity) prevents a lingering identity from the
 * pre-reload page ending the grace early. No-op when no reload is in
 * flight.
 *
 * @param tabId The tab whose identity just arrived.
 * @param identity The active adapter's reported identity for the page.
 */
function maybeEndGuardReload(tabId: number, identity: ContentIdentity): void {
	const session = sessions.get(tabId)
	if (!session?.awaitingReload) return
	if (!session.cursor) return
	if (session.cursor.providerId !== identity.providerId) return
	if (session.cursor.videoId !== identity.videoId) return
	session.awaitingReload = false
	clearNavReloadTimer(tabId)
	markConverged(session)
	scheduleGuardResync(tabId)
}

/**
 * Whether `url` is a page the room considers valid to sit on: the current
 * cursor, or any entry already in the playlist. The cursor check is also
 * the guard's loop-stop — after a pull-back the tab lands on the cursor
 * URL, which matches here so the guard doesn't re-fire.
 *
 * Membership is by **video identity, not URL string**. The live URL is
 * resolved to a canonical video id through the active adapter's matcher
 * ({@link videoIdForUrl}) — each site owns its own URL semantics there
 * (miruro's optional slug, query-based ids, etc.), so this generic guard
 * never has to guess. A `null` id means the URL isn't a recognised content
 * page for that adapter (a different site, the home page, a search page),
 * which counts as off-playlist.
 *
 * @param session The tab's session.
 * @param url The live tab URL to test.
 * @param adapterId The adapter active on the tab, selecting the matcher.
 * @returns `true` when `url` resolves to the cursor or a playlist entry.
 */
function isRoomUrl(session: SessionState, url: string, adapterId: string): boolean {
	let parsed: URL
	try {
		parsed = new URL(url)
	} catch {
		return false
	}
	const videoId = videoIdForUrl(adapterId, parsed)
	if (videoId === null) return false
	if (session.cursor?.videoId === videoId) return true
	return session.playlist.some((entry) => entry.videoId === videoId)
}

/**
 * Handle a popup → background message. Two arms:
 *
 * - `leave_room` — hard leave: tear down the WS socket, wipe creds,
 *   clear the popup mirror. The mirror clear broadcasts a
 *   `no_credentials` snapshot, which is what the popup re-renders to.
 *   This is the *only* user-driven path that leaves a room; navigation
 *   in default or single mode pulls the tab back rather than leaving
 *   (see {@link handleCursorTrigger}).
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

