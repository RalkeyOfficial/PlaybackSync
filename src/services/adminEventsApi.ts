import { generateUrl } from '@nextcloud/router'

/**
 * Build the EventSource URL for the cross-room admin event-log stream.
 *
 * Mirrors `roomEventsApi.ts` — the browser sends `Last-Event-ID` automatically
 * on reconnect; the PHP proxy forwards it down to the daemon.
 *
 * @return the absolute URL the EventSource should open
 */
export function buildAdminEventStreamUrl(): string {
	return generateUrl('/apps/playbacksync/api/v1/admin/events/stream')
}

/**
 * Open a fresh EventSource for the cross-room admin feed. The caller owns
 * the lifetime — close the returned source on unmount.
 *
 * @return a freshly opened EventSource
 */
export function openAdminEventStream(): EventSource {
	return new EventSource(buildAdminEventStreamUrl(), { withCredentials: true })
}
