import type {
	AuthoritativeCommand,
	ContentIdentity,
	PageAdapterFactory,
	PageContext,
	PageRole,
} from './types'
import type { VideoRefWithMeta } from '../background/protocol'
import { miruroAdapterFactory } from './miruro'
import { templatePageAdapterFactory } from './_template'

/**
 * Hard cap on how long the runtime waits for `adapter.scrapeCatalog()`
 * before giving up and reporting `null` to the background. The background
 * has its own 3 s JOIN-deferral cap; this leaves headroom for the IPC
 * round-trip and an adapter that's just slow rather than broken.
 */
const SCRAPE_CATALOG_TIMEOUT_MS = 2000

/**
 * Static registry of bundled **page-role** adapters (the top-frame half of a
 * site). Adding a new site = appending its factory here. First match wins
 * (workshop §9 "first adapter whose canHandlePage returns true is activated").
 * The `<video>`-owning media adapters live in a separate registry — see
 * `src/adapters/media/registry.ts`.
 */
const ADAPTERS: PageAdapterFactory[] = [
	miruroAdapterFactory,
	templatePageAdapterFactory,
]

/**
 * Outbound bridge supplied by the page content entrypoint. The runtime is
 * chrome-API-agnostic so it can be tested in isolation; the entrypoint
 * forwards these to `browser.runtime.sendMessage`. There is no `sendIntent` /
 * `sendStatus` here — those come from the `<video>`, which lives in the media
 * frame (see the media runtime's bridge).
 */
export interface RuntimeBridge {
	/**
	 * Forward the page's content identity (once per adapter activation).
	 * `guardNavigation` echoes the active adapter's opt-in flag so the
	 * background knows whether to arm its navigation-guard for this tab.
	 */
	sendIdentity(adapterId: string, identity: ContentIdentity, guardNavigation: boolean): void
	/** Forward an adapter's fatal failure so the background can clear tab state. */
	sendFail(adapterId: string, reason: string): void
	/**
	 * Forward the result of {@link PageRole.scrapeCatalog} (or `null` if the
	 * adapter omits the method, the scrape times out, or it throws). Called
	 * once per adapter lifetime, after activation.
	 */
	sendCatalog(adapterId: string, catalog: VideoRefWithMeta[] | null): void
	/**
	 * Forward a user-initiated cursor trigger emitted by the adapter when
	 * the user clicks an in-page navigation control (e.g. an episode
	 * button). The background decides per current room mode whether to
	 * issue a `CURSOR_CHANGE_REQUEST` or pull the tab back to the cursor —
	 * the runtime stays mode-unaware.
	 */
	sendCursorTrigger(adapterId: string, target: VideoRefWithMeta): void
}

type RuntimeState =
	| { kind: 'idle' }
	| { kind: 'active'; adapter: PageRole; commandHandler: ((cmd: AuthoritativeCommand) => void) | null }
	| { kind: 'failed'; adapterId: string; reason: string }

let state: RuntimeState = { kind: 'idle' }
let bridge: RuntimeBridge | null = null
let started = false

/**
 * Boot the page runtime. Idempotent within a content-script lifetime; the
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
 * `browser.runtime.onMessage`) to the active page adapter. No-op if no adapter
 * is active or the adapter hasn't registered a handler yet.
 *
 * Only `cursor_change` is actionable in the page frame; `play`/`pause`/`seek`/
 * `nudge_rate` are the media frame's job and are handled there. The background
 * targets each command at the right frame, but a broadcast fallback can still
 * land a playback command here — the page adapter's handler no-ops those, so
 * forwarding everything is harmless and keeps this path trivial.
 */
export function deliverCommand(cmd: AuthoritativeCommand): void {
	if (state.kind !== 'active') return
	state.commandHandler?.(cmd)
}

async function evaluate(): Promise<void> {
	const url = new URL(location.href)
	let adapter: PageRole | null = null
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
	const ctx = buildContext(adapter.id, adapter.guardNavigation ?? false)
	try {
		await adapter.init(ctx)
		if ((state as RuntimeState).kind === 'failed') {
			// fail() was called synchronously during init — keep that state.
			return
		}
		state = { kind: 'active', adapter, commandHandler: pendingHandler }
		pendingHandler = null
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

function buildContext(adapterId: string, guardNavigation: boolean): PageContext {
	pendingHandler = null
	return {
		emitCursorTrigger(target) {
			bridge?.sendCursorTrigger(adapterId, target)
		},
		onCommand(handler) {
			pendingHandler = handler
			if (state.kind === 'active' && state.adapter.id === adapterId) {
				state.commandHandler = handler
			}
		},
		setIdentity(identity) {
			bridge?.sendIdentity(adapterId, identity, guardNavigation)
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
	if (state.kind === 'active') {
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
function runCatalogScrape(adapter: PageRole): void {
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
