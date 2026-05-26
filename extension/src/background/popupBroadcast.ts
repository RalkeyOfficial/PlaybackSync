/**
 * Push-based snapshot channel between the background worker and the
 * toolbar popup. Owns three concerns:
 *
 * 1. A registry of open `chrome.runtime.Port`s from popup instances,
 *    each bound to a single `tabId` via the popup's `subscribe`
 *    envelope.
 * 2. A per-tab mirror of WS-runtime / creds state so a
 *    {@link PopupStatus} can be derived without importing back into
 *    `ws.ts` (that would create a cycle: `ws.ts` calls `notify*`
 *    helpers in here).
 * 3. The derivation rule that turns
 *    `(creds, socketState, session.clientId)` into a single
 *    {@link PopupStatus} tag for a tab.
 *
 * Snapshots are pushed eagerly: the popup never polls. The triggers
 * are deliberate — we broadcast on lifecycle transitions
 * (`connecting`, socket open, socket close), on `ROOM_STATE` and
 * `CURSOR_CHANGE` server frames, and when creds change (share-URL
 * pickup, leave-room clear). We do **not** broadcast on `STATE`
 * frames (~1 Hz per tab, no popup-visible fields change) or on
 * `PLAYLIST_UPDATE` (no playlist UI in this slice).
 *
 * The state mirrored here is intentionally minimal: a `creds` ref
 * carrying only the `syncUrl` (password is never displayed; see
 * {@link ../messages.PopupSnapshot}) and a `socketState` tag. The
 * authoritative per-tab session state lives in the sessions map owned
 * by the entrypoint and injected via {@link initPopupBroadcast}.
 */

import type {
	BackgroundToPopup,
	PopupSnapshot,
	PopupStatus,
} from '@/src/messages'
import type { SessionState } from './session'

/**
 * Coarse-grained mirror of `WsRuntime` lifecycle. `'none'` means no
 * WS runtime exists for the tab (cold boot before `connect()` or
 * after `disconnect()` plus `clearCreds()`). `'disconnected'` means a
 * runtime existed and the socket dropped (reconnect-pending) —
 * distinct from `'none'` because the popup shows the reconnecting
 * copy rather than the no-creds copy. Terminal closes wipe creds and
 * flip the mirror to `'none'`, never surfacing as `'disconnected'`.
 */
type SocketState = 'none' | 'connecting' | 'open' | 'disconnected'

interface TabMirror {
	socketState: SocketState
	creds: { syncUrl: string } | null
}

let sessions: Map<number, SessionState> | null = null
const mirrors = new Map<number, TabMirror>()
const portTabs = new Map<chrome.runtime.Port, number>()

/**
 * Wire the broadcast module to the per-tab session map. Called once
 * from the background entrypoint at boot. Cannot be done at module-
 * init time because the entrypoint owns the map.
 *
 * @param s The per-tab session map shared with the WS pool.
 */
export function initPopupBroadcast(s: Map<number, SessionState>): void {
	sessions = s
}

function ensureMirror(tabId: number): TabMirror {
	let m = mirrors.get(tabId)
	if (!m) {
		m = { socketState: 'none', creds: null }
		mirrors.set(tabId, m)
	}
	return m
}

/**
 * Replace the mirrored creds reference for a tab. Called by the
 * entrypoint after `saveCreds()` (share-URL pickup or boot reconnect).
 * Triggers a broadcast to any port bound to this tab.
 *
 * Only `syncUrl` is mirrored; `syncPassword` never crosses this
 * boundary by design.
 *
 * @param tabId The tab whose mirror to update.
 * @param next The new credentials reference.
 */
export function setPopupCreds(tabId: number, next: { syncUrl: string }): void {
	const m = ensureMirror(tabId)
	m.creds = next
	broadcastForTab(tabId)
}

/**
 * Clear the mirror for a tab after creds wipe / leave-room. Broadcasts
 * a fresh `no_credentials` snapshot to any port still bound to this
 * tab.
 *
 * @param tabId The tab whose mirror to clear.
 */
export function notifyPopupCredsCleared(tabId: number): void {
	mirrors.delete(tabId)
	broadcastForTab(tabId)
}

/**
 * Note that the WS client is opening a fresh socket for a tab. Called
 * from `ws.openSocket`. Carries `url` because the popup's "Connecting
 * to …" copy needs it and it's not always already in the mirror.
 *
 * @param tabId The tab whose runtime is opening.
 * @param url The WebSocket URL being dialled.
 */
export function notifyConnecting(tabId: number, url: string): void {
	const m = ensureMirror(tabId)
	m.socketState = 'connecting'
	m.creds = { syncUrl: url }
	broadcastForTab(tabId)
}

/**
 * Note that this tab's socket reached `'open'`. Called from
 * `ws.onOpen`.
 *
 * @param tabId The tab whose socket opened.
 */
export function notifyOpen(tabId: number): void {
	const m = ensureMirror(tabId)
	m.socketState = 'open'
	broadcastForTab(tabId)
}

/**
 * Note that a tab's socket closed. Called from `ws.onClose` (reconnect
 * pending), `ws.scheduleReconnect`'s give-up branch, and
 * `ws.disconnect`. We don't distinguish those at the popup layer —
 * they all surface as `'disconnected'` until creds are explicitly
 * cleared.
 *
 * @param tabId The tab whose socket closed.
 */
export function notifyDisconnected(tabId: number): void {
	const m = mirrors.get(tabId)
	if (!m) return
	m.socketState = 'disconnected'
	broadcastForTab(tabId)
}

/**
 * Note that a `ROOM_STATE` frame was applied to a tab's session.
 * Called from `ws.handleFrame` immediately after `applyRoomState`.
 * This is the transition that flips `clientId` from `null` to a
 * value, which in turn flips the derived status from `connecting` to
 * `joined`.
 *
 * @param tabId The tab whose session was just folded.
 */
export function notifyRoomStateChanged(tabId: number): void {
	broadcastForTab(tabId)
}

/**
 * Note that a `CURSOR_CHANGE` frame was applied to a tab's session.
 * Called from `ws.handleFrame` immediately after `applyCursorChange`.
 *
 * @param tabId The tab whose session was just folded.
 */
export function notifyCursorChanged(tabId: number): void {
	broadcastForTab(tabId)
}

/**
 * Register a popup `Port`. Reaps the port on disconnect. The first
 * snapshot is sent once the popup posts a `subscribe` envelope naming
 * the tab it wants to observe — until then the port is silent.
 *
 * @param port The port the popup just opened with name `'pbsync-popup'`.
 */
export function registerPopupPort(port: chrome.runtime.Port): void {
	port.onMessage.addListener((msg: unknown) => {
		if (!msg || typeof msg !== 'object') return
		const env = msg as { kind?: string; tabId?: number }
		if (env.kind !== 'subscribe') return
		if (typeof env.tabId !== 'number') return
		portTabs.set(port, env.tabId)
		sendTo(port, env.tabId)
	})
	port.onDisconnect.addListener(() => {
		portTabs.delete(port)
	})
}

/**
 * How many popup ports are currently registered. Used by diagnostic
 * logging and any future health check.
 *
 * @returns The current open-port count.
 */
export function getRegisteredPopupPortCount(): number {
	return portTabs.size
}

/**
 * Compute the {@link PopupStatus} a popup bound to `tabId` should
 * display now. Pure function of the per-tab mirror (`creds`,
 * `socketState`) and the injected session's `clientId`. Exported for
 * the entrypoint's icon-repaint hook; the broadcast pipeline calls it
 * inline.
 *
 * @param tabId The tab whose status to derive.
 * @returns The derived status tag.
 */
export function getDerivedStatus(tabId: number): PopupStatus {
	const m = mirrors.get(tabId)
	if (!m || m.creds === null) return 'no_credentials'
	if (m.socketState === 'connecting') return 'connecting'
	if (m.socketState === 'open') {
		const session = sessions?.get(tabId)
		return session?.clientId ? 'joined' : 'connecting'
	}
	// socketState === 'none' || 'disconnected' with creds present.
	return 'disconnected'
}

function buildSnapshot(tabId: number): PopupSnapshot {
	const status = getDerivedStatus(tabId)
	if (status === 'no_credentials') {
		return {
			tabId: null,
			status,
			clientId: null,
			cursor: null,
			mode: null,
			syncUrl: null,
		}
	}
	const m = mirrors.get(tabId)
	const session = sessions?.get(tabId)
	return {
		tabId,
		status,
		clientId: session?.clientId ?? null,
		cursor: session?.cursor ?? null,
		// `mode` is only meaningful once `ROOM_STATE` lands; before then
		// the session default ('default') would be misleading.
		mode: status === 'joined' ? (session?.mode ?? 'default') : null,
		syncUrl: m?.creds?.syncUrl ?? null,
	}
}

function sendTo(port: chrome.runtime.Port, tabId: number): void {
	const env: BackgroundToPopup = { kind: 'snapshot', snapshot: buildSnapshot(tabId) }
	try {
		port.postMessage(env)
	} catch {
		// Port closed mid-send. `onDisconnect` will reap it; nothing
		// actionable here.
	}
}

function broadcastForTab(tabId: number): void {
	if (portTabs.size === 0) return
	const env: BackgroundToPopup = { kind: 'snapshot', snapshot: buildSnapshot(tabId) }
	for (const [port, boundTabId] of portTabs) {
		if (boundTabId !== tabId) continue
		try {
			port.postMessage(env)
		} catch {
			// Port closed mid-send; `onDisconnect` will reap it.
		}
	}
}
