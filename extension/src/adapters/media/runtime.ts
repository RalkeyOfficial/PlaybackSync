import type { AuthoritativeCommand, LocalIntent, MediaContext, MediaRole, VideoState } from '../types'
import { selectMediaAdapter } from './registry'

/**
 * How often the runtime samples `adapter.getState()` and pushes a `status`
 * message to the background. The wire-format `HEARTBEAT` cadence is 5 s
 * (`docs/ws-protocol.md` §HEARTBEAT); polling at 1 s keeps the background's
 * cache fresh enough for that, and for `BUFFER_*` transition detection,
 * without flooding the channel.
 */
const STATUS_POLL_MS = 1000

/**
 * Magnitude of the rate clamp for a `nudge_rate` command. The daemon's
 * nudge-rate band is 200–500 ms of drift (`docs/ws-protocol.md`
 * §SYNC_ADJUST); 5 % closes most of that within a few seconds while
 * staying inaudible. Anything larger starts to sound like fast-forward.
 */
const NUDGE_RATE_OFFSET = 0.05

/**
 * Hard cap on how long the rate stays clamped. Bounds the worst case so a
 * stale `currentPos` reading can't leave playback nudged indefinitely; if
 * drift persists, the daemon resends `SYNC_ADJUST` and a fresh nudge
 * re-arms.
 */
const NUDGE_MAX_DURATION_MS = 3000

/**
 * Dead band around `targetPos`. Drift smaller than this is treated as
 * already converged — clamping at ±5 % for ≤50 ms would be measurable
 * jitter for no real correction.
 */
const NUDGE_DEAD_BAND_S = 0.05

/**
 * Outbound bridge supplied by the media content entrypoint. The runtime is
 * chrome-API-agnostic so it can be tested in isolation; the entrypoint
 * forwards these to `browser.runtime.sendMessage`.
 */
export interface MediaBridge {
	/** Forward an observed user action (play/pause/seek) to the background. */
	sendIntent(adapterId: string, intent: LocalIntent): void
	/**
	 * Forward a periodic state snapshot. The runtime drives the cadence
	 * via {@link STATUS_POLL_MS}; the background caches the latest value
	 * for its `HEARTBEAT` and `BUFFER_*` wire-frame emission.
	 */
	sendStatus(adapterId: string, state: VideoState): void
	/**
	 * Announce this frame owns a controllable `<video>` (once per activation).
	 * Lets the background learn the media `frameId` immediately — so it can
	 * target playback commands here — and push the room's cached playback down
	 * if a room is already in progress (video-appears-after-JOIN, iframe reload).
	 */
	sendMediaHello(adapterId: string): void
	/**
	 * Announce this frame owns a controllable `<video>`, sent the instant it's
	 * resolved (before cold-start prep) so the background learns the owning frame
	 * id early — before a phantom sibling's videoless fail could arrive.
	 */
	sendMediaOwner(adapterId: string): void
	/** Forward a soft failure (no controllable video in this frame). */
	sendFail(adapterId: string, reason: string): void
}

type RuntimeState =
	| { kind: 'idle' }
	| { kind: 'active'; adapter: MediaRole; commandHandler: ((cmd: AuthoritativeCommand) => void) | null }
	| { kind: 'failed'; adapterId: string; reason: string }

let state: RuntimeState = { kind: 'idle' }
let bridge: MediaBridge | null = null
let started = false
let statusInterval: ReturnType<typeof setInterval> | null = null

/**
 * Whether the tab is in a room. The core guard: no media adapter is evaluated
 * (no `<video>` resolution, no cold-start play-button press) until the
 * background confirms room membership via {@link setRoomActive}.
 */
let roomActive = false

/**
 * In-flight nudge restore timer. Set whenever the runtime applies a
 * `nudge_rate` command; cleared and reset to `1.0` when the timer fires,
 * a subsequent `nudge_rate` arrives, a competing command (play / pause /
 * seek) lands mid-window, or the adapter tears down.
 */
let nudgeTimer: ReturnType<typeof setTimeout> | null = null

/**
 * Boot the media runtime. Idempotent within a content-script lifetime; the
 * entrypoint should call this exactly once. Unlike the page runtime it wires
 * no navigation listeners — an embed frame's URL only changes by a full frame
 * reload, which re-injects the content script fresh.
 */
export function start(b: MediaBridge): void {
	if (started) {
		console.warn('[playbacksync:media] runtime.start called twice; ignoring')
		return
	}
	started = true
	bridge = b
}

/**
 * Set room membership. Activating evaluates the media adapter; deactivating
 * tears it down (destroy the adapter, stop polling, cancel any nudge).
 * Idempotent — repeated same-value calls are ignored.
 *
 * @param active Whether the tab is now in a room.
 */
export function setRoomActive(active: boolean): void {
	if (active === roomActive) return
	roomActive = active
	if (active) void evaluate()
	else teardown()
}

/**
 * Tear the active media adapter down: stop status polling, cancel any in-flight
 * nudge, and destroy the adapter (which aborts its lifetime signal, unwinding a
 * mid-flight `ensurePlayable`). Safe to call from any state.
 */
function teardown(): void {
	stopStatusPolling()
	if (state.kind === 'active') {
		cancelNudge(state.adapter)
		try {
			state.adapter.destroy()
		} catch (err) {
			log('error', state.adapter.id, 'destroy threw', {
				reason: err instanceof Error ? err.message : String(err),
			})
		}
	}
	state = { kind: 'idle' }
	pendingHandler = null
}

/**
 * Forward a server command (received by the entrypoint via
 * `browser.runtime.onMessage`) to the active media adapter. No-op if no
 * adapter is active or the adapter hasn't registered a handler yet.
 *
 * `nudge_rate` is handled here rather than forwarded — the runtime owns
 * the rate math and the restore timer. Competing authoritative commands
 * (`play` / `pause` / `seek`) cancel any in-flight nudge before they land;
 * otherwise a hard seek would commit at a clamped rate. `cursor_change` is
 * the page frame's job; the no-op arm keeps a stray broadcast harmless.
 */
export function deliverCommand(cmd: AuthoritativeCommand): void {
	if (state.kind !== 'active') return
	if (cmd.type === 'nudge_rate') {
		applyNudgeRate(state.adapter, cmd.targetPos)
		return
	}
	if (cmd.type === 'play' || cmd.type === 'pause' || cmd.type === 'seek') {
		cancelNudge(state.adapter)
	}
	state.commandHandler?.(cmd)
}

/**
 * Apply a `nudge_rate` command: cancel any in-flight nudge, read the
 * adapter's current position, derive the rate clamp and restore duration,
 * write through `adapter.setPlaybackRate`, and schedule the restore.
 *
 * Bails (after cancelling the prior nudge) when `getState()` returns
 * `null` or when the drift is already inside the dead band — either case
 * means there's nothing useful to nudge.
 */
function applyNudgeRate(adapter: MediaRole, targetPos: number): void {
	cancelNudge(adapter)

	const snapshot = adapter.getState()
	if (!snapshot) {
		log('warn', adapter.id, 'nudge_rate dropped: getState() returned null')
		return
	}

	const delta = targetPos - snapshot.currentPos
	if (Math.abs(delta) < NUDGE_DEAD_BAND_S) return

	const rate = 1 + (delta > 0 ? NUDGE_RATE_OFFSET : -NUDGE_RATE_OFFSET)
	const durationMs = Math.min(
		(Math.abs(delta) / NUDGE_RATE_OFFSET) * 1000,
		NUDGE_MAX_DURATION_MS,
	)

	try {
		adapter.setPlaybackRate(rate)
	} catch (err) {
		log('error', adapter.id, 'setPlaybackRate(nudge) threw', {
			reason: err instanceof Error ? err.message : String(err),
		})
		return
	}

	nudgeTimer = setTimeout(() => {
		nudgeTimer = null
		try {
			adapter.setPlaybackRate(1)
		} catch (err) {
			log('error', adapter.id, 'setPlaybackRate(restore) threw', {
				reason: err instanceof Error ? err.message : String(err),
			})
		}
	}, durationMs)
}

/**
 * Tear down an in-flight nudge: clear the timer and restore the adapter's
 * playback rate to baseline. Safe to call when no nudge is active.
 * Swallows `setPlaybackRate` exceptions because we never want a teardown
 * path to throw.
 */
function cancelNudge(adapter: MediaRole): void {
	if (nudgeTimer === null) return
	clearTimeout(nudgeTimer)
	nudgeTimer = null
	try {
		adapter.setPlaybackRate(1)
	} catch (err) {
		log('error', adapter.id, 'setPlaybackRate(cancel) threw', {
			reason: err instanceof Error ? err.message : String(err),
		})
	}
}

async function evaluate(): Promise<void> {
	// Gate: never activate outside a room.
	if (!roomActive) return
	const url = new URL(location.href)
	const adapter = selectMediaAdapter(url)
	if (!adapter) {
		log('info', 'media', 'no media adapter matched', { href: location.href })
		state = { kind: 'idle' }
		return
	}
	const ctx = buildContext(adapter.id)
	try {
		await adapter.init(ctx)
		if (!roomActive) {
			// Left the room mid-init — discard rather than going active.
			try { adapter.destroy() } catch { /* teardown must never throw */ }
			state = { kind: 'idle' }
			return
		}
		if ((state as RuntimeState).kind === 'failed') {
			// fail() was called synchronously during init — keep that state.
			return
		}
		state = { kind: 'active', adapter, commandHandler: pendingHandler }
		pendingHandler = null
		startStatusPolling(adapter)
		bridge?.sendMediaHello(adapter.id)
		log('info', adapter.id, 'media adapter activated')
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err)
		log('error', adapter.id, 'media adapter init threw', { reason })
		state = { kind: 'failed', adapterId: adapter.id, reason }
		bridge?.sendFail(adapter.id, reason)
	}
}

let pendingHandler: ((cmd: AuthoritativeCommand) => void) | null = null

function buildContext(adapterId: string): MediaContext {
	pendingHandler = null
	return {
		emitIntent(intent) {
			bridge?.sendIntent(adapterId, intent)
		},
		claimVideo() {
			bridge?.sendMediaOwner(adapterId)
		},
		onCommand(handler) {
			pendingHandler = handler
			if (state.kind === 'active' && state.adapter.id === adapterId) {
				state.commandHandler = handler
			}
		},
		fail(reason) {
			// No controllable `<video>` in this frame. The frame can't know
			// whether it's the tab's only player or a phantom sibling, so it
			// reports loudly and lets the background decide severity (fatal
			// teardown vs. ignore a non-owner frame). Losing the video element
			// is an extension-side failure, so log at error.
			log('error', adapterId, 'media adapter failed: no controllable video', { reason })
			state = { kind: 'failed', adapterId, reason }
			bridge?.sendFail(adapterId, reason)
		},
		log(level, msg, data) {
			log(level, adapterId, msg, data)
		},
	}
}

function startStatusPolling(adapter: MediaRole): void {
	stopStatusPolling()
	statusInterval = setInterval(() => {
		const snapshot = adapter.getState()
		if (!snapshot) return
		bridge?.sendStatus(adapter.id, snapshot)
	}, STATUS_POLL_MS)
}

function stopStatusPolling(): void {
	if (statusInterval !== null) {
		clearInterval(statusInterval)
		statusInterval = null
	}
}

function log(
	level: 'info' | 'warn' | 'error',
	scope: string,
	msg: string,
	data?: Record<string, unknown>,
): void {
	const line = `[playbacksync:media:${scope}] ${msg}`
	const payload = data ?? {}
	if (level === 'error') console.error(line, payload)
	else if (level === 'warn') console.warn(line, payload)
	else console.log(line, payload)
}
