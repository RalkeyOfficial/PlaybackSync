/**
 * Per-tab cache for the background WS client. Holds the latest
 * `VideoState` each content script reported, plus the adapter id, so the
 * heartbeat loop can pull a fresh snapshot every 5 s without doing a
 * round-trip to the content side. Also picks which tab is "the active
 * one" when multiple content scripts are reporting — for v1 that's the
 * tab whose status arrived most recently.
 *
 * Tabs are forgotten when Chromium reports `chrome.tabs.onRemoved`, so
 * the cache doesn't grow unboundedly across long-lived sessions.
 */

import type { ContentIdentity, VideoState } from '@/src/adapters/types'

/** One row in the tab cache. */
export interface TabEntry {
	adapterId: string
	latestState: VideoState | null
	identity: ContentIdentity | null
	lastStateAt: number
}

const tabs = new Map<number, TabEntry>()

/**
 * Stash the latest reported state for a tab. Called from the
 * `ContentToBackground` handler in the entrypoint.
 *
 * @param tabId The browser tab id (`sender.tab?.id`).
 * @param adapterId The adapter id reporting the state.
 * @param state The fresh status snapshot.
 */
export function recordStatus(tabId: number, adapterId: string, state: VideoState): void {
	const existing = tabs.get(tabId)
	tabs.set(tabId, {
		adapterId,
		latestState: state,
		identity: existing?.identity ?? null,
		lastStateAt: Date.now(),
	})
}

/**
 * Record a tab's content identity (one-shot, on adapter init).
 *
 * @param tabId The browser tab id.
 * @param adapterId The reporting adapter's id.
 * @param identity The triple the adapter derived.
 */
export function recordIdentity(tabId: number, adapterId: string, identity: ContentIdentity): void {
	const existing = tabs.get(tabId)
	tabs.set(tabId, {
		adapterId,
		latestState: existing?.latestState ?? null,
		identity,
		lastStateAt: existing?.lastStateAt ?? 0,
	})
}

/** Drop a tab from the cache (called from `chrome.tabs.onRemoved`). */
export function forgetTab(tabId: number): void {
	tabs.delete(tabId)
}

/**
 * Pick the tab whose status arrived most recently. The heartbeat loop
 * uses this to source `currentPos` / `playerState` for `HEARTBEAT`
 * frames.
 *
 * @returns `[tabId, entry]` for the freshest tab, or `null` if no tab
 *          has reported yet.
 */
export function pickActiveTab(): [number, TabEntry] | null {
	let bestId: number | null = null
	let best: TabEntry | null = null
	for (const [id, entry] of tabs) {
		if (entry.latestState === null) continue
		if (best === null || entry.lastStateAt > best.lastStateAt) {
			bestId = id
			best = entry
		}
	}
	return bestId === null || best === null ? null : [bestId, best]
}

/**
 * Read a tab entry without mutation. Used by the entrypoint when routing
 * commands.
 */
export function getTab(tabId: number): TabEntry | null {
	return tabs.get(tabId) ?? null
}

/**
 * Snapshot every tab id we know about. Mostly for command broadcasts
 * (e.g. ROOM_STATE → seek every active tab to the new position).
 */
export function allTabIds(): number[] {
	return Array.from(tabs.keys())
}
