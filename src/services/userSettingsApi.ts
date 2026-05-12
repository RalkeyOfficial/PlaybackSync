import type { UserSettingsPatch, UserSettingsSnapshot } from '../types/userSettings.ts'

import axios from '@nextcloud/axios'
import { generateUrl } from '@nextcloud/router'

/**
 * Build an absolute URL to the user settings REST API.
 *
 * @param path sub-path appended to `/apps/playbacksync/api/v1/user/settings`
 * @return the URL the Nextcloud router expects, ready to pass to axios
 */
function apiUrl(path: string = ''): string {
	return generateUrl('/apps/playbacksync/api/v1/user/settings' + path)
}

/**
 * Fetch the current user's personal settings snapshot.
 *
 * @return the current settings as the server sees them
 */
export async function fetchUserSettings(): Promise<UserSettingsSnapshot> {
	const { data } = await axios.get<UserSettingsSnapshot>(apiUrl())
	return data
}

/**
 * Persist a partial patch of user settings. The server validates every
 * field server-side and rejects the entire patch with `400` if any value is
 * out of range.
 *
 * @param patch flat map of config keys to new values; only the keys present are changed
 * @return the refreshed settings snapshot the server returns after persisting
 */
export async function updateUserSettings(patch: UserSettingsPatch): Promise<UserSettingsSnapshot> {
	const { data } = await axios.put<UserSettingsSnapshot>(apiUrl(), { values: patch })
	return data
}
