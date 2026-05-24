/**
 * Thin wrapper over `chrome.storage.local` for the WebSocket client's
 * credentials. In this slice the values are entered manually via DevTools
 * — the share-URL credential-pickup flow is a follow-up spec. Keeping
 * storage isolated here means the share-URL spec only needs to add a
 * writer that targets the same key.
 *
 * Storage schema (key = `'pbsync'`):
 *
 * ```jsonc
 * {
 *   "syncUrl": "wss://<host>/index.php/apps/playbacksync/ws/<uuid>",
 *   "syncPassword": "<plaintext room password>",
 *   "clientId": "<server-assigned, persisted for reconnect>"
 * }
 * ```
 *
 * To seed creds for dev, open the extension's background-page DevTools
 * and run:
 *
 * ```js
 * chrome.storage.local.set({ pbsync: { syncUrl: '…', syncPassword: '…' } })
 * ```
 */

/** Credential record stored at `chrome.storage.local.pbsync`. */
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

const STORAGE_KEY = 'pbsync'

/**
 * Load the current credentials. Returns `null` when no entry exists or
 * when the stored shape doesn't match.
 *
 * @returns The stored credentials, or `null` if missing / malformed.
 */
export async function loadCreds(): Promise<PbSyncCreds | null> {
	const result = await chrome.storage.local.get(STORAGE_KEY)
	const raw = result[STORAGE_KEY]
	if (!raw || typeof raw !== 'object') return null
	const obj = raw as Record<string, unknown>
	const syncUrl = obj['syncUrl']
	const syncPassword = obj['syncPassword']
	if (typeof syncUrl !== 'string' || typeof syncPassword !== 'string') return null
	const clientId = typeof obj['clientId'] === 'string' ? obj['clientId'] : undefined
	return { syncUrl, syncPassword, ...(clientId !== undefined ? { clientId } : {}) }
}

/**
 * Persist a server-assigned `clientId` alongside the existing creds, so
 * the next reconnect can pass it back on `JOIN` and get a tombstone
 * replay. No-op when no creds are stored.
 *
 * @param clientId The hex string the server returned in `ROOM_STATE.clientId`.
 */
export async function saveClientId(clientId: string): Promise<void> {
	const current = await loadCreds()
	if (!current) return
	await chrome.storage.local.set({ [STORAGE_KEY]: { ...current, clientId } })
}

/**
 * Wipe stored creds. Used by the future "leave room" action; here for
 * symmetry and to keep the dev shim self-contained.
 */
export async function clearCreds(): Promise<void> {
	await chrome.storage.local.remove(STORAGE_KEY)
}
