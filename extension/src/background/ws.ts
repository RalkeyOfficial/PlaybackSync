/**
 * WebSocket client: connection lifecycle, frame dispatch, reconnect
 * with tombstone replay, heartbeat + clock-ping timers. The only
 * module that constructs a `WebSocket`. Everything else (session
 * state, encoding, per-tab cache) is delegated.
 *
 * One runtime per syncing tab. Runtimes are pooled in {@link pool}
 * keyed by `chrome.tabs.id`, so multi-room and multi-tab joins coexist
 * in the same browser without sharing identity.
 *
 * The shape is a small state machine with three observable phases —
 * `connecting`, `open`, `closed` — driven by `WebSocket` events. On a
 * terminal close (auth fail, room gone, kicked) we stop reconnecting
 * and surface the error to the dev console; on any other close we back
 * off (1 s, 2 s, 4 s, 8 s, 16 s, 30 s, cap), and `JOIN` carries the
 * persisted `clientId` + `lastEventId` for replay.
 *
 * MV3 note: while a `WebSocket` is open, Chrome (≥ 116) resets the
 * service-worker idle timer on every frame, so the worker stays alive
 * for the whole session. Reconnect from a cold start triggers
 * `loadCreds()` again from the entrypoint.
 */

import {
	type InboundFrame,
	type OutboundFrame,
	type PlaylistEntrySource,
	type VideoRef,
	type VideoRefWithMeta,
	decode,
	encode,
} from './protocol'
import {
	type SessionState,
	applyClockPong,
	applyCursorChange,
	applyPlaylistUpdate,
	applyRoomState,
	applyState,
	applySyncAdjust,
	markConverged,
	resetConvergence,
	startClockPing,
} from './session'
import { saveClientId, type PbSyncCreds } from './storage'
import { getTab } from './tabs'
import {
	notifyConnecting,
	notifyCursorChanged,
	notifyDisconnected,
	notifyOpen,
	notifyRoomStateChanged,
} from './popupBroadcast'
import type { AuthoritativeCommand } from '@/src/adapters/types'

/** Close codes whose meaning is "give up, don't reconnect". */
const TERMINAL_ERROR_CODES = new Set([
	'ROOM_NOT_FOUND',
	'ROOM_EXPIRED',
	'ROOM_DELETED',
	'AUTH_FAILED',
	'KICKED',
	'CLIENT_ID_IN_USE',
])

const HEARTBEAT_INTERVAL_MS = 5_000
const CLOCK_PING_BURST_COUNT = 4
const CLOCK_PING_BURST_SPACING_MS = 250
const CLOCK_PING_PERIODIC_MS = 30_000
const RECONNECT_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000]

/**
 * Hard cap on how long the first JOIN waits for the content script to
 * report identity + catalog before going out with whatever's cached. The
 * runtime's own scrape timeout is 2 s; this leaves ~1 s of headroom for
 * the content→background IPC and the case where the adapter's `init`
 * itself is slow (cold miruro page waiting on Vidstack hydration).
 */
const FIRST_JOIN_DEFERRAL_MS = 3_000

/**
 * Callbacks the entrypoint provides so the WS module can fan out
 * server-driven commands and surface errors without itself knowing
 * about `chrome.*` APIs.
 *
 * Each callback set is bound to a single tab via the runtime that owns
 * it — `dispatchCommand` and `onLifecycleChange` therefore omit the
 * tabId from their signatures; the entrypoint closes over it when it
 * constructs the callbacks.
 */
export interface WsCallbacks {
	/** Deliver an authoritative command to this runtime's tab. */
	dispatchCommand(cmd: AuthoritativeCommand): void
	/** Surface a fatal protocol/connection error for logging. */
	onTerminal(reason: string, code: string | null): void
	/**
	 * Fired whenever the derived popup status may have changed —
	 * socket open/close and ROOM_STATE applied. Lets the entrypoint
	 * re-paint this tab's toolbar icon without `ws.ts` knowing about
	 * `chrome.action`.
	 */
	onLifecycleChange?(): void
}

interface WsRuntime {
	tabId: number
	socket: WebSocket | null
	heartbeatTimer: ReturnType<typeof setInterval> | null
	clockTimer: ReturnType<typeof setInterval> | null
	pendingPings: Map<number, number> // clientSendTime → local t1
	reconnectAttempt: number
	terminated: boolean
	creds: PbSyncCreds
	session: SessionState
	cb: WsCallbacks
	/**
	 * Most recent `currentlyShowing` reported by the content script for
	 * this tab. Used only on the first JOIN; persists across reconnects
	 * but is never resent (server has merged it once already).
	 */
	lastIdentity: VideoRef | null
	/**
	 * Most recent `catalogFragment` reported by the content script for
	 * this tab, or `null` when the adapter has no catalog. Same first-
	 * JOIN-only lifecycle as {@link lastIdentity}.
	 */
	lastCatalog: VideoRefWithMeta[] | null
	/**
	 * Whether the content script has reported a catalog result (even
	 * `null`) since this runtime was created. Distinguishes "adapter
	 * doesn't have one" (`catalogReported = true`, `lastCatalog = null`)
	 * from "we haven't heard from the adapter yet" (`catalogReported =
	 * false`). The pending JOIN can flush as soon as identity is known
	 * AND the catalog has been reported one way or another.
	 */
	catalogReported: boolean
	/**
	 * Active first-JOIN deferral timer, or `null` when no JOIN is
	 * pending (either because the first JOIN has already gone out, or
	 * because the socket isn't open). Cleared on flush, on socket close,
	 * and on `disconnect`.
	 */
	pendingJoinDeadline: ReturnType<typeof setTimeout> | null
	/**
	 * Whether the first JOIN frame has been emitted on this runtime.
	 * Reconnect JOINs reuse this to skip the content-field path entirely
	 * — `currentlyShowing` / `catalogFragment` are first-JOIN-only.
	 */
	firstJoinSent: boolean
}

const pool = new Map<number, WsRuntime>()

/**
 * Whether a runtime is already pooled for `tabId`. Used by the
 * entrypoint's lazy-connect helper.
 */
export function hasRuntime(tabId: number): boolean {
	return pool.has(tabId)
}

/**
 * Open a WebSocket for a specific tab and start its lifecycle.
 * Idempotent: calling while the tab is already connected is a no-op.
 *
 * @param tabId Browser tab id this runtime belongs to.
 * @param creds Credentials loaded from {@link loadCreds}.
 * @param session The mutable session state for that tab.
 * @param cb Outbound hooks the entrypoint wires up.
 */
export function connect(tabId: number, creds: PbSyncCreds, session: SessionState, cb: WsCallbacks): void {
	if (pool.has(tabId)) {
		log('warn', 'connect called while already connected; ignoring', { tabId })
		return
	}
	const r: WsRuntime = {
		tabId,
		socket: null,
		heartbeatTimer: null,
		clockTimer: null,
		pendingPings: new Map(),
		reconnectAttempt: 0,
		terminated: false,
		creds,
		session,
		cb,
		lastIdentity: null,
		lastCatalog: null,
		catalogReported: false,
		pendingJoinDeadline: null,
		firstJoinSent: false,
	}
	pool.set(tabId, r)
	openSocket(r)
}

/**
 * Stop everything for one tab: close the socket, kill its timers,
 * prevent reconnection, drop it from the pool. Called by the entrypoint
 * on `chrome.tabs.onRemoved`, on `fail`, and on leave-room from popup.
 *
 * @param tabId Browser tab id whose runtime to tear down.
 */
export function disconnect(tabId: number): void {
	const r = pool.get(tabId)
	if (!r) return
	r.terminated = true
	stopTimers(r)
	if (r.pendingJoinDeadline !== null) {
		clearTimeout(r.pendingJoinDeadline)
		r.pendingJoinDeadline = null
	}
	r.socket?.close(1000, 'client disconnect')
	pool.delete(tabId)
	notifyDisconnected(tabId)
	r.cb.onLifecycleChange?.()
}

/**
 * Forward a local intent as a wire `EVENT` frame on the given tab's
 * runtime. Called after the entrypoint has run suppression filtering.
 *
 * @param tabId Browser tab id whose runtime should emit the event.
 * @param intent The play/pause/seek intent to encode.
 */
export function sendEvent(tabId: number, intent: { type: 'play' | 'pause' | 'seek'; time: number }): void {
	const r = pool.get(tabId)
	if (!r?.socket || r.socket.readyState !== WebSocket.OPEN) return
	const frame: OutboundFrame = intent.type === 'seek'
		? { type: 'EVENT', event: 'seek', value: intent.time, clientTs: nowMs() }
		: { type: 'EVENT', event: intent.type, clientTs: nowMs() }
	send(r, frame)
}

/**
 * Send a `CURSOR_CHANGE_REQUEST` frame for a given tab. Used after the
 * background's per-mode decision logic accepts a user-initiated cursor
 * trigger (e.g. an episode-button click) and resolves it to a target
 * already in the room's playlist. The server arbitrates by mode; the
 * matching `CURSOR_CHANGE` broadcast comes back through the normal
 * inbound path.
 *
 * No-op if the runtime isn't pooled or the socket isn't open — the
 * caller doesn't need to inspect runtime state before calling.
 *
 * @param tabId Browser tab id whose runtime should emit the frame.
 * @param target Full identity of the target video; the server matches
 *   it against the existing playlist by `(providerId, videoId)`.
 */
export function sendCursorChangeRequest(tabId: number, target: VideoRefWithMeta): void {
	const r = pool.get(tabId)
	if (!r?.socket || r.socket.readyState !== WebSocket.OPEN) return
	send(r, { type: 'CURSOR_CHANGE_REQUEST', target, clientTs: nowMs() })
}

/**
 * Send a `PLAYLIST_UPDATE` frame for a given tab. The server merges the
 * candidate `entries` into the room's playlist by `(providerId,
 * videoId)`, then broadcasts the post-merge playlist as an inbound
 * `PLAYLIST_UPDATE` that every client (including this one) applies via
 * `applyPlaylistUpdate`.
 *
 * This function is currently dormant: no UI in the extension calls it.
 * It exists so the next adapter or popup affordance that wants to
 * contribute entries from outside the existing in-page episode-list
 * surface (handled by the cursor-trigger path; see {@link
 * sendCursorChangeRequest}) has a single, mode-aware entry point. The
 * shape is deliberately minimal — a future caller decides what counts
 * as "contributing this page" in its own context, builds the
 * `VideoRefWithMeta` payload, and calls in here.
 *
 * **Freeform chain rule.** When the session is in freeform mode and
 * `opts.chainCursorTo` is provided, the function follows the merge with
 * a `CURSOR_CHANGE_REQUEST` for the same ref. This mirrors freeform's
 * intent ("clicks are cursor changes, the playlist is a side effect")
 * so callers don't have to replicate the rule. The two frames go out on
 * the same socket and are processed in order by the server: the merge
 * commits inside the room lock, then the cursor-change reacquires the
 * lock and resolves against the merged playlist. In default mode
 * `chainCursorTo` is ignored — adding and navigating are kept separate
 * to match the cursor-trigger spec's default-mode philosophy.
 *
 * **Single mode.** The server rejects `PLAYLIST_UPDATE` in single mode
 * with `single_mode_locked`. This function does **not** pre-gate;
 * callers are expected to read `session.mode` from the popup snapshot
 * (or wherever they track it) and hide their UI in single mode.
 *
 * No-op if the runtime isn't pooled or the socket isn't open — same
 * fail-quiet contract as the rest of the send helpers.
 *
 * @param tabId Browser tab id whose runtime should emit the frame.
 * @param entries Candidate entries to merge. Each must include
 *   `providerId`, `videoId`, `pageUrl`; `label` / `episodeNumber` /
 *   `seasonNumber` / `source` are optional. Server enforces a 200-entry
 *   per-message cap.
 * @param opts Optional. `chainCursorTo` is honored only when the
 *   session is in freeform mode; ignored otherwise.
 */
export function sendPlaylistUpdate(
	tabId: number,
	entries: Array<VideoRefWithMeta & { source?: PlaylistEntrySource }>,
	opts?: { chainCursorTo?: VideoRefWithMeta },
): void {
	const r = pool.get(tabId)
	if (!r?.socket || r.socket.readyState !== WebSocket.OPEN) return
	send(r, { type: 'PLAYLIST_UPDATE', entries, clientTs: nowMs() })

	if (opts?.chainCursorTo && r.session.mode === 'freeform') {
		sendCursorChangeRequest(tabId, opts.chainCursorTo)
	}
}

/**
 * Notify the daemon of a buffer transition on a given tab's runtime.
 * Called by the entrypoint when an incoming `status` flips
 * `playerState` to/from `'buffering'`.
 *
 * @param tabId Browser tab id whose runtime should emit the frame.
 * @param kind `BUFFER_START` or `BUFFER_END`.
 * @param videoPos Current playhead at the transition.
 */
export function sendBuffer(tabId: number, kind: 'BUFFER_START' | 'BUFFER_END', videoPos: number): void {
	const r = pool.get(tabId)
	if (!r?.socket || r.socket.readyState !== WebSocket.OPEN) return
	send(r, { type: kind, videoPos })
}

// ─── Socket lifecycle ────────────────────────────────────────────────

function openSocket(r: WsRuntime): void {
	log('info', 'connecting', { tabId: r.tabId, url: redactUrl(r.creds.syncUrl) })
	// Each connection re-gates: the tab has to be re-converged by the
	// fresh ROOM_STATE before its intents flow again.
	resetConvergence(r.session)
	notifyConnecting(r.tabId, r.creds.syncUrl)
	const socket = new WebSocket(r.creds.syncUrl)
	r.socket = socket

	socket.addEventListener('open', () => onOpen(r))
	socket.addEventListener('message', (ev) => onMessage(r, ev))
	socket.addEventListener('close', (ev) => onClose(r, ev))
	socket.addEventListener('error', () => log('warn', 'socket error (close will follow)', { tabId: r.tabId }))
}

function onOpen(r: WsRuntime): void {
	r.reconnectAttempt = 0
	startTimers(r)
	scheduleInitialClockPings(r)
	notifyOpen(r.tabId)
	r.cb.onLifecycleChange?.()

	if (r.firstJoinSent) {
		// Reconnect: server has already merged the content fields from the
		// first JOIN; replaying would be best-effort idempotent but adds
		// noise. Just resume the session via the bare JOIN form.
		log('info', 'open; sending reconnect JOIN', { tabId: r.tabId })
		sendJoin(r, false)
		return
	}

	log('info', 'open; deferring first JOIN for identity/catalog', { tabId: r.tabId })
	r.pendingJoinDeadline = setTimeout(() => {
		log('info', 'first-JOIN deadline elapsed; flushing without content fields', {
			tabId: r.tabId,
		})
		flushJoin(r)
	}, FIRST_JOIN_DEFERRAL_MS)
	// Identity/catalog may already be cached from a prior socket on this
	// runtime; if so, flush immediately rather than waiting out the timer.
	maybeFlushJoin(r)
}

/**
 * Send a `JOIN` frame on the runtime's open socket. `includeContentFields`
 * gates the first-JOIN-only fields (`currentlyShowing` /
 * `catalogFragment`); reconnects pass `false`.
 *
 * @param r The per-tab WS runtime.
 * @param includeContentFields Whether to attach the cached identity /
 *   catalog. Always `false` on reconnects.
 */
function sendJoin(r: WsRuntime, includeContentFields: boolean): void {
	send(r, {
		type: 'JOIN',
		password: r.creds.syncPassword,
		...(r.creds.clientId ? { clientId: r.creds.clientId } : {}),
		...(r.session.lastEventId > 0 ? { lastEventId: r.session.lastEventId } : {}),
		...(includeContentFields && r.lastIdentity
			? { currentlyShowing: r.lastIdentity }
			: {}),
		...(includeContentFields && r.lastCatalog && r.lastCatalog.length > 0
			? { catalogFragment: r.lastCatalog }
			: {}),
	})
}

/**
 * Flush a pending first JOIN: clear the deadline timer, emit the frame
 * with whatever content fields are cached, and latch `firstJoinSent` so
 * subsequent reconnects bypass this path. No-op if no JOIN is pending —
 * safe to call defensively.
 *
 * @param r The per-tab WS runtime.
 */
function flushJoin(r: WsRuntime): void {
	if (r.pendingJoinDeadline === null && r.firstJoinSent) return
	if (r.pendingJoinDeadline !== null) {
		clearTimeout(r.pendingJoinDeadline)
		r.pendingJoinDeadline = null
	}
	sendJoin(r, true)
	r.firstJoinSent = true
}

/**
 * Flush the pending first JOIN if both gates are ready: identity must be
 * known, and the catalog must have been reported (even as `null`). Called
 * after every identity/catalog update from the content script — the first
 * call that satisfies both gates wins, the others fall through.
 *
 * @param r The per-tab WS runtime.
 */
function maybeFlushJoin(r: WsRuntime): void {
	if (r.firstJoinSent) return
	if (r.pendingJoinDeadline === null) return
	if (r.lastIdentity === null) return
	if (!r.catalogReported) return
	log('info', 'first-JOIN gates satisfied; flushing', { tabId: r.tabId })
	flushJoin(r)
}

/**
 * Update the cached `currentlyShowing` for a tab. Invoked by the
 * background message router when a content-script `identity` message
 * arrives. Triggers a JOIN flush if the catalog has already been
 * reported.
 *
 * @param tabId Browser tab the content script belongs to.
 * @param identity The `VideoRef` built by the entrypoint from the
 *   adapter's `ContentIdentity` + `location.href`.
 */
export function reportIdentity(tabId: number, identity: VideoRef): void {
	const r = pool.get(tabId)
	if (!r) return
	r.lastIdentity = identity
	maybeFlushJoin(r)
}

/**
 * Update the cached `catalogFragment` for a tab. Invoked by the
 * background message router when a content-script `catalog` message
 * arrives. Flips `catalogReported` even when `catalog` is `null`, so the
 * pending-JOIN gate can release for adapters without a usable catalog.
 *
 * @param tabId Browser tab the content script belongs to.
 * @param catalog The scraped catalog, or `null` when none is available.
 */
export function reportCatalog(tabId: number, catalog: VideoRefWithMeta[] | null): void {
	const r = pool.get(tabId)
	if (!r) return
	r.lastCatalog = catalog
	r.catalogReported = true
	maybeFlushJoin(r)
}

function onMessage(r: WsRuntime, ev: MessageEvent): void {
	if (typeof ev.data !== 'string') {
		log('warn', 'non-string frame; dropping', { tabId: r.tabId })
		return
	}
	const decoded = decode(ev.data)
	if (!decoded.ok) {
		log('warn', 'decode failed', { tabId: r.tabId, error: decoded.error, detail: decoded.detail })
		return
	}
	handleFrame(r, decoded.frame)
}

function onClose(r: WsRuntime, ev: CloseEvent): void {
	stopTimers(r)
	if (r.pendingJoinDeadline !== null) {
		// The socket is gone before the deferred JOIN went out; cancel the
		// timer. The next `onOpen` will set up a fresh deferral if needed.
		clearTimeout(r.pendingJoinDeadline)
		r.pendingJoinDeadline = null
	}
	r.socket = null
	log('info', 'close', { tabId: r.tabId, code: ev.code, reason: ev.reason })
	notifyDisconnected(r.tabId)
	r.cb.onLifecycleChange?.()
	if (r.terminated) return

	// reason carries the daemon's protocol-level code on terminal closes.
	const reason = ev.reason
	if (TERMINAL_ERROR_CODES.has(reason)) {
		r.cb.onTerminal(reason, reason)
		r.terminated = true
		pool.delete(r.tabId)
		return
	}
	scheduleReconnect(r)
}

function scheduleReconnect(r: WsRuntime): void {
	const idx = Math.min(r.reconnectAttempt, RECONNECT_BACKOFF_MS.length - 1)
	const delay = RECONNECT_BACKOFF_MS[idx]
	r.reconnectAttempt += 1
	if (r.reconnectAttempt > RECONNECT_BACKOFF_MS.length + 1) {
		log('error', 'giving up after repeated reconnect failures', { tabId: r.tabId })
		r.terminated = true
		pool.delete(r.tabId)
		r.cb.onTerminal('reconnect exhausted', null)
		return
	}
	log('info', 'reconnecting', { tabId: r.tabId, inMs: delay, attempt: r.reconnectAttempt })
	setTimeout(() => {
		if (r.terminated) return
		openSocket(r)
	}, delay)
}

// ─── Inbound frame dispatch ─────────────────────────────────────────

function handleFrame(r: WsRuntime, frame: InboundFrame): void {
	switch (frame.type) {
		case 'ROOM_STATE': {
			if (r.session.clientId !== frame.clientId) {
				void saveClientId(r.tabId, frame.clientId)
			}
			dispatchToOwner(r, applyRoomState(r.session, frame))
			notifyRoomStateChanged(r.tabId)
			r.cb.onLifecycleChange?.()
			return
		}
		case 'STATE':
			dispatchToOwner(r, applyState(r.session, frame))
			return
		case 'CURSOR_CHANGE':
			// Re-arm the join settle window: miruro (and similar players) auto-
			// restore the viewer's last position on the new episode shortly
			// after the source loads, which the adapter would otherwise observe
			// as a fresh `seeking` event and ship to the room as a real EVENT.
			// `resetConvergence` flips the gate off; the terminal
			// `markConverged` inside `dispatchToOwner` flips it back on and
			// arms a fresh settle window — matching exactly the pattern that
			// already covers JOIN-time auto-resume.
			resetConvergence(r.session)
			dispatchToOwner(r, applyCursorChange(r.session, frame))
			notifyCursorChanged(r.tabId)
			return
		case 'PLAYLIST_UPDATE':
			applyPlaylistUpdate(r.session, frame)
			return
		case 'SYNC_ADJUST':
			dispatchToOwner(r, applySyncAdjust(r.session, frame))
			return
		case 'CLOCK_PONG': {
			const t1 = frame.clientSendTime
			const t4 = nowMs()
			r.pendingPings.delete(t1)
			applyClockPong(r.session, t1, frame.serverRecvTime, frame.serverSendTime, t4)
			return
		}
		case 'ERROR':
			log('warn', 'server ERROR frame', { tabId: r.tabId, code: frame.code, message: frame.message })
			if (TERMINAL_ERROR_CODES.has(frame.code)) {
				// Mark terminated synchronously: the daemon sends ERROR
				// immediately before closing the socket, and without this the
				// subsequent close-event would fall through to the reconnect
				// path because `ev.reason` is typically empty on a server-
				// initiated close.
				r.terminated = true
				r.cb.onTerminal(frame.message, frame.code)
				pool.delete(r.tabId)
			}
			return
	}
}

function dispatchToOwner(r: WsRuntime, cmds: AuthoritativeCommand[]): void {
	if (cmds.length === 0) return
	for (const cmd of cmds) r.cb.dispatchCommand(cmd)
	markConverged(r.session)
}

// ─── Timers ────────────────────────────────────────────────────────

function startTimers(r: WsRuntime): void {
	stopTimers(r)
	r.heartbeatTimer = setInterval(() => fireHeartbeat(r), HEARTBEAT_INTERVAL_MS)
	r.clockTimer = setInterval(() => fireClockPing(r), CLOCK_PING_PERIODIC_MS)
}

function stopTimers(r: WsRuntime): void {
	if (r.heartbeatTimer !== null) {
		clearInterval(r.heartbeatTimer)
		r.heartbeatTimer = null
	}
	if (r.clockTimer !== null) {
		clearInterval(r.clockTimer)
		r.clockTimer = null
	}
}

function fireHeartbeat(r: WsRuntime): void {
	const entry = getTab(r.tabId)
	const state = entry?.latestState
	if (!state) return
	send(r, { type: 'HEARTBEAT', currentPos: state.currentPos, playerState: state.playerState })
}

function fireClockPing(r: WsRuntime): void {
	const t1 = startClockPing()
	r.pendingPings.set(t1, t1)
	send(r, { type: 'CLOCK_PING', clientSendTime: t1 })
}

function scheduleInitialClockPings(r: WsRuntime): void {
	for (let i = 0; i < CLOCK_PING_BURST_COUNT; i += 1) {
		setTimeout(() => {
			if (pool.get(r.tabId) !== r) return
			if (r.socket?.readyState !== WebSocket.OPEN) return
			fireClockPing(r)
		}, i * CLOCK_PING_BURST_SPACING_MS)
	}
}

// ─── Helpers ───────────────────────────────────────────────────────

function send(r: WsRuntime, frame: OutboundFrame): void {
	r.socket?.send(encode(frame))
}

function nowMs(): number {
	return Date.now()
}

function redactUrl(url: string): string {
	// Strip any query string before logging — the credential-pickup spec
	// will eventually carry secrets here.
	const q = url.indexOf('?')
	return q === -1 ? url : url.slice(0, q) + '?…'
}

function log(level: 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>): void {
	const line = `[playbacksync:ws] ${msg}`
	const payload = data ?? {}
	if (level === 'error') console.error(line, payload)
	else if (level === 'warn') console.warn(line, payload)
	else console.log(line, payload)
}
