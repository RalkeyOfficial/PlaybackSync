/**
 * Per-tab toolbar-icon state. The manifest's `default_icon` is the
 * greyscale variant, so any tab we never touch is automatically
 * "inactive". This module owns the exception: each tab whose WS room
 * is currently `joined` gets the color variant via
 * `chrome.action.setIcon({ tabId, … })`. Multiple tabs can be colored
 * simultaneously — one per syncing tab.
 */

const COLOR_PATHS = {
	16: 'icon/16.png',
	32: 'icon/32.png',
	48: 'icon/48.png',
	96: 'icon/96.png',
	128: 'icon/128.png',
} as const

const GREY_PATHS = {
	16: 'icon/16-grey.png',
	32: 'icon/32-grey.png',
	48: 'icon/48-grey.png',
	96: 'icon/96-grey.png',
	128: 'icon/128-grey.png',
} as const

/** Tabs whose icon is currently color. */
const coloredTabs = new Set<number>()

/**
 * Install the runtime default of greyscale. The manifest's `default_icon`
 * stays color so listings (Chrome Web Store, `chrome://extensions`) show
 * the brand; this call overrides the toolbar at runtime so every tab
 * starts grey until {@link setColored} paints one of them color.
 *
 * Called on every service-worker boot — MV3 workers idle out, and the
 * per-tab color override from a previous worker generation can survive
 * on tabs we no longer track. We re-grey every open tab to flush those
 * stale overrides so the next {@link setColored} transition starts from
 * a clean slate.
 */
export async function initGreyscaleDefaults(): Promise<void> {
	void chrome.action.setIcon({ path: GREY_PATHS }).catch(() => {})
	try {
		const tabs = await chrome.tabs.query({})
		for (const t of tabs) {
			if (t.id !== undefined) paintTab(t.id, GREY_PATHS)
		}
	} catch {
		// `tabs` permission missing or query failed — the global default
		// above still takes effect for tabs without per-tab overrides.
	}
}

/**
 * Paint a single tab's icon. `on=true` switches it to the color
 * variant and remembers the tab; `on=false` reverts it to greyscale
 * and forgets it. Idempotent — calling twice in the same direction
 * is a cheap no-op.
 *
 * @param tabId The tabId whose icon to paint.
 * @param on `true` for color, `false` for greyscale.
 */
export function setColored(tabId: number, on: boolean): void {
	const wasColored = coloredTabs.has(tabId)
	if (on === wasColored) return
	if (on) {
		coloredTabs.add(tabId)
		paintTab(tabId, COLOR_PATHS)
	} else {
		coloredTabs.delete(tabId)
		paintTab(tabId, GREY_PATHS)
	}
}

/**
 * Drop a tabId from internal tracking — call from
 * `chrome.tabs.onRemoved`. Doesn't issue any `setIcon` call (the tab
 * is gone), but keeps the colored-tabs set tidy.
 *
 * @param tabId The tabId that just went away.
 */
export function forgetIconForTab(tabId: number): void {
	coloredTabs.delete(tabId)
}

function paintTab(tabId: number, path: Record<number, string>): void {
	// A tab can disappear between the decision to paint and this call;
	// swallow the resulting "No tab with id" error.
	void chrome.action.setIcon({ tabId, path }).catch(() => {})
}
