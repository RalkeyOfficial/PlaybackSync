/**
 * Push-based snapshot channel between the background worker and the
 * toolbar popup. Owns three concerns:
 *
 * 1. A registry of open `chrome.runtime.Port`s from popup instances
 *    (one per popup window — usually 0 or 1).
 * 2. A small mirror of WS-runtime / creds state so a {@link PopupStatus}
 *    can be derived without importing back into `ws.ts` (that would
 *    create a cycle: `ws.ts` calls `notify*` helpers in here).
 * 3. The derivation rule that turns
 *    `(creds, socketState, session.clientId)` into a single
 *    {@link PopupStatus} tag.
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
 * authoritative session state lives in `session.ts`; we read from it
 * via the {@link initPopupBroadcast}-injected reference.
 */

import type {
	BackgroundToPopup,
	PopupSnapshot,
	PopupStatus,
} from '@/src/messages'
import type { SessionState } from './session'

/**
 * Coarse-grained mirror of `WsRuntime` lifecycle. `'none'` means no
 * WS runtime exists (cold boot before `connect()` or after
 * `disconnect()` plus `clearCreds()`). `'disconnected'` means a
 * runtime existed and the socket dropped (reconnect-pending or
 * terminal) — distinct from `'none'` because the popup shows
 * "Connection lost…" rather than the no-creds copy.
 */
type SocketState = 'none' | 'connecting' | 'open' | 'disconnected'

let session: SessionState | null = null
let socketState: SocketState = 'none'
let creds: { syncUrl: string } | null = null
const ports = new Set<chrome.runtime.Port>()

/**
 * Wire the broadcast module to the session record. Called once from
 * the background entrypoint at boot. Cannot be done at module-init
 * time because `createSession()` is owned by the entrypoint.
 *
 * @param s The mutable session state shared with the WS client.
 */
export function initPopupBroadcast(s: SessionState): void {
	session = s
}

/**
 * Replace the mirrored creds reference. Called by the entrypoint
 * after `loadCreds()` (boot), after `saveCreds()` (share-URL pickup),
 * and after `clearCreds()` (leave-room — pass `null`). Triggers a
 * broadcast so popups already open see the change immediately.
 *
 * Only `syncUrl` is mirrored; `syncPassword` never crosses this
 * boundary by design.
 *
 * @param next The new credentials reference, or `null` after a clear.
 */
export function setPopupCreds(next: { syncUrl: string } | null): void {
	creds = next
	if (next === null) {
		// Clearing creds also resets the socket-state mirror — a
		// `'disconnected'` tag without creds would derive to
		// `'no_credentials'` anyway, but resetting keeps the internal
		// invariant clean.
		socketState = 'none'
	}
	broadcast()
}

/**
 * Note that the WS client is opening a fresh socket. Called from
 * `ws.openSocket`. Carries `url` because the popup's "Connecting to
 * …" copy needs it and it's not always already in the mirror (the
 * connection-pickup flow does `connect()` before `setPopupCreds()`).
 *
 * @param url The WebSocket URL being dialled.
 */
export function notifyConnecting(url: string): void {
	socketState = 'connecting'
	creds = { syncUrl: url }
	broadcast()
}

/** Note that the socket reached `'open'`. Called from `ws.onOpen`. */
export function notifyOpen(): void {
	socketState = 'open'
	broadcast()
}

/**
 * Note that the socket closed. Called from `ws.onClose` (reconnect
 * pending), `ws.scheduleReconnect`'s give-up branch, and
 * `ws.disconnect`. We don't distinguish those at the popup layer —
 * they all surface as `'disconnected'` until creds are explicitly
 * cleared.
 */
export function notifyDisconnected(): void {
	socketState = 'disconnected'
	broadcast()
}

/**
 * Note that a `ROOM_STATE` frame was applied to the session. Called
 * from `ws.handleFrame` immediately after `applyRoomState`. This is
 * the transition that flips `clientId` from `null` to a value, which
 * in turn flips the derived status from `connecting` to `joined`.
 */
export function notifyRoomStateChanged(): void {
	broadcast()
}

/**
 * Note that a `CURSOR_CHANGE` frame was applied. Called from
 * `ws.handleFrame` immediately after `applyCursorChange`. The cursor
 * is the only popup-visible field that changes outside of lifecycle
 * transitions; without this hook the popup would show a stale cursor
 * line until the next reconnect.
 */
export function notifyCursorChanged(): void {
	broadcast()
}

/**
 * Register a popup `Port`. Pushes one snapshot immediately so the
 * popup never renders an empty / loading state, then removes the
 * port on disconnect. Called from the `chrome.runtime.onConnect`
 * listener in the background entrypoint.
 *
 * @param port The port the popup just opened with name
 *             `'pbsync-popup'`.
 */
export function registerPopupPort(port: chrome.runtime.Port): void {
	ports.add(port)
	sendTo(port)
	port.onDisconnect.addListener(() => {
		ports.delete(port)
	})
}

/**
 * How many popup ports are currently registered. Used by the
 * manual-verification step ("port set should not grow unboundedly")
 * and for diagnostic logging.
 *
 * @returns The current open-port count.
 */
export function getRegisteredPopupPortCount(): number {
	return ports.size
}

/**
 * Compute the {@link PopupStatus} the popup should display now. Pure
 * function of the module-local mirrors (`creds`, `socketState`) and
 * the injected `session.clientId`. Exported for tests / future
 * debugging affordances; the broadcast pipeline calls it inline.
 *
 * @returns The derived status tag.
 */
export function getDerivedStatus(): PopupStatus {
	if (creds === null) return 'no_credentials'
	if (socketState === 'connecting') return 'connecting'
	if (socketState === 'open') {
		return session?.clientId ? 'joined' : 'connecting'
	}
	// socketState === 'none' || 'disconnected' with creds present.
	return 'disconnected'
}

function buildSnapshot(): PopupSnapshot {
	const status = getDerivedStatus()
	if (status === 'no_credentials') {
		return {
			status,
			clientId: null,
			cursor: null,
			mode: null,
			syncUrl: null,
		}
	}
	return {
		status,
		clientId: session?.clientId ?? null,
		cursor: session?.cursor ?? null,
		// `mode` is only meaningful once `ROOM_STATE` lands; before then
		// the session default ('default') would be misleading.
		mode: status === 'joined' ? (session?.mode ?? 'default') : null,
		syncUrl: creds?.syncUrl ?? null,
	}
}

function sendTo(port: chrome.runtime.Port): void {
	const env: BackgroundToPopup = { kind: 'snapshot', snapshot: buildSnapshot() }
	try {
		port.postMessage(env)
	} catch {
		// Port closed mid-send. `onDisconnect` will reap it; nothing
		// actionable here.
	}
}

function broadcast(): void {
	if (ports.size === 0) return
	const env: BackgroundToPopup = { kind: 'snapshot', snapshot: buildSnapshot() }
	for (const p of ports) {
		try {
			p.postMessage(env)
		} catch {
			// Port closed mid-send; `onDisconnect` will reap it.
		}
	}
}
