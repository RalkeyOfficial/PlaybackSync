/** Event-log envelope as emitted by the WS daemon over SSE. */
export interface EventLogEntry {
	/** Process-wide monotonic id used as the SSE `Last-Event-ID`. */
	id: number
	/** Wall-clock timestamp in unix milliseconds. */
	ts: number
	/** Event type within its category (e.g. `play`, `client_joined`). */
	type: string
	/** Broad grouping for icon / chip styling. */
	category: EventCategory
	/** Who originated the event. */
	actor: EventActor
	/** Identifier for the actor — clientId, Nextcloud userId, or null. */
	actorId: string | null
	/** Room the event belongs to. */
	roomUuid: string
	/** Type-specific extra fields (e.g. `{ videoPos }` or `{ clientId, reason }`). */
	data: Record<string, unknown> | null
}

export type EventCategory = 'playback' | 'presence' | 'lifecycle' | 'admin'
export type EventActor = 'client' | 'owner' | 'admin' | 'system'

/** Meta record the daemon emits once per SSE connection. */
export interface EventStreamMeta {
	/** Daemon process start time, unix ms. Resets across daemon restarts. */
	daemonStartedAtMs: number
	/** `Last-Event-ID` the daemon used as the backfill cursor. */
	backfilledFromId: number
	/** Number of events emitted before live mode began. */
	backfillCount: number
}

/** Connection state surfaced by the SSE composable. */
export type EventStreamState = 'connecting' | 'open' | 'closed' | 'error'
