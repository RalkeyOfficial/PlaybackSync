import type {
	Adapter,
	AdapterContext,
	AdapterFactory,
	AuthoritativeCommand,
	ContentIdentity,
	LocalIntent,
	VideoState,
} from './types'
import type { VideoRefWithMeta } from '../background/protocol'
import { miruroAdapterFactory } from './miruro'
import { templateAdapterFactory } from './_template'

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
 * Hard cap on how long the runtime waits for `adapter.scrapeCatalog()`
 * before giving up and reporting `null` to the background. The background
 * has its own 3 s JOIN-deferral cap; this leaves headroom for the IPC
 * round-trip and an adapter that's just slow rather than broken.
 */
const SCRAPE_CATALOG_TIMEOUT_MS = 2000

/**
 * Static registry of bundled adapters. Adding a new site = appending its
 * factory here. First match wins (workshop §9 "first adapter whose
 * canHandlePage returns true is activated").
 */
const ADAPTERS: AdapterFactory[] = [
	miruroAdapterFactory,
	templateAdapterFactory,
]

/**
 * Outbound bridge supplied by the content entrypoint. The runtime is
 * chrome-API-agnostic so it can be tested in isolation; the entrypoint
 * forwards these to `chrome.runtime.sendMessage`.
 */
export interface RuntimeBridge {
	/** Forward an observed user action (play/pause/seek) to the background. */
	sendIntent(adapterId: string, intent: LocalIntent): void
	/** Forward the page's content identity (once per adapter lifetime). */
	sendIdentity(adapterId: string, identity: ContentIdentity): void
	/**
	 * Forward a periodic state snapshot. The runtime drives the cadence
	 * via {@link STATUS_POLL_MS}; the background caches the latest value
	 * for its `HEARTBEAT` and `BUFFER_*` wire-frame emission.
	 */
	sendStatus(adapterId: string, state: VideoState): void
	/** Forward an adapter's fatal failure so the background can clear tab state. */
	sendFail(adapterId: string, reason: string): void
	/**
	 * Forward the result of {@link Adapter.scrapeCatalog} (or `null` if the
	 * adapter omits the method, the scrape times out, or it throws). Called
	 * once per adapter lifetime, after activation.
	 */
	sendCatalog(adapterId: string, catalog: VideoRefWithMeta[] | null): void
}

type RuntimeState =
	| { kind: 'idle' }
	| { kind: 'active'; adapter: Adapter; commandHandler: ((cmd: AuthoritativeCommand) => void) | null }
	| { kind: 'failed'; adapterId: string; reason: string }

let state: RuntimeState = { kind: 'idle' }
let bridge: RuntimeBridge | null = null
let started = false
let statusInterval: ReturnType<typeof setInterval> | null = null

/**
 * In-flight nudge restore timer. Set whenever the runtime applies a
 * `nudge_rate` command; cleared and reset to `1.0` when the timer fires,
 * a subsequent `nudge_rate` arrives, a competing command (play / pause /
 * seek) lands mid-window, or the adapter tears down.
 *
 * Kept at module scope alongside `statusInterval` because both share the
 * same lifecycle: per-content-script (i.e. per-tab) singletons that the
 * runtime owns from `start()` to `teardown()`.
 */
let nudgeTimer: ReturnType<typeof setTimeout> | null = null

/**
 * Boot the runtime. Idempotent within a content-script lifetime; the
 * entrypoint should call this exactly once.
 */
export async function start(b: RuntimeBridge): Promise<void> {
	if (started) {
		console.warn('[playbacksync] runtime.start called twice; ignoring')
		return
	}
	started = true
	bridge = b
	installNavigationListeners()
	await evaluate()
}

/**
 * Forward a server command (received by the entrypoint via
 * `chrome.runtime.onMessage`) to the active adapter. No-op if no adapter is
 * active or the adapter hasn't registered a handler yet.
 *
 * `nudge_rate` is handled here rather than forwarded — the runtime owns
 * the rate math and the restore timer so the algorithm lives in one
 * place. Competing authoritative commands (`play` / `pause` / `seek`)
 * cancel any in-flight nudge before they land; otherwise a hard seek
 * would commit at a clamped rate.
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
function applyNudgeRate(adapter: Adapter, targetPos: number): void {
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
function cancelNudge(adapter: Adapter): void {
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
	const url = new URL(location.href)
	let adapter: Adapter | null = null
	for (const factory of ADAPTERS) {
		const candidate = factory()
		if (candidate.canHandlePage(url)) {
			adapter = candidate
			break
		}
	}
	if (!adapter) {
		log('info', 'runtime', 'no adapter matched', { href: location.href })
		state = { kind: 'idle' }
		return
	}
	const ctx = buildContext(adapter.id)
	try {
		await adapter.init(ctx)
		if ((state as RuntimeState).kind === 'failed') {
			// fail() was called synchronously during init — keep that state.
			return
		}
		state = { kind: 'active', adapter, commandHandler: pendingHandler }
		pendingHandler = null
		startStatusPolling(adapter)
		runCatalogScrape(adapter)
		log('info', adapter.id, 'adapter activated')
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err)
		log('error', adapter.id, 'adapter init threw', { reason })
		state = { kind: 'failed', adapterId: adapter.id, reason }
		bridge?.sendFail(adapter.id, reason)
	}
}

let pendingHandler: ((cmd: AuthoritativeCommand) => void) | null = null

function buildContext(adapterId: string): AdapterContext {
	pendingHandler = null
	return {
		emitIntent(intent) {
			bridge?.sendIntent(adapterId, intent)
		},
		onCommand(handler) {
			pendingHandler = handler
			if (state.kind === 'active' && state.adapter.id === adapterId) {
				state.commandHandler = handler
			}
		},
		setIdentity(identity) {
			bridge?.sendIdentity(adapterId, identity)
		},
		fail(reason) {
			log('error', adapterId, 'adapter failed', { reason })
			state = { kind: 'failed', adapterId, reason }
			bridge?.sendFail(adapterId, reason)
		},
		log(level, msg, data) {
			log(level, adapterId, msg, data)
		},
	}
}

function teardown(): void {
	stopStatusPolling()
	if (state.kind === 'active') {
		cancelNudge(state.adapter)
		try {
			state.adapter.destroy()
			log('info', state.adapter.id, 'adapter torn down')
		} catch (err) {
			log('error', state.adapter.id, 'destroy threw', {
				reason: err instanceof Error ? err.message : String(err),
			})
		}
	}
	state = { kind: 'idle' }
	pendingHandler = null
}

function startStatusPolling(adapter: Adapter): void {
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

/**
 * Fire-and-forget a single `scrapeCatalog` call against the active adapter
 * and forward the result to the background. Bounded by
 * {@link SCRAPE_CATALOG_TIMEOUT_MS}; never throws. The background needs
 * exactly one report per adapter activation — either an array or `null` —
 * to release its pending-JOIN gate, so adapters without a `scrapeCatalog`
 * method get an immediate `null`.
 *
 * @param adapter The adapter that just transitioned to `active`.
 */
function runCatalogScrape(adapter: Adapter): void {
	if (!adapter.scrapeCatalog) {
		bridge?.sendCatalog(adapter.id, null)
		return
	}
	const scrape = Promise.resolve()
		.then(() => adapter.scrapeCatalog!())
		.catch((err) => {
			log('warn', adapter.id, 'scrapeCatalog threw', {
				reason: err instanceof Error ? err.message : String(err),
			})
			return null
		})
	const timeout = new Promise<null>((resolve) =>
		setTimeout(() => resolve(null), SCRAPE_CATALOG_TIMEOUT_MS),
	)
	void Promise.race([scrape, timeout]).then((result) => {
		// Adapter may have torn down or been replaced while the scrape ran
		// — discard a stale result rather than reporting it against the
		// wrong adapter id.
		if (state.kind !== 'active' || state.adapter !== adapter) return
		bridge?.sendCatalog(adapter.id, result ?? null)
	})
}

/**
 * Catch every URL change a page can produce: back/forward (`popstate`) plus
 * SPA pushes (`history.pushState` / `replaceState`, which fire no native
 * event). The monkey-patch dispatches a synthetic `pbsync:locationchange`.
 */
function installNavigationListeners(): void {
	let lastHref = location.href
	const onChange = () => {
		if (location.href === lastHref) return
		lastHref = location.href
		teardown()
		void evaluate()
	}

	window.addEventListener('popstate', onChange)
	window.addEventListener('pbsync:locationchange', onChange)

	const fire = () => window.dispatchEvent(new Event('pbsync:locationchange'))
	const origPush = history.pushState.bind(history)
	const origReplace = history.replaceState.bind(history)
	history.pushState = function (...args) {
		origPush(...args)
		fire()
	}
	history.replaceState = function (...args) {
		origReplace(...args)
		fire()
	}
}

function log(
	level: 'info' | 'warn' | 'error',
	scope: string,
	msg: string,
	data?: Record<string, unknown>,
): void {
	const line = `[playbacksync:${scope}] ${msg}`
	const payload = data ?? {}
	if (level === 'error') console.error(line, payload)
	else if (level === 'warn') console.warn(line, payload)
	else console.log(line, payload)
}
