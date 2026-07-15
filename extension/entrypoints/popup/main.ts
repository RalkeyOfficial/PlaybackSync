/**
 * Toolbar popup entrypoint. Opens a long-lived
 * `chrome.runtime.Port` named `'pbsync-popup'` to the background, posts
 * a `subscribe` envelope naming the tab the popup is interested in
 * (the active tab in the current window when the popup opened), then
 * re-renders the UI on every `snapshot` push the background sends back
 * for that tab.
 *
 * Communication is one-shot in the other direction too: outbound
 * messages are the initial `subscribe` and `{ kind: 'leave_room' }`
 * from the Leave Room button (both tagged with the popup's bound
 * tabId). The leave button optimistically transitions to a disabled
 * "leaving…" state; the broadcast snapshot that arrives ms later
 * replaces the view with the real `no_credentials` state.
 *
 * The popup runs in its own page context — it does not import from
 * `src/background/` directly. Everything it knows about the room
 * arrives through the typed snapshot envelope in `src/messages.ts`.
 */

import type { Runtime } from 'wxt/browser'
import type {
	BackgroundToPopup,
	PopupSnapshot,
	PopupStatus,
	PopupToBackground,
} from '@/src/messages'

const POPUP_PORT_NAME = 'pbsync-popup'

const bodyEl = document.getElementById('body') as HTMLDivElement
const pillEl = document.getElementById('status-pill') as HTMLSpanElement
const pillLabelEl = document.getElementById('status-label') as HTMLSpanElement

let port: Runtime.Port | null = null
let boundTabId: number | null = null
let lastSnapshot: PopupSnapshot | null = null
let leaving = false

void connect()

async function connect(): Promise<void> {
	const tabs = await browser.tabs.query({ active: true, currentWindow: true })
	const tabId = tabs[0]?.id
	if (tabId === undefined) {
		renderPortLost()
		return
	}
	boundTabId = tabId
	port = browser.runtime.connect({ name: POPUP_PORT_NAME })
	port.onMessage.addListener((msg: unknown) => {
		const env = msg as BackgroundToPopup
		if (env.kind !== 'snapshot') return
		leaving = false
		lastSnapshot = env.snapshot
		render(env.snapshot)
	})
	port.onDisconnect.addListener(() => {
		// Background torn down (worker idle-out is rare while we're open
		// because Chrome keeps the worker alive while a Port is open).
		// If it does happen, render a clear error rather than going stale.
		port = null
		renderPortLost()
	})
	const subscribe: PopupToBackground = { kind: 'subscribe', tabId }
	port.postMessage(subscribe)
}

function render(s: PopupSnapshot): void {
	updatePill(s.status)
	bodyEl.replaceChildren(buildBody(s))
}

function renderPortLost(): void {
	updatePill('disconnected')
	const p = document.createElement('p')
	p.className = 'body__copy'
	p.textContent = 'Connection to the extension worker was lost. Close and reopen this popup to retry.'
	bodyEl.replaceChildren(p)
}

function updatePill(status: PopupStatus): void {
	pillEl.classList.remove(
		'pill--no-creds',
		'pill--connecting',
		'pill--joined',
		'pill--disconnected',
	)
	pillEl.classList.add(`pill--${pillClassSuffix(status)}`)
	pillLabelEl.textContent = pillText(status)
}

function pillClassSuffix(status: PopupStatus): string {
	switch (status) {
		case 'no_credentials': return 'no-creds'
		case 'connecting': return 'connecting'
		case 'joined': return 'joined'
		case 'disconnected': return 'disconnected'
	}
}

function pillText(status: PopupStatus): string {
	switch (status) {
		case 'no_credentials': return 'No room'
		case 'connecting': return 'Connecting'
		case 'joined': return 'Joined'
		case 'disconnected': return 'Offline'
	}
}

function buildBody(s: PopupSnapshot): DocumentFragment {
	const frag = document.createDocumentFragment()
	switch (s.status) {
		case 'no_credentials':
			frag.appendChild(makeCopy(
				'Not in a room. Open a share link from a PlaybackSync room owner to join — the extension picks up credentials automatically when you land on the share page.',
			))
			break
		case 'connecting':
			frag.appendChild(makeCopy(
				`Connecting to ${formatHost(s.syncUrl)}…`,
			))
			break
		case 'joined':
			frag.appendChild(buildIdentityRow(s))
			frag.appendChild(buildCursorBlock(s))
			frag.appendChild(buildLeaveButton())
			break
		case 'disconnected':
			if (s.nickname) frag.appendChild(buildIdentity(s.nickname))
			frag.appendChild(makeCopy(
				'Disconnected from the room. Reconnecting automatically; use Leave room to discard the credentials.',
			))
			frag.appendChild(buildLeaveButton())
			break
	}
	return frag
}

/**
 * Top row of the joined view: the your-identity chip on the left and the mode
 * chip pushed to the right, sharing one line to keep the popup compact.
 *
 * @param s The current snapshot (reads `nickname` and `mode`).
 */
function buildIdentityRow(s: PopupSnapshot): HTMLElement {
	const row = document.createElement('div')
	row.className = 'identity-row'
	if (s.nickname) row.appendChild(buildIdentity(s.nickname))
	if (s.mode) row.appendChild(buildChips(s.mode))
	return row
}

/**
 * Your-identity chip: a dot + "YOU" label + the room nickname. Shown whenever
 * the nickname is known so you can always see who you are in the room.
 *
 * @param nickname The viewer's own server-assigned nickname.
 */
function buildIdentity(nickname: string): HTMLElement {
	const box = document.createElement('div')
	box.className = 'identity'

	const dot = document.createElement('span')
	dot.className = 'identity__dot'

	const label = document.createElement('span')
	label.className = 'identity__label'
	label.textContent = 'You'

	const name = document.createElement('span')
	name.className = 'identity__name'
	name.textContent = nickname

	box.append(dot, label, name)
	return box
}

function buildCursorBlock(s: PopupSnapshot): HTMLElement {
	const box = document.createElement('div')
	box.className = 'cursor'

	const primary = document.createElement('div')
	primary.className = 'cursor__primary'
	if (!s.cursor) {
		primary.classList.add('cursor__primary--empty')
		primary.textContent = 'Nothing playing yet.'
	} else {
		const provider = document.createElement('span')
		provider.className = 'cursor__provider'
		provider.textContent = `${s.cursor.providerId} · `
		const label = document.createTextNode(s.cursor.label ?? s.cursor.videoId)
		primary.appendChild(provider)
		primary.appendChild(label)
	}
	box.appendChild(primary)

	if (s.cursor) {
		const link = document.createElement('a')
		link.className = 'cursor__url'
		link.href = s.cursor.pageUrl
		link.textContent = s.cursor.pageUrl
		link.target = '_blank'
		link.rel = 'noopener noreferrer'
		box.appendChild(link)
	}

	return box
}

function buildChips(mode: 'default' | 'single' | 'freeform'): HTMLElement {
	const wrap = document.createElement('div')
	wrap.className = 'chips'
	const chip = document.createElement('span')
	chip.className = 'chip'
	chip.textContent = `Mode: ${mode}`
	wrap.appendChild(chip)
	return wrap
}

function buildLeaveButton(): HTMLButtonElement {
	const btn = document.createElement('button')
	btn.type = 'button'
	btn.className = 'btn btn--danger'
	btn.textContent = leaving ? 'Leaving…' : 'Leave room'
	btn.disabled = leaving || port === null
	btn.addEventListener('click', onLeaveClicked)
	return btn
}

function onLeaveClicked(): void {
	if (!port || leaving || boundTabId === null) return
	leaving = true
	const env: PopupToBackground = { kind: 'leave_room', tabId: boundTabId }
	port.postMessage(env)
	if (lastSnapshot) render(lastSnapshot)
}

function makeCopy(text: string): HTMLParagraphElement {
	const p = document.createElement('p')
	p.className = 'body__copy'
	p.textContent = text
	return p
}

function formatHost(syncUrl: string | null): string {
	if (!syncUrl) return 'the room daemon'
	try {
		return new URL(syncUrl).host
	} catch {
		return 'the room daemon'
	}
}
