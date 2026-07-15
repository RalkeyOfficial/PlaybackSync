/**
 * On-page notification UI for the content script — the extension's first and
 * only injected page UI. Renders two distinct surfaces, both isolated from the
 * host page's CSS inside a single WXT shadow-root:
 *
 * - **Peer toasts** — small cards stacked in the bottom-right corner that
 *   auto-dismiss, announcing what other viewers did ("SwiftFox42 paused").
 * - **Welcome badge** — a larger, centered, animated badge shown once when
 *   *you* join a room ("You joined the room for <title> as <nickname>").
 *
 * Everything is vanilla DOM + a scoped stylesheet (no framework), mirroring the
 * toolbar popup's token + `prefers-color-scheme` approach. The shadow root is
 * mounted lazily on the first notice and torn down with the content-script
 * context. Notices are display-only: dropping one costs nothing but the toast.
 */

import { createShadowRootUi, type ContentScriptContext } from 'wxt/client'
import type { Notice } from '@/src/messages'

/** Max simultaneously-visible peer toasts before the oldest is evicted. */
const MAX_TOASTS = 4
/** How long a peer toast lingers before auto-dismissing (ms). */
const TOAST_MS = 5_000
/** How long the self-facing welcome badge lingers (ms) — longer than a toast. */
const WELCOME_MS = 4_500
/** Fallback removal delay if a CSS `transitionend` never fires (ms). */
const TRANSITION_FALLBACK_MS = 500

let ctxRef: ContentScriptContext | null = null
let stackEl: HTMLElement | null = null
let badgeLayerEl: HTMLElement | null = null
/** Guards the async mount so concurrent notices don't create two shadow roots. */
let mounting: Promise<void> | null = null
/** Notices that arrived before the shadow root finished mounting. */
const pending: Notice[] = []
/** All live timers, cleared on context invalidation so none fire post-teardown. */
const timers = new Set<ReturnType<typeof setTimeout>>()
/** Coalescing map: `${event}:${actorId}` → the toast currently representing it. */
const activeByKey = new Map<string, HTMLElement>()
/** Per-toast dismiss timer, so a coalesced update can reset it. */
const toastTimers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>()

/**
 * Register the content-script context. Does not mount anything — the shadow
 * root is created on the first {@link showNotice}. Wires teardown so a dev
 * reload / SPA context swap clears timers and drops element references.
 *
 * @param ctx The content script context from `defineContentScript`'s `main`.
 */
export function initNotifications(ctx: ContentScriptContext): void {
	ctxRef = ctx
	ctx.onInvalidated(() => {
		for (const t of timers) clearTimeout(t)
		timers.clear()
		activeByKey.clear()
		stackEl = null
		badgeLayerEl = null
		ctxRef = null
	})
}

/**
 * Render a notice as an on-page toast (or the welcome badge for
 * `event: 'welcome'`). Mounts the shadow root lazily and queues notices that
 * arrive mid-mount. No-op if the context was never registered or has been
 * invalidated.
 *
 * @param notice The notice to display.
 */
export function showNotice(notice: Notice): void {
	if (!ctxRef) return
	if (stackEl && badgeLayerEl) {
		render(notice)
		return
	}
	pending.push(notice)
	void ensureMounted()
}

async function ensureMounted(): Promise<void> {
	if (mounting) return mounting
	const ctx = ctxRef
	if (!ctx) return
	mounting = (async () => {
		const ui = await createShadowRootUi(ctx, {
			name: 'pbsync-notifications',
			position: 'inline',
			anchor: 'body',
			css: STYLE,
			onMount: (container) => {
				const stack = document.createElement('div')
				stack.className = 'stack'
				const badgeLayer = document.createElement('div')
				badgeLayer.className = 'badge-layer'
				container.append(stack, badgeLayer)
				stackEl = stack
				badgeLayerEl = badgeLayer
			},
		})
		// The context may have been invalidated while awaiting; bail without
		// mounting so we don't attach an orphaned root.
		if (!ctxRef) return
		ui.mount()
		for (const n of pending.splice(0)) render(n)
	})()
	return mounting
}

function render(notice: Notice): void {
	if (notice.event === 'welcome') {
		showWelcome(notice)
		return
	}
	showToast(notice)
}

function showToast(notice: Notice): void {
	if (!stackEl) return
	const text = formatNotice(notice)
	if (text === null) return

	// Coalesce a burst of seeks from the same actor into one toast rather than
	// stacking a new card per drag-frame.
	const key = notice.event === 'seek' && notice.actorId ? `seek:${notice.actorId}` : null
	if (key !== null) {
		const existing = activeByKey.get(key)
		if (existing && existing.isConnected) {
			existing.textContent = text
			resetToastTimer(existing)
			return
		}
	}

	const toast = document.createElement('div')
	toast.className = 'toast'
	toast.textContent = text
	stackEl.appendChild(toast)
	if (key !== null) activeByKey.set(key, toast)

	// Evict oldest beyond the cap.
	while (stackEl.children.length > MAX_TOASTS && stackEl.firstElementChild) {
		removeToast(stackEl.firstElementChild as HTMLElement)
	}

	requestAnimationFrame(() => toast.classList.add('toast--in'))
	resetToastTimer(toast)
}

function resetToastTimer(toast: HTMLElement): void {
	const prev = toastTimers.get(toast)
	if (prev !== undefined) {
		clearTimeout(prev)
		timers.delete(prev)
	}
	const timer = setTimeout(() => dismissToast(toast), TOAST_MS)
	timers.add(timer)
	toastTimers.set(toast, timer)
}

function dismissToast(toast: HTMLElement): void {
	const timer = toastTimers.get(toast)
	if (timer !== undefined) {
		clearTimeout(timer)
		timers.delete(timer)
		toastTimers.delete(toast)
	}
	toast.classList.remove('toast--in')
	toast.classList.add('toast--out')
	whenGone(toast, () => removeToast(toast))
}

function removeToast(toast: HTMLElement): void {
	toast.remove()
	for (const [k, el] of activeByKey) {
		if (el === toast) activeByKey.delete(k)
	}
}

function showWelcome(notice: Notice): void {
	if (!badgeLayerEl) return
	const nickname = (notice.actorId ?? '').trim()

	const badge = document.createElement('div')
	badge.className = 'badge'

	const mark = document.createElement('span')
	mark.className = 'badge__mark'
	mark.textContent = '▶'

	const body = document.createElement('div')
	body.className = 'badge__body'
	const label = document.createElement('span')
	label.className = 'badge__label'
	const name = document.createElement('span')
	name.className = 'badge__name'
	// The nickname is the focal content. If it's missing (e.g. an older daemon
	// that doesn't send ROOM_STATE.nickname), degrade to a generic line rather
	// than showing an empty name row. Text nodes only — never innerHTML.
	if (nickname) {
		label.textContent = 'You joined as'
		name.textContent = nickname
	} else {
		label.textContent = 'You joined'
		name.textContent = 'the watch party'
	}
	body.append(label, name)
	badge.append(mark, body)

	// Only one welcome at a time — replace any in-flight badge.
	badgeLayerEl.replaceChildren(badge)
	requestAnimationFrame(() => badge.classList.add('badge--in'))

	const timer = setTimeout(() => {
		badge.classList.remove('badge--in')
		badge.classList.add('badge--out')
		whenGone(badge, () => badge.remove())
	}, WELCOME_MS)
	timers.add(timer)
}

/**
 * Run `done` once the element's dismiss transition ends, with a timer fallback
 * for the case where no `transitionend` fires (e.g. reduced-motion, display
 * change). Idempotent — `done` runs at most once.
 */
function whenGone(el: HTMLElement, done: () => void): void {
	let ran = false
	const run = (): void => {
		if (ran) return
		ran = true
		done()
	}
	el.addEventListener('transitionend', run, { once: true })
	const fb = setTimeout(run, TRANSITION_FALLBACK_MS)
	timers.add(fb)
}

/** Actor display name: "Host" for owner, the leaver's nickname for system, else the actor nickname. */
function displayName(n: Notice): string {
	if (n.actor === 'system') return n.data?.nickname ?? 'Someone'
	if (n.actor === 'owner') return 'Host'
	return n.actorId ?? 'Someone'
}

/** Map a notice to its toast copy, or null for events with no toast text. */
function formatNotice(n: Notice): string | null {
	const name = displayName(n)
	switch (n.event) {
		case 'play':
			return `${name} played`
		case 'pause':
			return `${name} paused`
		case 'seek':
			return `${name} skipped to ${mmss(n.data?.value)}`
		case 'cursor_change':
			return `${name} changed the video to ${n.data?.videoRef?.label ?? 'a new video'}`
		case 'client_joined':
			return `${name} joined`
		case 'client_left':
			return `${name} left`
		default:
			return null
	}
}

/** Format seconds as `m:ss`, or `h:mm:ss` past an hour. Returns `?` for bad input. */
function mmss(seconds: number | undefined): string {
	if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return '?'
	const total = Math.floor(seconds)
	const s = total % 60
	const m = Math.floor(total / 60) % 60
	const h = Math.floor(total / 3600)
	const pad = (n: number): string => String(n).padStart(2, '0')
	return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

/**
 * Scoped stylesheet for the shadow root. `all: initial` on `:host` walls off
 * the host page's inherited styles; tokens + a `prefers-color-scheme` override
 * mirror the toolbar popup. Everything is `position: fixed` so it floats over
 * the player regardless of where the host element lands in the DOM, and the
 * layers use `pointer-events: none` (toasts re-enable it) so they never eat
 * clicks meant for the page.
 */
const STYLE = `
:host { all: initial; }
:host {
	--pbs-bg: #ffffff;
	--pbs-fg: #1d1d1d;
	--pbs-fg-muted: #5a5a5a;
	--pbs-border: #e3e3e3;
	/* Brand primary (design/v1 --brand-blue) — used for the welcome badge border. */
	--pbs-brand: #2563eb;
	--pbs-font: system-ui, -apple-system, "Segoe UI", sans-serif;
}
@media (prefers-color-scheme: dark) {
	:host {
		--pbs-bg: #1f1f1f;
		--pbs-fg: #ededed;
		--pbs-fg-muted: #a0a0a0;
		--pbs-border: #3a3a3a;
		--pbs-accent: #4d8bff;
	}
}
.stack {
	position: fixed;
	right: 16px;
	bottom: 16px;
	display: flex;
	flex-direction: column;
	gap: 8px;
	max-width: min(340px, calc(100vw - 32px));
	z-index: 2147483647;
	pointer-events: none;
	font-family: var(--pbs-font);
}
.toast {
	pointer-events: auto;
	padding: 10px 14px;
	border-radius: 10px;
	background: var(--pbs-bg);
	color: var(--pbs-fg);
	border: 1px solid var(--pbs-border);
	box-shadow: 0 4px 16px rgba(0, 0, 0, 0.18);
	font-size: 13px;
	line-height: 1.35;
	overflow-wrap: anywhere;
	opacity: 0;
	transform: translateY(8px);
	transition: opacity 0.18s ease, transform 0.18s ease;
}
.toast--in { opacity: 1; transform: translateY(0); }
.toast--out { opacity: 0; transform: translateY(8px); }
.badge-layer {
	position: fixed;
	top: 25%;
	left: 50%;
	transform: translateX(-50%);
	z-index: 2147483647;
	pointer-events: none;
	font-family: var(--pbs-font);
}
.badge {
	display: flex;
	align-items: center;
	gap: 14px;
	box-sizing: border-box;
	/* Fixed 4:1 pill (280 × 70) — always dark, independent of page theme.
	   border-radius ≥ half the height gives fully-round (stadium) ends. */
	width: 280px;
	height: 70px;
	max-width: calc(100vw - 32px);
	padding: 0 28px;
	border-radius: 999px;
	background: #0b1220;
	border: 3px solid var(--pbs-brand);
	box-shadow: 0 10px 34px rgba(0, 0, 0, 0.55);
	color: #f8fafc;
	font-family: "Geist", var(--pbs-font);
	opacity: 0;
	transform: scale(0.92) translateY(-6px);
	transition: opacity 0.28s ease, transform 0.28s cubic-bezier(0.2, 0.8, 0.2, 1);
}
.badge--in { opacity: 1; transform: scale(1) translateY(0); }
.badge--out { opacity: 0; transform: scale(0.96) translateY(-4px); }
.badge__mark {
	flex: 0 0 auto;
	font-size: 20px;
	line-height: 1;
	color: var(--pbs-brand);
}
.badge__body {
	display: flex;
	flex-direction: column;
	gap: 2px;
	min-width: 0;
}
.badge__label {
	font-size: 10px;
	font-weight: 600;
	letter-spacing: 0.14em;
	text-transform: uppercase;
	color: #94a3b8;
}
.badge__name {
	font-size: 20px;
	font-weight: 700;
	line-height: 1.1;
	color: #f8fafc;
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
}
`
