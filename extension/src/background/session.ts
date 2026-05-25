/**
 * Pure state container for the background WS client. No I/O lives here:
 * the WS module drives connection, the entrypoint drives messaging, and
 * this module just holds the mutable state they share — connection id,
 * event-id watermark, mode/cursor/playlist, server clock offset, and the
 * per-tab suppression windows that keep feedback loops out of the wire.
 *
 * Splitting state from I/O makes the loop testable in principle, and in
 * practice keeps the WS module narrow and obvious.
 */

import type { AuthoritativeCommand, LocalIntent } from '@/src/adapters/types'
import type {
	CursorRef,
	CursorChangeFrame,
	PlaylistEntry,
	PlaylistUpdateInFrame,
	RoomStateFrame,
	StateFrame,
	SyncAdjustFrame,
} from './protocol'

/**
 * How long after a server-driven command we keep dropping local intents
 * of the matching type, to prevent the round-trip
 * "command → adapter applies → native event fires → adapter emits intent"
 * from echoing back as a duplicate wire `EVENT`. 600 ms covers a noisy
 * native-event tail comfortably without eating real user actions.
 */
export const SUPPRESSION_WINDOW_MS = 600

/**
 * Drop *all* intents from a tab for this long after it first converges on a
 * connection. The 600 ms echo window is too narrow for the page's own
 * resume / auto-play logic: e.g. Vidstack on miruro restores the user's
 * last viewing position via a delayed `seeking` write that lands hundreds
 * of ms — sometimes a second or two — after the adapter has paused the
 * player. Without this gate, that delayed write reaches the daemon as a
 * real EVENT and overwrites the room's authoritative state. The window
 * arms exactly once per tab per connection (on first convergence), so
 * mid-session state updates don't keep re-locking the user out.
 */
export const JOIN_SETTLE_WINDOW_MS = 5000

/** Recorded outbound command timing; used by {@link shouldSuppress}. */
interface RecentCommand {
	kind: LocalIntent['type'] | 'cursor_change'
	at: number
}

/**
 * Snapshot of room-shared state derived from server frames. Held as a
 * mutable record; folders ({@link applyRoomState}, etc.) overwrite the
 * fields they own.
 */
export interface SessionState {
	/** Server-assigned client id; persists across reconnects. */
	clientId: string | null
	/** Highest `eventId` we've seen; sent on JOIN for tombstone replay. */
	lastEventId: number
	/** Current cursor entry; `null` for an empty playlist. */
	cursor: CursorRef | null
	/** Hash from `ROOM_STATE` / `PLAYLIST_UPDATE`; lets us skip redundant work. */
	playlistVersion: string | null
	/** Full latest playlist; cached for popup / future UI. */
	playlist: PlaylistEntry[]
	/** Room mode; affects which client-initiated mutations are accepted. */
	mode: 'default' | 'single' | 'freeform'
	/** Server clock - local clock offset, in ms; running median of CLOCK_PONG samples. */
	serverClockOffsetMs: number
	/** Recent command stamps per tab, used by {@link shouldSuppress}. */
	recentCommandsByTab: Map<number, RecentCommand[]>
	/** Rolling RTT samples (ms); used for telemetry only at this stage. */
	rttSamplesMs: number[]
	/**
	 * Tabs that have received at least one authoritative command since this
	 * connection opened. Used by the entrypoint to gate outbound intents:
	 * native video-element events fired during adapter init (e.g. the site's
	 * own resume-position logic) must not become wire `EVENT`s before the
	 * room's authoritative state has converged the local player.
	 */
	convergedTabs: Set<number>
	/**
	 * Latest convergence commands whose dispatch was deferred because no tab
	 * had reported status yet. Overwritten by newer frames so the freshest
	 * target wins; flushed when a tab first reports status.
	 */
	pendingConvergence: AuthoritativeCommand[] | null
	/**
	 * Wall-clock ms (Date.now()) until which intents from a tab are dropped
	 * as "join settle". See {@link JOIN_SETTLE_WINDOW_MS}.
	 */
	settleUntilByTab: Map<number, number>
}

/** Build a fresh session with everything cleared. */
export function createSession(): SessionState {
	return {
		clientId: null,
		lastEventId: 0,
		cursor: null,
		playlistVersion: null,
		playlist: [],
		mode: 'default',
		serverClockOffsetMs: 0,
		recentCommandsByTab: new Map(),
		rttSamplesMs: [],
		convergedTabs: new Set(),
		pendingConvergence: null,
		settleUntilByTab: new Map(),
	}
}

/**
 * Stamp a tab as having received its first authoritative command on the
 * current connection. Clears any deferred convergence target — that target
 * has just been (or is being) dispatched to this tab.
 *
 * @param s The session to update.
 * @param tabId Tab that just received an authoritative command.
 */
export function markConverged(s: SessionState, tabId: number): void {
	const wasConverged = s.convergedTabs.has(tabId)
	s.convergedTabs.add(tabId)
	s.pendingConvergence = null
	// Arm the settle window only on the *first* convergence per connection;
	// subsequent STATE-driven re-dispatches must not keep re-locking the user
	// out of their own intents.
	if (!wasConverged) {
		s.settleUntilByTab.set(tabId, Date.now() + JOIN_SETTLE_WINDOW_MS)
	}
}

/**
 * Whether intents from a tab should be dropped as "join settle". Cleans up
 * its own map entry once the window has elapsed.
 */
export function inSettleWindow(s: SessionState, tabId: number): boolean {
	const until = s.settleUntilByTab.get(tabId)
	if (until === undefined) return false
	if (Date.now() < until) return true
	s.settleUntilByTab.delete(tabId)
	return false
}

/**
 * Whether a tab has been converged on the current connection. The
 * entrypoint uses this to drop pre-convergence intents — native events
 * the adapter emits before the local player has been told the room's
 * authoritative state are not real user actions.
 */
export function hasConverged(s: SessionState, tabId: number): boolean {
	return s.convergedTabs.has(tabId)
}

/**
 * Reset the convergence gate. Called when the WS (re)connects so that any
 * tab still cached from the previous connection has to be re-converged by
 * the fresh `ROOM_STATE` before its intents are allowed to flow again.
 */
export function resetConvergence(s: SessionState): void {
	s.convergedTabs.clear()
	s.pendingConvergence = null
	s.settleUntilByTab.clear()
}

// ─── Server-frame folders ─────────────────────────────────────────────

/**
 * Fold a `ROOM_STATE` frame into the session and return the commands
 * the active tab should apply to converge.
 *
 * @param s The session to update in place.
 * @param frame The decoded server frame.
 * @returns The list of commands to dispatch to the active tab.
 */
export function applyRoomState(s: SessionState, frame: RoomStateFrame): AuthoritativeCommand[] {
	s.clientId = frame.clientId
	s.lastEventId = frame.lastEventId
	s.cursor = frame.cursor
	s.playlistVersion = frame.playlistVersion
	s.mode = frame.singleMode ? 'single' : frame.freeformMode ? 'freeform' : 'default'

	const cmds: AuthoritativeCommand[] = []
	// Apply the room's authoritative playback state to the active tab.
	if (frame.playerState === 'paused') {
		cmds.push({ type: 'pause' })
	} else if (frame.playerState === 'playing') {
		cmds.push({ type: 'play' })
	}
	cmds.push({ type: 'seek', time: frame.videoPos })
	return cmds
}

/**
 * Fold a `STATE` frame (broadcast after every EVENT) into the session.
 * Returns the commands needed to converge to the broadcast state. Even
 * the original sender receives this (daemon's broadcast-including-self
 * pattern) — feedback-loop suppression in {@link shouldSuppress} keeps
 * the resulting native events from echoing back.
 */
export function applyState(s: SessionState, frame: StateFrame): AuthoritativeCommand[] {
	s.lastEventId = Math.max(s.lastEventId, frame.eventId)
	if (frame.playerState === 'paused') return [{ type: 'pause' }, { type: 'seek', time: frame.videoPos }]
	if (frame.playerState === 'playing') return [{ type: 'play' }, { type: 'seek', time: frame.videoPos }]
	// 'buffering' is a transient state we don't drive client-side.
	return []
}

/**
 * Fold a `CURSOR_CHANGE` frame and return the navigate command. Receiver
 * pauses + seeks to 0 per protocol; we encode that as the
 * adapter-friendly `cursor_change` command (adapter currently no-ops on
 * it — navigation lands in a follow-up spec).
 */
export function applyCursorChange(s: SessionState, frame: CursorChangeFrame): AuthoritativeCommand[] {
	s.cursor = frame.cursor
	s.lastEventId = Math.max(s.lastEventId, frame.eventId)
	return [{ type: 'cursor_change', pageUrl: frame.cursor.pageUrl }]
}

/** Fold a `PLAYLIST_UPDATE` server frame. No commands result. */
export function applyPlaylistUpdate(s: SessionState, frame: PlaylistUpdateInFrame): AuthoritativeCommand[] {
	s.playlist = frame.entries
	s.playlistVersion = frame.playlistVersion
	return []
}

/**
 * Fold a `SYNC_ADJUST` frame into the converging command. `mode: 'seek'`
 * jumps directly to `targetPos`; `mode: 'nudge-rate'` hands the runtime a
 * `nudge_rate` command that clamps `<video>.playbackRate` for a short
 * window so playback converges without an audible jump. The rate math
 * and restore timer live in [`runtime.ts`](../adapters/runtime.ts); this
 * fold just selects the strategy.
 */
export function applySyncAdjust(_s: SessionState, frame: SyncAdjustFrame): AuthoritativeCommand[] {
	if (frame.mode === 'seek') {
		return [{ type: 'seek', time: frame.targetPos }]
	}
	return [{ type: 'nudge_rate', targetPos: frame.targetPos }]
}

// ─── Suppression windows ──────────────────────────────────────────────

/**
 * Stamp the time at which a command was dispatched to a tab. Called by
 * the entrypoint right before `chrome.tabs.sendMessage`. Any matching
 * intent that arrives within {@link SUPPRESSION_WINDOW_MS} is dropped.
 *
 * @param s The session.
 * @param tabId The browser tab id the command targets.
 * @param cmd The command being dispatched.
 */
export function recordCommand(s: SessionState, tabId: number, cmd: AuthoritativeCommand): void {
	const kind = mapCommandKind(cmd.type)
	if (!kind) return
	const bucket = s.recentCommandsByTab.get(tabId) ?? []
	bucket.push({ kind, at: Date.now() })
	// Trim aged-out entries to keep the bucket small.
	const cutoff = Date.now() - SUPPRESSION_WINDOW_MS
	const fresh = bucket.filter(b => b.at >= cutoff)
	s.recentCommandsByTab.set(tabId, fresh)
}

/**
 * Should we drop this intent because we just sent a matching command?
 *
 * @returns `true` to drop the intent (feedback-loop echo), `false` to
 *          forward it as a wire `EVENT`.
 */
export function shouldSuppress(s: SessionState, tabId: number, intent: LocalIntent): boolean {
	const bucket = s.recentCommandsByTab.get(tabId)
	if (!bucket || bucket.length === 0) return false
	const cutoff = Date.now() - SUPPRESSION_WINDOW_MS
	return bucket.some(b => b.at >= cutoff && b.kind === intent.type)
}

function mapCommandKind(t: AuthoritativeCommand['type']): RecentCommand['kind'] | null {
	switch (t) {
		case 'play':
		case 'pause':
		case 'seek':
			return t
		case 'nudge_rate':
			// Setting `<video>.playbackRate` fires `ratechange`, which no
			// adapter listens to — there's no intent to echo back, so no
			// suppression slot to arm.
			return null
		case 'cursor_change':
			// Navigation triggers an unload; nothing to suppress on the
			// outgoing side.
			return null
	}
}

// ─── Clock sync ───────────────────────────────────────────────────────

/**
 * Build a `CLOCK_PING` outbound payload. The caller embeds this in the
 * envelope and ships it; the resulting `CLOCK_PONG` is handed back to
 * {@link applyClockPong}.
 *
 * @returns The `clientSendTime` (ms) to embed in the ping frame. Use the
 *          same value when matching the eventual pong.
 */
export function startClockPing(): number {
	return performance.timeOrigin + performance.now()
}

/**
 * Fold a `CLOCK_PONG` into the session's clock-offset estimate. Uses the
 * NTP-style math from `docs/ws-protocol.md`: with t1=ping send,
 * t2=server recv, t3=server send, t4=local pong recv, the offset is
 * `((t2 - t1) + (t3 - t4)) / 2` and the RTT is `(t4 - t1) - (t3 - t2)`.
 *
 * The session keeps a sliding median of recent samples; an outlier
 * pong won't yank the estimate.
 *
 * @param s The session to update.
 * @param t1 The `clientSendTime` echoed back by the server.
 * @param t2 `serverRecvTime` from the pong.
 * @param t3 `serverSendTime` from the pong.
 * @param t4 Local receive time (ms since epoch).
 */
export function applyClockPong(s: SessionState, t1: number, t2: number, t3: number, t4: number): void {
	const offset = ((t2 - t1) + (t3 - t4)) / 2
	const rtt = (t4 - t1) - (t3 - t2)

	s.rttSamplesMs.push(rtt)
	if (s.rttSamplesMs.length > 8) s.rttSamplesMs.shift()

	// Running median of offsets is overkill at sample count ≤ 8; use a
	// simple moving average instead. The protocol's 3-5-pings-on-connect
	// pattern means we converge fast anyway.
	const alpha = s.clientId === null ? 1 : 0.4
	s.serverClockOffsetMs = s.clientId === null
		? offset
		: s.serverClockOffsetMs * (1 - alpha) + offset * alpha
}

/**
 * Convert a server timestamp (`serverTs`) into local-clock ms by
 * subtracting the running offset. Used when computing how far in the
 * past a `SYNC_ADJUST.serverTime` was.
 */
export function serverToLocalMs(s: SessionState, serverMs: number): number {
	return serverMs - s.serverClockOffsetMs
}
