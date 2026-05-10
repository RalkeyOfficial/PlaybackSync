import axios from '@nextcloud/axios'
import { generateUrl } from '@nextcloud/router'

export type WsUnavailableReason = 'not_installed' | 'not_running'

export interface WsStatus {
	available: boolean
	reason: WsUnavailableReason | null
}

interface WsStatusResponse {
	available: boolean
	reason: WsUnavailableReason | null
}

/**
 * Ask the server whether the WebSocket sync service is usable. The server
 * answers with both:
 *   - `available`: the binary "can sync work right now" flag.
 *   - `reason`: when `available` is false, why — `not_installed` (admin
 *     hasn't set it up) vs. `not_running` (set up but daemon process is
 *     down). The two surface different help dialogs in the UI.
 *
 * @return the parsed status payload from the server
 */
export async function fetchWsStatus(): Promise<WsStatus> {
	const { data } = await axios.get<WsStatusResponse>(generateUrl('/apps/playbacksync/api/v1/ws/status'))
	return {
		available: data.available,
		reason: data.reason,
	}
}
