import { generateUrl } from '@nextcloud/router'

/**
 * Build the EventSource URL for a single room's event-log stream.
 *
 * EventSource can't set custom headers, so cross-request state has to ride
 * along on cookies (which `generateUrl` already wires up by virtue of being
 * a same-origin URL) or on the query string. The browser sends
 * `Last-Event-ID` automatically on reconnect; the PHP proxy forwards it.
 *
 * @param uuid the room's UUID
 * @return the absolute URL the EventSource should open
 */
export function buildRoomEventStreamUrl(uuid: string): string {
	return generateUrl('/apps/playbacksync/api/v1/rooms/' + encodeURIComponent(uuid) + '/events/stream')
}

/**
 * Open a fresh EventSource for the room's stream. The caller owns the
 * lifetime — it must close the returned source when done (typically inside
 * `onBeforeUnmount` or when a tab loses focus).
 *
 * `withCredentials: true` ensures the Nextcloud session cookie rides along
 * even when the dashboard is loaded from a different subdomain in some
 * deployments — the same-origin case is unaffected.
 *
 * @param uuid the room's UUID
 * @return a freshly opened EventSource
 */
export function openRoomEventStream(uuid: string): EventSource {
	return new EventSource(buildRoomEventStreamUrl(uuid), { withCredentials: true })
}
