import type { AdminSecretInfo, AdminSettingsPatch, AdminSettingsSnapshot } from '../types/adminSettings.ts'

import axios from '@nextcloud/axios'
import { generateUrl } from '@nextcloud/router'

/**
 * Build an absolute URL to the admin settings REST API.
 *
 * @param path sub-path appended to `/apps/playbacksync/api/v1/admin/settings`
 * @return the URL the Nextcloud router expects, ready to pass to axios
 */
function apiUrl(path: string = ''): string {
	return generateUrl('/apps/playbacksync/api/v1/admin/settings' + path)
}

/**
 * Fetch the full admin settings snapshot. The admin secret is returned in
 * masked form only — the plaintext value never leaves the server.
 *
 * @return the current settings as the server sees them
 */
export async function fetchAdminSettings(): Promise<AdminSettingsSnapshot> {
	const { data } = await axios.get<AdminSettingsSnapshot>(apiUrl())
	return data
}

/**
 * Persist a partial patch of admin settings. The server validates every
 * field server-side and rejects the entire patch with `400` if any value is
 * out of range.
 *
 * @param patch flat map of config keys to new values; only the keys present are changed
 * @return the refreshed settings snapshot the server returns after persisting
 */
export async function updateAdminSettings(patch: AdminSettingsPatch): Promise<AdminSettingsSnapshot> {
	const { data } = await axios.put<AdminSettingsSnapshot>(apiUrl(), { values: patch })
	return data
}

/**
 * Rotate the WebSocket admin shared secret. The running daemon will continue
 * to use the previous secret until it is restarted, so admin endpoints will
 * fail in the meantime — callers must surface that warning before calling.
 *
 * @return the masked form of the freshly rotated secret
 */
export async function regenerateAdminSecret(): Promise<AdminSecretInfo> {
	const { data } = await axios.post<{ secret: AdminSecretInfo }>(apiUrl('/secret'))
	return data.secret
}

/**
 * Ask the WebSocket daemon to exit so its supervisor restarts it. A resolved
 * promise only means the exit request was accepted by the daemon — it does not
 * confirm the daemon came back up. Callers verify recovery by polling the WS
 * status endpoint. Rejects (502) when the daemon is unreachable.
 */
export async function restartDaemon(): Promise<void> {
	await axios.post(generateUrl('/apps/playbacksync/api/v1/admin/ws/restart'))
}
