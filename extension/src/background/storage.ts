/**
 * Thin wrapper over `chrome.storage.local` for the WebSocket client's
 * credentials. Each tab gets its own slot so multiple rooms can coexist
 * in one browser and `credentials.content.ts` writes scope to the
 * capturing tab.
 *
 * Storage schema (one key per syncing tab, key = `'pbsync.tab.<tabId>'`):
 *
 * ```jsonc
 * {
 *   "syncUrl": "wss://<host>/index.php/apps/playbacksync/ws/<uuid>",
 *   "syncPassword": "<plaintext room password>",
 *   "clientId": "<server-assigned, persisted for reconnect>"
 * }
 * ```
 *
 * Lifecycle: slots are ephemeral. `chrome.tabs.onRemoved` clears the
 * matching key, and a cold-boot sentinel in `chrome.storage.session`
 * wipes every `pbsync.tab.*` key on the first service-worker boot of a
 * browser session, so a browser restart never auto-rejoins.
 */

/** Credential record stored at `chrome.storage.local['pbsync.tab.<tabId>']`. */
export interface PbSyncCreds {
	syncUrl: string
	syncPassword: string
	/**
	 * Server-assigned client id from the first `ROOM_STATE`. Persisted so
	 * reconnects within the daemon's 30 s tombstone window can replay
	 * missed events instead of starting fresh.
	 */
	clientId?: string
}

const KEY_PREFIX = 'pbsync.tab.'
const BOOT_SENTINEL = 'pbsync.booted'

/** Build the per-tab storage key for `tabId`. */
function keyFor(tabId: number): string {
	return `${KEY_PREFIX}${tabId}`
}

/**
 * Load the credentials for a given tab. Returns `null` when no entry
 * exists or when the stored shape doesn't match.
 *
 * @param tabId Browser tab id whose slot to read.
 * @returns The stored credentials for that tab, or `null` if missing / malformed.
 */
export async function loadCreds(tabId: number): Promise<PbSyncCreds | null> {
	const k = keyFor(tabId)
	const result = await chrome.storage.local.get(k)
	const raw = result[k]
	if (!raw || typeof raw !== 'object') return null
	const obj = raw as Record<string, unknown>
	const syncUrl = obj['syncUrl']
	const syncPassword = obj['syncPassword']
	if (typeof syncUrl !== 'string' || typeof syncPassword !== 'string') return null
	const clientId = typeof obj['clientId'] === 'string' ? obj['clientId'] : undefined
	return { syncUrl, syncPassword, ...(clientId !== undefined ? { clientId } : {}) }
}

/**
 * Persist a fresh `{ syncUrl, syncPassword }` pair for the given tab.
 * Used by the share-URL pickup flow (`credentials.content.ts` →
 * background → here). Any previously stored `clientId` is dropped: a
 * stored clientId belongs to whatever room was previously joined, and
 * carrying it into a fresh JOIN against a different room would trigger
 * a stale-tombstone replay (or be rejected outright).
 *
 * @param tabId Browser tab id whose slot to write.
 * @param creds The credentials to persist.
 */
export async function saveCreds(tabId: number, creds: { syncUrl: string; syncPassword: string }): Promise<void> {
	await chrome.storage.local.set({
		[keyFor(tabId)]: { syncUrl: creds.syncUrl, syncPassword: creds.syncPassword },
	})
}

/**
 * Persist a server-assigned `clientId` alongside the existing creds for
 * the given tab, so the next reconnect can pass it back on `JOIN` and
 * get a tombstone replay. No-op when no creds are stored for that tab.
 *
 * @param tabId Browser tab id whose slot to update.
 * @param clientId The hex string the server returned in `ROOM_STATE.clientId`.
 */
export async function saveClientId(tabId: number, clientId: string): Promise<void> {
	const current = await loadCreds(tabId)
	if (!current) return
	await chrome.storage.local.set({ [keyFor(tabId)]: { ...current, clientId } })
}

/**
 * Wipe the credentials slot for a single tab. Called from the "leave
 * room" popup action, on adapter `fail`, and from
 * `chrome.tabs.onRemoved`.
 *
 * @param tabId Browser tab id whose slot to remove.
 */
export async function clearCreds(tabId: number): Promise<void> {
	await chrome.storage.local.remove(keyFor(tabId))
}

/**
 * Enumerate every persisted per-tab creds slot. Used by the service-
 * worker boot path to figure out which tabs still have a valid slot
 * after a worker wake (orphan slots whose tab no longer exists are
 * pruned by the caller).
 *
 * @returns Map of `tabId` → credentials for every well-formed slot.
 */
export async function loadAllCreds(): Promise<Map<number, PbSyncCreds>> {
	const all = await chrome.storage.local.get(null)
	const out = new Map<number, PbSyncCreds>()
	for (const [key, raw] of Object.entries(all)) {
		if (!key.startsWith(KEY_PREFIX)) continue
		const tabId = Number(key.slice(KEY_PREFIX.length))
		if (!Number.isInteger(tabId)) continue
		if (!raw || typeof raw !== 'object') continue
		const obj = raw as Record<string, unknown>
		const syncUrl = obj['syncUrl']
		const syncPassword = obj['syncPassword']
		if (typeof syncUrl !== 'string' || typeof syncPassword !== 'string') continue
		const clientId = typeof obj['clientId'] === 'string' ? obj['clientId'] : undefined
		out.set(tabId, { syncUrl, syncPassword, ...(clientId !== undefined ? { clientId } : {}) })
	}
	return out
}

/**
 * Wipe every per-tab slot if this is the first service-worker boot of a
 * fresh browser session. Uses a sentinel in `chrome.storage.session`
 * (cleared by the browser on each restart) to detect the cold-boot
 * boundary. After a wipe, no tab auto-rejoins until the user re-pastes
 * a share URL.
 *
 * MV3-only: `chrome.storage.session` is unavailable in Firefox MV2; a
 * Firefox port will need a module-scope `let booted = false` flag set
 * on first `defineBackground` invocation as the alternate signal.
 */
export async function wipeIfFreshBrowserSession(): Promise<void> {
	const sessionStore = chrome.storage.session
	if (!sessionStore) return
	const { [BOOT_SENTINEL]: booted } = await sessionStore.get(BOOT_SENTINEL)
	if (booted === true) return
	const all = await chrome.storage.local.get(null)
	const stale = Object.keys(all).filter(k => k.startsWith(KEY_PREFIX))
	if (stale.length > 0) await chrome.storage.local.remove(stale)
	await sessionStore.set({ [BOOT_SENTINEL]: true })
}
