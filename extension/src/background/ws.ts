/**
 * WebSocket client: connection lifecycle, frame dispatch, reconnect
 * with tombstone replay, heartbeat + clock-ping timers. The only
 * module that constructs a `WebSocket`. Everything else (session
 * state, encoding, per-tab cache) is delegated.
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
import { pickActiveTab } from './tabs'
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
 * Callbacks the entrypoint provides so the WS module can fan out
 * server-driven commands and surface errors without itself knowing
 * about `chrome.*` APIs.
 */
export interface WsCallbacks {
	/** Deliver an authoritative command to one tab. */
	dispatchCommand(tabId: number, cmd: AuthoritativeCommand): void
	/** Surface a fatal protocol/connection error for logging. */
	onTerminal(reason: string, code: string | null): void
	/**
	 * Fired whenever the derived popup status may have changed —
	 * socket open/close and ROOM_STATE applied. Lets the entrypoint
	 * re-paint per-tab toolbar icons without `ws.ts` knowing about
	 * `chrome.action`.
	 */
	onLifecycleChange?(): void
}

interface WsRuntime {
	socket: WebSocket | null
	heartbeatTimer: ReturnType<typeof setInterval> | null
	clockTimer: ReturnType<typeof setInterval> | null
	pendingPings: Map<number, number> // clientSendTime → local t1
	reconnectAttempt: number
	terminated: boolean
	creds: PbSyncCreds
	session: SessionState
	cb: WsCallbacks
}

let runtime: WsRuntime | null = null

/**
 * Open a WebSocket to the daemon and start the connection lifecycle.
 * Idempotent: calling while connected is a no-op.
 *
 * @param creds Credentials loaded from {@link loadCreds}.
 * @param session The mutable session state.
 * @param cb Outbound hooks the entrypoint wires up.
 */
export function connect(creds: PbSyncCreds, session: SessionState, cb: WsCallbacks): void {
	if (runtime) {
		log('warn', 'connect called while already connected; ignoring')
		return
	}
	runtime = {
		socket: null,
		heartbeatTimer: null,
		clockTimer: null,
		pendingPings: new Map(),
		reconnectAttempt: 0,
		terminated: false,
		creds,
		session,
		cb,
	}
	openSocket(runtime)
}

/**
 * Stop everything: close the socket, kill all timers, prevent
 * reconnection. The entrypoint calls this on creds clear / leave-room.
 */
export function disconnect(): void {
	if (!runtime) return
	const cb = runtime.cb
	runtime.terminated = true
	stopTimers(runtime)
	runtime.socket?.close(1000, 'client disconnect')
	runtime = null
	notifyDisconnected()
	cb.onLifecycleChange?.()
}

/**
 * Forward a local intent as a wire `EVENT` frame. Called after the
 * entrypoint has run suppression filtering.
 */
export function sendEvent(intent: { type: 'play' | 'pause' | 'seek'; time: number }): void {
	if (!runtime?.socket || runtime.socket.readyState !== WebSocket.OPEN) return
	const frame: OutboundFrame = intent.type === 'seek'
		? { type: 'EVENT', event: 'seek', value: intent.time, clientTs: nowMs() }
		: { type: 'EVENT', event: intent.type, clientTs: nowMs() }
	send(runtime, frame)
}

/**
 * Notify the daemon of a buffer transition. Called by the entrypoint
 * when an incoming `status` flips `playerState` to/from `'buffering'`.
 */
export function sendBuffer(kind: 'BUFFER_START' | 'BUFFER_END', videoPos: number): void {
	if (!runtime?.socket || runtime.socket.readyState !== WebSocket.OPEN) return
	send(runtime, { type: kind, videoPos })
}

// ─── Socket lifecycle ────────────────────────────────────────────────

function openSocket(r: WsRuntime): void {
	log('info', 'connecting', { url: redactUrl(r.creds.syncUrl) })
	// Each connection re-gates: a cached tab from a prior connection has to
	// be re-converged by the fresh ROOM_STATE before its intents flow again.
	resetConvergence(r.session)
	notifyConnecting(r.creds.syncUrl)
	const socket = new WebSocket(r.creds.syncUrl)
	r.socket = socket

	socket.addEventListener('open', () => onOpen(r))
	socket.addEventListener('message', (ev) => onMessage(r, ev))
	socket.addEventListener('close', (ev) => onClose(r, ev))
	socket.addEventListener('error', () => log('warn', 'socket error (close will follow)'))
}

function onOpen(r: WsRuntime): void {
	log('info', 'open; sending JOIN')
	r.reconnectAttempt = 0
	send(r, {
		type: 'JOIN',
		password: r.creds.syncPassword,
		...(r.creds.clientId ? { clientId: r.creds.clientId } : {}),
		...(r.session.lastEventId > 0 ? { lastEventId: r.session.lastEventId } : {}),
	})
	startTimers(r)
	scheduleInitialClockPings(r)
	notifyOpen()
	r.cb.onLifecycleChange?.()
}

function onMessage(r: WsRuntime, ev: MessageEvent): void {
	if (typeof ev.data !== 'string') {
		log('warn', 'non-string frame; dropping')
		return
	}
	const decoded = decode(ev.data)
	if (!decoded.ok) {
		log('warn', 'decode failed', { error: decoded.error, detail: decoded.detail })
		return
	}
	handleFrame(r, decoded.frame)
}

function onClose(r: WsRuntime, ev: CloseEvent): void {
	stopTimers(r)
	r.socket = null
	log('info', 'close', { code: ev.code, reason: ev.reason })
	notifyDisconnected()
	r.cb.onLifecycleChange?.()
	if (r.terminated) return

	// reason carries the daemon's protocol-level code on terminal closes.
	const reason = ev.reason
	if (TERMINAL_ERROR_CODES.has(reason)) {
		r.cb.onTerminal(reason, reason)
		r.terminated = true
		runtime = null
		return
	}
	scheduleReconnect(r)
}

function scheduleReconnect(r: WsRuntime): void {
	const idx = Math.min(r.reconnectAttempt, RECONNECT_BACKOFF_MS.length - 1)
	const delay = RECONNECT_BACKOFF_MS[idx]
	r.reconnectAttempt += 1
	if (r.reconnectAttempt > RECONNECT_BACKOFF_MS.length + 1) {
		log('error', 'giving up after repeated reconnect failures')
		r.terminated = true
		runtime = null
		r.cb.onTerminal('reconnect exhausted', null)
		return
	}
	log('info', 'reconnecting', { inMs: delay, attempt: r.reconnectAttempt })
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
				void saveClientId(frame.clientId)
			}
			dispatchAll(r, applyRoomState(r.session, frame))
			notifyRoomStateChanged()
			r.cb.onLifecycleChange?.()
			return
		}
		case 'STATE':
			dispatchAll(r, applyState(r.session, frame))
			return
		case 'CURSOR_CHANGE':
			dispatchAll(r, applyCursorChange(r.session, frame))
			notifyCursorChanged()
			return
		case 'PLAYLIST_UPDATE':
			applyPlaylistUpdate(r.session, frame)
			return
		case 'SYNC_ADJUST':
			dispatchAll(r, applySyncAdjust(r.session, frame))
			return
		case 'CLOCK_PONG': {
			const t1 = frame.clientSendTime
			const t4 = nowMs()
			r.pendingPings.delete(t1)
			applyClockPong(r.session, t1, frame.serverRecvTime, frame.serverSendTime, t4)
			return
		}
		case 'ERROR':
			log('warn', 'server ERROR frame', { code: frame.code, message: frame.message })
			if (TERMINAL_ERROR_CODES.has(frame.code)) {
				// Mark terminated synchronously: the daemon sends ERROR
				// immediately before closing the socket, and without this the
				// subsequent close-event would fall through to the reconnect
				// path because `ev.reason` is typically empty on a server-
				// initiated close.
				r.terminated = true
				r.cb.onTerminal(frame.message, frame.code)
				runtime = null
			}
			return
	}
}

function dispatchAll(r: WsRuntime, cmds: AuthoritativeCommand[]): void {
	if (cmds.length === 0) return
	const active = pickActiveTab()
	if (!active) {
		// No tab has reported status yet — stash the convergence target so the
		// entrypoint can flush it the moment the first `status` arrives. Newer
		// frames overwrite older ones; we always want to converge to the
		// freshest authoritative state.
		log('info', 'no active tab; deferring convergence', { count: cmds.length })
		r.session.pendingConvergence = cmds
		return
	}
	const [tabId] = active
	for (const cmd of cmds) r.cb.dispatchCommand(tabId, cmd)
	markConverged(r.session, tabId)
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
	const active = pickActiveTab()
	if (!active) return
	const [, entry] = active
	const state = entry.latestState
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
			if (!runtime || runtime !== r) return
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
