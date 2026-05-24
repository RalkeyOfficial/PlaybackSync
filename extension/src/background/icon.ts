/**
 * Per-tab toolbar-icon state. The manifest's `default_icon` is the
 * greyscale variant, so any tab we never touch is automatically
 * "inactive". This module owns the single exception: the one tab that
 * is currently being synced by the WS room gets the color variant via
 * `chrome.action.setIcon({ tabId, … })`.
 *
 * Only one tab is colored at a time — it tracks `pickActiveTab()` from
 * `tabs.ts`, the freshest video-reporting tab. When the active tab
 * flips, we revert the previously-colored tab and color the new one.
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

/** Tab whose icon is currently color. `null` while no tab is being synced. */
let activeTabId: number | null = null

/**
 * Install the runtime default of greyscale. The manifest's `default_icon`
 * stays color so listings (Chrome Web Store, `chrome://extensions`) show
 * the brand; this call overrides the toolbar at runtime so every tab
 * starts grey until `setActiveTab` paints one of them color.
 *
 * Called on every service-worker boot — MV3 workers idle out, and the
 * per-tab color override from a previous worker generation can survive
 * on tabs we no longer track. We re-grey every open tab to flush those
 * stale overrides so the next `setActiveTab` transition starts from a
 * clean slate.
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
 * Make `next` the colored tab. Reverts the previously-colored tab to
 * greyscale (if any), then paints `next` color. Pass `null` to clear
 * — the previously-colored tab goes back to greyscale and nothing is
 * colored. No-op when `next === activeTabId`.
 *
 * @param next The tabId that should be colored, or `null` to clear.
 */
export function setActiveTab(next: number | null): void {
	if (next === activeTabId) return
	const prev = activeTabId
	activeTabId = next
	if (prev !== null) paintTab(prev, GREY_PATHS)
	if (next !== null) paintTab(next, COLOR_PATHS)
}

/**
 * Drop a tabId from internal tracking — call from
 * `chrome.tabs.onRemoved`. Doesn't issue any `setIcon` call (the tab
 * is gone), but prevents `setActiveTab(next)` from later trying to
 * grey-out a dead tab.
 *
 * @param tabId The tabId that just went away.
 */
export function forgetIconForTab(tabId: number): void {
	if (activeTabId === tabId) activeTabId = null
}

function paintTab(tabId: number, path: Record<number, string>): void {
	// A tab can disappear between pickActiveTab() and this call; swallow
	// the resulting "No tab with id" error.
	void chrome.action.setIcon({ tabId, path }).catch(() => {})
}
