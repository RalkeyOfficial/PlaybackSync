import axios from '@nextcloud/axios'
import { generateUrl } from '@nextcloud/router'

interface WsStatusResponse {
	available: boolean
}

/**
 * Ask the server whether the WebSocket sync service is installed and
 * configured. This is an installation check, not a liveness probe — the
 * server returns true when its own dependencies and config keys are in
 * place; whether the daemon process is currently up is something the
 * client only learns when it tries to open the WebSocket.
 *
 * @return the boolean availability flag from the server
 */
export async function fetchWsStatus(): Promise<boolean> {
	const { data } = await axios.get<WsStatusResponse>(generateUrl('/apps/playbacksync/api/v1/ws/status'))
	return data.available
}
