/**
 * Pure state container for one WebSocket runtime — i.e. one tab. No I/O
 * lives here: the WS module drives connection, the entrypoint drives
 * messaging, and this module just holds the mutable state they share —
 * connection id, event-id watermark, mode/cursor/playlist, server clock
 * offset, and the suppression / settle windows that keep feedback loops
 * out of the wire.
 *
 * One {@link SessionState} belongs to one tab. The earlier per-tab maps
 * (`recentCommandsByTab`, `convergedTabs`, `settleUntilByTab`) collapsed
 * to scalars when the WS runtime was pooled by `tabId` — see
 * `agent-os/specs/2026-05-25-1530-extension-multi-tab-arbitration/`.
 *
 * Splitting state from I/O makes the loop testable in principle, and in
 * practice keeps the WS module narrow and obvious.
 */

import type { AuthoritativeCommand, LocalIntent } from '@/src/adapters/types'
import type {
	CursorRef,
	CursorChangeFrame,
	PlayerState,
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
 * Max distance (seconds) between a dispatched seek command's target and a
 * subsequent seek intent for that intent to count as the command's echo.
 * Arrow-key skips jump ~5 s, so ~1 s comfortably separates a real skip from
 * the round-trip echo (which lands at the command's target) while absorbing
 * any player-side rounding.
 */
export const SEEK_ECHO_TOLERANCE_S = 1

/**
 * Drop *all* intents from this tab for this long after it first converges
 * on a connection. The 600 ms echo window is too narrow for the page's
 * own resume / auto-play logic: e.g. Vidstack on miruro restores the
 * user's last viewing position via a delayed `seeking` write that lands
 * hundreds of ms — sometimes a second or two — after the adapter has
 * paused the player. Without this gate, that delayed write reaches the
 * daemon as a real EVENT and overwrites the room's authoritative state.
 * The window arms exactly once per connection (on first convergence), so
 * mid-session state updates don't keep re-locking the user out.
 */
export const JOIN_SETTLE_WINDOW_MS = 1_000

/** Recorded outbound command timing; used by {@link shouldSuppress}. */
interface RecentCommand {
	kind: LocalIntent['type']
	at: number
	/**
	 * Seek target (seconds) for `kind === 'seek'`; `undefined` for play/pause.
	 * Lets {@link shouldSuppress} drop only the echo that lands at this target,
	 * not a genuine user skip to a different position.
	 */
	time?: number
}

/**
 * Snapshot of the room's last authoritative playback, cached so a tab can
 * be resynced without a fresh server frame. See
 * {@link SessionState.lastRoomPlayback} and {@link buildResyncCommands}.
 */
export interface RoomPlayback {
	/** Playhead position (seconds) the room reported at {@link serverTs}. */
	videoPos: number
	/** Room playback state at {@link serverTs}. */
	playerState: PlayerState
	/** Server-clock timestamp (ms) of the frame this snapshot came from. */
	serverTs: number
}

/**
 * Snapshot of room-shared state derived from server frames. Held as a
 * mutable record; folders ({@link applyRoomState}, etc.) overwrite the
 * fields they own. One instance per tab — the WS runtime pool keys
 * sessions by `tabId`.
 */
export interface SessionState {
	/** Server-assigned client id; persists across reconnects. */
	clientId: string | null
	/** Server-assigned nickname (e.g. `SwiftFox42`); `null` before the first `ROOM_STATE`. Surfaced in the popup. */
	nickname: string | null
	/** Highest `eventId` we've seen; sent on JOIN for tombstone replay. */
	lastEventId: number
	/** Current cursor entry; `null` for an empty playlist. */
	cursor: CursorRef | null
	/**
	 * videoId of a cursor change the nav-guard has forwarded and is awaiting the
	 * server's `CURSOR_CHANGE` broadcast for; `null` when none is in flight.
	 * `session.cursor` only advances on that broadcast, so during a round-trip
	 * it lags behind where the user actually is. The nav-guard's loop-stop uses
	 * this as the *effective* cursor (see {@link effectiveCursorVideoId}) so a
	 * rapid change back to a different episode isn't mistaken for the stale
	 * cursor and dropped.
	 */
	pendingCursorTarget: string | null
	/** Hash from `ROOM_STATE` / `PLAYLIST_UPDATE`; lets us skip redundant work. */
	playlistVersion: string | null
	/** Full latest playlist; cached for popup / future UI. */
	playlist: PlaylistEntry[]
	/** Room mode; affects which client-initiated mutations are accepted. */
	mode: 'default' | 'single' | 'freeform'
	/** Server clock - local clock offset, in ms; running median of CLOCK_PONG samples. */
	serverClockOffsetMs: number
	/** Recent command stamps, used by {@link shouldSuppress}. */
	recentCommands: RecentCommand[]
	/** Rolling RTT samples (ms); used for telemetry only at this stage. */
	rttSamplesMs: number[]
	/**
	 * Latest `playerState` reported by the adapter on this tab; `null`
	 * before the first `status` arrives. The entrypoint compares this
	 * against incoming `status` frames to detect buffer transitions and
	 * emit `BUFFER_START` / `BUFFER_END`.
	 */
	lastPlayerState: 'playing' | 'paused' | 'buffering' | null
	/**
	 * Whether the tab has received at least one authoritative command since
	 * this connection opened. Used by the entrypoint to gate outbound
	 * intents: native video-element events fired during adapter init (e.g.
	 * the site's own resume-position logic) must not become wire `EVENT`s
	 * before the room's authoritative state has converged the local player.
	 */
	converged: boolean
	/**
	 * Latch: whether this tab has converged *at least once* on the current
	 * connection. Unlike {@link converged} (which a cursor forward deliberately
	 * resets to re-arm playback-echo suppression), this stays `true` for the
	 * life of the connection once set, and is cleared only on (re)connect. The
	 * nav-guard uses it to distinguish the initial join-steering window (never
	 * converged → the server steers, don't forward) from a mid-session cursor
	 * round-trip (converged before → a genuine move must still be forwarded even
	 * while transiently un-converged/settling).
	 */
	everConverged: boolean
	/**
	 * Wall-clock ms (Date.now()) until which intents from this tab are
	 * dropped as "join settle", or `null` once the window has elapsed or
	 * never armed. See {@link JOIN_SETTLE_WINDOW_MS}.
	 */
	settleUntil: number | null
	/**
	 * Whether this tab is mid-reload from a navigation-guard pull-back. The
	 * guard hard-navigates the tab back to the cursor without closing the
	 * WS, so the surviving session must be re-converged manually: pull-back
	 * sets this (after {@link resetConvergence}) and the reloaded page's
	 * cursor `identity` clears it and re-`markConverged`s. While set,
	 * {@link markConverged} is suppressed so a server frame landing during
	 * the reload can't converge the tab early and let the reloaded player's
	 * autoplay / resume-position events leak.
	 */
	awaitingReload: boolean
	/**
	 * The room's last authoritative playback snapshot (from `ROOM_STATE` /
	 * `STATE`, position-refreshed by `SYNC_ADJUST`), or `null` before the
	 * first such frame. A guard reload keeps the socket open, so the daemon
	 * sends no fresh `ROOM_STATE`; this cache lets the reloaded tab resync
	 * immediately from the cursor `identity` rather than waiting for the
	 * next periodic frame. See {@link buildResyncCommands}.
	 */
	lastRoomPlayback: RoomPlayback | null
}

/** Build a fresh session with everything cleared. */
export function createSession(): SessionState {
	return {
		clientId: null,
		nickname: null,
		lastEventId: 0,
		cursor: null,
		pendingCursorTarget: null,
		playlistVersion: null,
		playlist: [],
		mode: 'default',
		serverClockOffsetMs: 0,
		recentCommands: [],
		rttSamplesMs: [],
		lastPlayerState: null,
		converged: false,
		everConverged: false,
		settleUntil: null,
		awaitingReload: false,
		lastRoomPlayback: null,
	}
}

/**
 * Stamp the tab as having received its first authoritative command on the
 * current connection. Arms the settle window on the *first* convergence
 * only; subsequent STATE-driven re-dispatches must not keep re-locking
 * the user out of their own intents. Suppressed entirely while
 * {@link SessionState.awaitingReload} is set, so a server frame arriving
 * mid-reload can't converge the tab before the reloaded page is ready.
 *
 * @param s The session to update.
 */
export function markConverged(s: SessionState): void {
	if (s.converged || s.awaitingReload) return
	s.converged = true
	s.everConverged = true
	s.settleUntil = Date.now() + JOIN_SETTLE_WINDOW_MS
}

/**
 * Whether intents from this tab should be dropped as "join settle".
 * Clears the field once the window has elapsed.
 */
export function inSettleWindow(s: SessionState): boolean {
	if (s.settleUntil === null) return false
	if (Date.now() < s.settleUntil) return true
	s.settleUntil = null
	return false
}

/**
 * Whether the tab has been converged on the current connection. The
 * entrypoint uses this to drop pre-convergence intents — native events
 * the adapter emits before the local player has been told the room's
 * authoritative state are not real user actions.
 */
export function hasConverged(s: SessionState): boolean {
	return s.converged
}

/**
 * Whether the tab has converged at least once on the current connection.
 * The nav-guard uses this to tell the initial join-steering window apart from
 * a mid-session cursor round-trip. See {@link SessionState.everConverged}.
 */
export function hasEverConverged(s: SessionState): boolean {
	return s.everConverged
}

/**
 * Reset the *transient* convergence gate. Called mid-session (cursor forward,
 * inbound `CURSOR_CHANGE`) to re-arm playback-echo suppression. Leaves the
 * {@link SessionState.everConverged} latch and {@link SessionState.pendingCursorTarget}
 * intact — the latter because the inbound `CURSOR_CHANGE` handler calls this
 * *before* `applyCursorChange` does its match-clear.
 */
export function resetConvergence(s: SessionState): void {
	s.converged = false
	s.settleUntil = null
}

/**
 * Reset *all* per-connection convergence state. Called on WS (re)connect: the
 * tab must be re-steered from scratch by the fresh `ROOM_STATE`, and any
 * in-flight cursor change on the dead socket is void.
 */
export function resetConnectionState(s: SessionState): void {
	s.converged = false
	s.everConverged = false
	s.settleUntil = null
	s.pendingCursorTarget = null
}

/**
 * Record that the nav-guard has forwarded a cursor change and is awaiting its
 * broadcast. Overrides the stale confirmed cursor in {@link effectiveCursorVideoId}.
 *
 * @param s The session to update.
 * @param videoId The forwarded target's videoId.
 */
export function setPendingCursorTarget(s: SessionState, videoId: string): void {
	s.pendingCursorTarget = videoId
}

/**
 * Clear any in-flight forwarded cursor target. Called on reconnect and when a
 * forward's round-trip is abandoned (fallback timer).
 *
 * @param s The session to update.
 */
export function clearPendingCursorTarget(s: SessionState): void {
	s.pendingCursorTarget = null
}

/**
 * The videoId the user is effectively on for nav-guard loop-stop purposes: the
 * in-flight forwarded target if a cursor change is round-tripping, else the
 * confirmed cursor. `null` when neither is known.
 *
 * @param s The session to read.
 */
export function effectiveCursorVideoId(s: SessionState): string | null {
	return s.pendingCursorTarget ?? s.cursor?.videoId ?? null
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
	// Empty when an older daemon omits it; normalise to null so the popup can
	// treat "unknown" uniformly.
	s.nickname = frame.nickname || null
	s.lastEventId = frame.lastEventId
	s.cursor = frame.cursor
	// ROOM_STATE only arrives on (re)JOIN; any locally-forwarded cursor target
	// is stale by now, so drop it rather than let it skew the nav-guard.
	s.pendingCursorTarget = null
	s.playlistVersion = frame.playlistVersion
	s.mode = frame.singleMode ? 'single' : frame.freeformMode ? 'freeform' : 'default'
	s.lastRoomPlayback = { videoPos: frame.videoPos, playerState: frame.playerState, serverTs: frame.serverTs }

	// Seek first, then play/pause — the play/pause must be the *last* action
	// applied so it's authoritative. Some players (Vidstack on miruro)
	// resume playback as a side effect of a seek, so a trailing seek would
	// silently undo a leading `pause` and leave the tab playing against a
	// paused room. Keeping play/pause last makes "apply room state" land the
	// playerState the caller asked for.
	const cmds: AuthoritativeCommand[] = [{ type: 'seek', time: frame.videoPos }]
	if (frame.playerState === 'paused') {
		cmds.push({ type: 'pause' })
	} else if (frame.playerState === 'playing') {
		cmds.push({ type: 'play' })
	}
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
	s.lastRoomPlayback = { videoPos: frame.videoPos, playerState: frame.playerState, serverTs: frame.serverTs }
	// Seek first, then play/pause — see {@link applyRoomState}: a trailing
	// seek can resume playback (Vidstack) and undo a leading `pause`, so the
	// play/pause must land last to be authoritative.
	if (frame.playerState === 'paused') return [{ type: 'seek', time: frame.videoPos }, { type: 'pause' }]
	if (frame.playerState === 'playing') return [{ type: 'seek', time: frame.videoPos }, { type: 'play' }]
	// 'buffering' is a transient state we don't drive client-side.
	return []
}

/**
 * Fold a `CURSOR_CHANGE` frame and return the navigate command only. The
 * protocol's reset-to-paused-at-0 is deliberately *not* encoded here: the
 * server resets the room's playback on a cursor change, and that reset
 * reaches the tab through the normal convergence path — `applyRoomState`
 * on a full-reload re-JOIN, or a follow-up `STATE` frame via `applyState`
 * on the surviving-socket SPA path — both of which already emit `seek 0` +
 * `pause`. Encoding the reset here too would double it, and the commands
 * would race (or be discarded by) the navigation this command triggers.
 */
export function applyCursorChange(s: SessionState, frame: CursorChangeFrame): AuthoritativeCommand[] {
	s.cursor = frame.cursor
	// Clear the in-flight target only when this broadcast confirms *it* — a
	// broadcast for an earlier target must not clear a newer pending forward.
	if (s.pendingCursorTarget !== null && frame.cursor.videoId === s.pendingCursorTarget) {
		s.pendingCursorTarget = null
	}
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
 *
 * Also refreshes the cached {@link SessionState.lastRoomPlayback} position
 * (keeping the last-known `playerState`, which `SYNC_ADJUST` doesn't carry)
 * so a guard-reload resync seeds from the freshest position available.
 */
export function applySyncAdjust(s: SessionState, frame: SyncAdjustFrame): AuthoritativeCommand[] {
	if (s.lastRoomPlayback) {
		s.lastRoomPlayback = {
			...s.lastRoomPlayback,
			videoPos: frame.targetPos,
			serverTs: frame.serverTime,
		}
	}
	if (frame.mode === 'seek') {
		return [{ type: 'seek', time: frame.targetPos }]
	}
	return [{ type: 'nudge_rate', targetPos: frame.targetPos }]
}

/**
 * Build the commands that bring a freshly-(re)loaded video to the room's
 * last known playback state, for the navigation-guard reload path to
 * resync immediately instead of waiting for the next periodic server
 * frame. Mirrors {@link applyRoomState}'s seek-then-play/pause ordering.
 *
 * When the room is playing, the cached position is advanced by the time
 * elapsed since the snapshot (via the clock offset) so the video lands
 * roughly in sync; a following `SYNC_ADJUST` fine-tunes any residual
 * drift. Returns `[]` when no room playback has been observed yet, or when
 * the room is buffering (a transient state not driven client-side).
 *
 * @param s The session holding the cached snapshot.
 * @returns Seek + play/pause commands, or `[]` if there's nothing to apply.
 */
export function buildResyncCommands(s: SessionState): AuthoritativeCommand[] {
	const snap = s.lastRoomPlayback
	if (!snap) return []
	let pos = snap.videoPos
	if (snap.playerState === 'playing') {
		const serverNow = Date.now() + s.serverClockOffsetMs
		pos += Math.max(0, (serverNow - snap.serverTs) / 1000)
	}
	const cmds: AuthoritativeCommand[] = [{ type: 'seek', time: pos }]
	if (snap.playerState === 'paused') cmds.push({ type: 'pause' })
	else if (snap.playerState === 'playing') cmds.push({ type: 'play' })
	return cmds
}

// ─── Suppression windows ──────────────────────────────────────────────

/**
 * Stamp the time at which a command was dispatched to this tab. Called
 * by the entrypoint right before `chrome.tabs.sendMessage`. Any matching
 * intent that arrives within {@link SUPPRESSION_WINDOW_MS} is dropped.
 *
 * @param s The session.
 * @param cmd The command being dispatched.
 */
export function recordCommand(s: SessionState, cmd: AuthoritativeCommand): void {
	const kind = mapCommandKind(cmd.type)
	if (!kind) return
	const at = Date.now()
	s.recentCommands.push({ kind, at, ...(cmd.type === 'seek' ? { time: cmd.time } : {}) })
	// Trim aged-out entries to keep the bucket small.
	const cutoff = at - SUPPRESSION_WINDOW_MS
	s.recentCommands = s.recentCommands.filter(b => b.at >= cutoff)
}

/**
 * Should we drop this intent because we just sent a matching command?
 *
 * @returns `true` to drop the intent (feedback-loop echo), `false` to
 *          forward it as a wire `EVENT`.
 */
export function shouldSuppress(s: SessionState, intent: LocalIntent): boolean {
	if (s.recentCommands.length === 0) return false
	const cutoff = Date.now() - SUPPRESSION_WINDOW_MS
	return s.recentCommands.some((b) => {
		if (b.at < cutoff || b.kind !== intent.type) return false
		// A seek intent is an echo only if it lands at the command's target; a
		// genuine skip to a different position must pass through. Play/pause
		// have no position, so kind + window is the whole test.
		if (intent.type === 'seek') {
			return b.time !== undefined && Math.abs(b.time - intent.time) <= SEEK_ECHO_TOLERANCE_S
		}
		return true
	})
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
