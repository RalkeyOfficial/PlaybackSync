import type {
	Adapter,
	AdapterContext,
	AdapterFactory,
	AuthoritativeCommand,
	ContentIdentity,
	LocalIntent,
} from './types'
import { templateAdapterFactory } from './_template'

/**
 * Static registry of bundled adapters. Adding a new site = appending its
 * factory here. First match wins (workshop §9 "first adapter whose
 * canHandlePage returns true is activated").
 */
const ADAPTERS: AdapterFactory[] = [
	templateAdapterFactory,
]

/**
 * Outbound bridge supplied by the content entrypoint. The runtime is
 * chrome-API-agnostic so it can be tested in isolation; the entrypoint
 * forwards these to `chrome.runtime.sendMessage`.
 */
export interface RuntimeBridge {
	sendIntent(adapterId: string, intent: LocalIntent): void
	sendIdentity(adapterId: string, identity: ContentIdentity): void
	sendFail(adapterId: string, reason: string): void
}

type RuntimeState =
	| { kind: 'idle' }
	| { kind: 'active'; adapter: Adapter; commandHandler: ((cmd: AuthoritativeCommand) => void) | null }
	| { kind: 'failed'; adapterId: string; reason: string }

let state: RuntimeState = { kind: 'idle' }
let bridge: RuntimeBridge | null = null
let started = false

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
 */
export function deliverCommand(cmd: AuthoritativeCommand): void {
	if (state.kind !== 'active') return
	state.commandHandler?.(cmd)
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
