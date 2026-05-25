/**
 * Per-tab cache for the background WS client. Holds the latest
 * `VideoState` each content script reported, plus the adapter id, so the
 * heartbeat loop can pull a fresh snapshot every 5 s without doing a
 * round-trip to the content side.
 *
 * With one WS runtime per tab the "pick the most recent reporter" logic
 * is gone — every runtime reads its own tab's entry directly.
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
 * Read a tab entry without mutation. Used by the heartbeat loop in
 * `ws.ts` and the command-dispatch path in the entrypoint.
 */
export function getTab(tabId: number): TabEntry | null {
	return tabs.get(tabId) ?? null
}
