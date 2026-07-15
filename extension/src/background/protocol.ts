/**
 * Wire-format types and (de)serialisers for the v2 PlaybackSync WebSocket
 * protocol. Mirrors `docs/ws-protocol.md` 1-for-1 and matches the daemon
 * encoder/validator in [`lib/WebSocket/MessageEncoder.php`](../../../lib/WebSocket/MessageEncoder.php)
 * and [`lib/WebSocket/MessageValidator.php`](../../../lib/WebSocket/MessageValidator.php).
 *
 * Two contracts live here:
 *
 * - **Outbound** ({@link OutboundFrame}): the union of every client→server
 *   frame. Built via {@link encode}; the type system catches missing
 *   fields at the call site.
 * - **Inbound** ({@link InboundFrame}): the union of every server→client
 *   frame. Parsed via {@link decode}, which returns a tagged
 *   {@link DecodeError} on shape violations rather than throwing — the WS
 *   module logs and continues, never crashing the worker on a stray
 *   server message.
 */

// ─── Shared types ────────────────────────────────────────────────────────

/** Match the daemon's `MessageValidator::ERR_*` and protocol-doc codes. */
export type PlayerState = 'playing' | 'paused' | 'buffering'

/** `mode` field on `SYNC_ADJUST` (`docs/ws-protocol.md` §SYNC_ADJUST). */
export type SyncAdjustMode = 'nudge-rate' | 'seek'

/** `source` values on playlist entries (`docs/ws-protocol.md` §PLAYLIST_UPDATE). */
export type PlaylistEntrySource = 'scraped' | 'curated' | 'auto_appended'

/** Triple identifying a video on a page. Used for JOIN.currentlyShowing. */
export interface VideoRef {
	providerId: string
	videoId: string
	pageUrl: string
}

/** Video reference with optional metadata. Used for catalogFragment + raw cursor targets. */
export interface VideoRefWithMeta extends VideoRef {
	label?: string | null
	episodeNumber?: number | null
	seasonNumber?: number | null
}

/** Cursor projection on `ROOM_STATE` and `CURSOR_CHANGE` server frames. */
export interface CursorRef {
	entryId: string
	providerId: string
	videoId: string
	pageUrl: string
	label: string | null
}

/** Full playlist entry shape as broadcast on `PLAYLIST_UPDATE`. */
export interface PlaylistEntry {
	entryId: string
	position: number
	providerId: string
	videoId: string
	pageUrl: string
	label: string | null
	episodeNumber: number | null
	seasonNumber: number | null
	source: PlaylistEntrySource
	addedAt: number
	lastSeenAt: number
}

/** Replayed event in `ROOM_STATE.recentEvents`. */
export interface RecentEvent {
	type: 'play' | 'pause' | 'seek'
	value: number | null
	clientId: string
	ts: number
	eventId: number
}

// ─── Outbound frames (client → server) ──────────────────────────────────

/** `JOIN` — required first message. See `docs/ws-protocol.md` §JOIN. */
export interface JoinFrame {
	type: 'JOIN'
	password: string
	clientId?: string
	lastEventId?: number
	currentlyShowing?: VideoRef
	catalogFragment?: VideoRefWithMeta[]
}

/** `EVENT` — an observed user action. */
export interface EventFrame {
	type: 'EVENT'
	event: 'play' | 'pause' | 'seek'
	/** Required when `event === 'seek'`, ignored otherwise. Seconds, float. */
	value?: number
	/** Client wall clock in ms — non-authoritative, used by the server for logging. */
	clientTs: number
}

/** `CURSOR_CHANGE_REQUEST` — exactly one of `targetEntryId` / `target`. */
export type CursorChangeRequestFrame =
	| {
		type: 'CURSOR_CHANGE_REQUEST'
		targetEntryId: string
		clientTs: number
	}
	| {
		type: 'CURSOR_CHANGE_REQUEST'
		target: VideoRefWithMeta
		clientTs: number
	}

/** `PLAYLIST_UPDATE` (client→server) — scraped playlist contribution. */
export interface PlaylistUpdateOutFrame {
	type: 'PLAYLIST_UPDATE'
	entries: Array<VideoRefWithMeta & { source?: PlaylistEntrySource }>
	clientTs: number
}

/** `HEARTBEAT` — every ~5 s with current playhead + state. */
export interface HeartbeatFrame {
	type: 'HEARTBEAT'
	currentPos: number
	playerState: PlayerState
}

/** `CLOCK_PING` — NTP-style sample (3-5 on connect, then ~30 s after). */
export interface ClockPingFrame {
	type: 'CLOCK_PING'
	clientSendTime: number
}

/** `BUFFER_START` / `BUFFER_END` — entering/leaving a buffering pause. */
export interface BufferFrame {
	type: 'BUFFER_START' | 'BUFFER_END'
	videoPos: number
}

/** All client→server frames, discriminated by `type`. */
export type OutboundFrame =
	| JoinFrame
	| EventFrame
	| CursorChangeRequestFrame
	| PlaylistUpdateOutFrame
	| HeartbeatFrame
	| ClockPingFrame
	| BufferFrame

// ─── Inbound frames (server → client) ───────────────────────────────────

/** `ROOM_STATE` — initial state after JOIN and re-sent after BUFFER_END. */
export interface RoomStateFrame {
	type: 'ROOM_STATE'
	clientId: string
	/** The client's own server-assigned nickname — surfaced in the self "welcome" toast. */
	nickname: string
	singleMode: boolean
	freeformMode: boolean
	cursor: CursorRef | null
	playlistVersion: string
	playerState: PlayerState
	videoPos: number
	lastEventId: number
	serverTs: number
	recentEvents?: RecentEvent[]
}

/** `STATE` — authoritative state after every EVENT (broadcast to room). */
export interface StateFrame {
	type: 'STATE'
	playerState: PlayerState
	videoPos: number
	eventId: number
	serverTs: number
}

/** `CURSOR_CHANGE` — cursor moved (or JOIN steering for the new client). */
export interface CursorChangeFrame {
	type: 'CURSOR_CHANGE'
	cursor: CursorRef
	eventId: number
	serverTs: number
}

/** `PLAYLIST_UPDATE` (server→client) — full post-merge playlist. */
export interface PlaylistUpdateInFrame {
	type: 'PLAYLIST_UPDATE'
	entries: PlaylistEntry[]
	playlistVersion: string
	serverTs: number
}

/** `SYNC_ADJUST` — per-client drift correction. */
export interface SyncAdjustFrame {
	type: 'SYNC_ADJUST'
	serverTime: number
	targetPos: number
	mode: SyncAdjustMode
}

/** `CLOCK_PONG` — server's clock-sync reply. */
export interface ClockPongFrame {
	type: 'CLOCK_PONG'
	clientSendTime: number
	serverRecvTime: number
	serverSendTime: number
}

/** `ERROR` — protocol-level error (`code` is the canonical key). */
export interface ErrorFrame {
	type: 'ERROR'
	code: string
	message: string
	serverTs: number
}

/** Inner discriminant on a `NOTICE` frame — the peer action being announced. */
export type NoticeEvent =
	| 'play'
	| 'pause'
	| 'seek'
	| 'cursor_change'
	| 'client_joined'
	| 'client_left'

/** Event-specific payload on a `NOTICE` frame. All fields optional per event. */
export interface NoticeData {
	/** Seek target position in seconds (`seek` only). */
	value?: number
	/** New video reference (`cursor_change` only) — the label names the video. */
	videoRef?: { label: string | null } | null
	/** Actor nickname (`client_left`, where `actor` is `system` so `actorId` is null). */
	nickname?: string
	/** Disconnect reason (`client_left`). */
	reason?: string
}

/**
 * `NOTICE` — a display-only, actor-attributed frame the daemon broadcasts to
 * a room's peers so the extension can surface "who did what" toasts. Unlike
 * the authoritative frames it carries an actor nickname; it never affects
 * playback state. See `docs/ws-protocol.md` §NOTICE.
 */
export interface NoticeFrame {
	type: 'NOTICE'
	event: NoticeEvent
	category: 'playback' | 'presence'
	actor: 'client' | 'owner' | 'system'
	actorId: string | null
	data: NoticeData | null
	serverTs: number
}

/** All server→client frames, discriminated by `type`. */
export type InboundFrame =
	| RoomStateFrame
	| StateFrame
	| CursorChangeFrame
	| PlaylistUpdateInFrame
	| SyncAdjustFrame
	| ClockPongFrame
	| ErrorFrame
	| NoticeFrame

// ─── Encode / decode ────────────────────────────────────────────────────

/**
 * Tagged decode failure. Distinguishes parse errors (bad JSON) from
 * shape errors (good JSON, wrong fields). Callers log and continue;
 * we don't throw because a single misbehaving frame must not tear the
 * worker down.
 */
export interface DecodeError {
	ok: false
	error: 'invalid_json' | 'invalid_shape' | 'unknown_type'
	detail: string
}

/**
 * Serialise an outbound frame for `WebSocket.send`. Type-checks the
 * frame shape at the call site — the runtime call is a thin
 * `JSON.stringify`.
 *
 * @param frame The outbound frame to serialise.
 * @returns The wire-ready JSON string.
 */
export function encode(frame: OutboundFrame): string {
	return JSON.stringify(frame)
}

/**
 * Parse a raw text frame from the WebSocket. Returns either a typed
 * inbound frame (`{ ok: true, frame }`) or a tagged error
 * (`{ ok: false, ... }`).
 *
 * Extra fields on the server frame are tolerated (forward-compat).
 * Required fields, types, and the `type` discriminator are enforced.
 *
 * @param raw The raw text payload from `MessageEvent.data`.
 * @returns A success envelope wrapping a typed frame, or a tagged error.
 */
export function decode(raw: string): { ok: true; frame: InboundFrame } | DecodeError {
	let parsed: unknown
	try {
		parsed = JSON.parse(raw)
	} catch (err) {
		return {
			ok: false,
			error: 'invalid_json',
			detail: err instanceof Error ? err.message : String(err),
		}
	}
	if (!isObj(parsed)) {
		return { ok: false, error: 'invalid_shape', detail: 'frame is not an object' }
	}
	const type = parsed['type']
	if (typeof type !== 'string') {
		return { ok: false, error: 'invalid_shape', detail: 'missing or non-string "type"' }
	}

	switch (type) {
		case 'ROOM_STATE':
			return decodeRoomState(parsed)
		case 'STATE':
			return decodeState(parsed)
		case 'CURSOR_CHANGE':
			return decodeCursorChange(parsed)
		case 'PLAYLIST_UPDATE':
			return decodePlaylistUpdate(parsed)
		case 'SYNC_ADJUST':
			return decodeSyncAdjust(parsed)
		case 'CLOCK_PONG':
			return decodeClockPong(parsed)
		case 'ERROR':
			return decodeError(parsed)
		case 'NOTICE':
			return decodeNotice(parsed)
		default:
			return { ok: false, error: 'unknown_type', detail: type }
	}
}

// ─── Per-frame decoders ────────────────────────────────────────────────

type Obj = Record<string, unknown>

function isObj(v: unknown): v is Obj {
	return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function decodeRoomState(o: Obj): { ok: true; frame: RoomStateFrame } | DecodeError {
	const clientId = asString(o['clientId'])
	// Tolerant: an older daemon may omit `nickname`. Fall back to '' rather
	// than rejecting the whole ROOM_STATE, which would break sync entirely.
	const nickname = asString(o['nickname']) ?? ''
	const playlistVersion = asString(o['playlistVersion'])
	const playerState = asPlayerState(o['playerState'])
	const videoPos = asNumber(o['videoPos'])
	const lastEventId = asInt(o['lastEventId'])
	const serverTs = asInt(o['serverTs'])
	const singleMode = asBool(o['singleMode'])
	const freeformMode = asBool(o['freeformMode'])
	if (
		clientId === null
		|| playlistVersion === null
		|| playerState === null
		|| videoPos === null
		|| lastEventId === null
		|| serverTs === null
		|| singleMode === null
		|| freeformMode === null
	) {
		return shape('ROOM_STATE missing or mistyped required field')
	}
	const cursor = decodeOptionalCursor(o['cursor'])
	if (cursor === 'bad') return shape('ROOM_STATE.cursor malformed')

	const recentEvents = o['recentEvents']
	let parsedEvents: RecentEvent[] | undefined
	if (recentEvents !== undefined) {
		if (!Array.isArray(recentEvents)) return shape('ROOM_STATE.recentEvents must be array')
		parsedEvents = []
		for (const ev of recentEvents) {
			if (!isObj(ev)) return shape('ROOM_STATE.recentEvents[] not object')
			const type = ev['type']
			if (type !== 'play' && type !== 'pause' && type !== 'seek') {
				return shape('ROOM_STATE.recentEvents[].type invalid')
			}
			const eClientId = asString(ev['clientId'])
			const ts = asInt(ev['ts'])
			const eventId = asInt(ev['eventId'])
			if (eClientId === null || ts === null || eventId === null) {
				return shape('ROOM_STATE.recentEvents[] missing fields')
			}
			const value = ev['value']
			const valueNum = value === null || value === undefined ? null : asNumber(value)
			if (valueNum === null && value !== null && value !== undefined) {
				return shape('ROOM_STATE.recentEvents[].value not number')
			}
			parsedEvents.push({
				type,
				value: valueNum,
				clientId: eClientId,
				ts,
				eventId,
			})
		}
	}

	return {
		ok: true,
		frame: {
			type: 'ROOM_STATE',
			clientId,
			nickname,
			singleMode,
			freeformMode,
			cursor,
			playlistVersion,
			playerState,
			videoPos,
			lastEventId,
			serverTs,
			...(parsedEvents !== undefined ? { recentEvents: parsedEvents } : {}),
		},
	}
}

function decodeState(o: Obj): { ok: true; frame: StateFrame } | DecodeError {
	const playerState = asPlayerState(o['playerState'])
	const videoPos = asNumber(o['videoPos'])
	const eventId = asInt(o['eventId'])
	const serverTs = asInt(o['serverTs'])
	if (playerState === null || videoPos === null || eventId === null || serverTs === null) {
		return shape('STATE missing or mistyped required field')
	}
	return { ok: true, frame: { type: 'STATE', playerState, videoPos, eventId, serverTs } }
}

function decodeCursorChange(o: Obj): { ok: true; frame: CursorChangeFrame } | DecodeError {
	const cursor = decodeOptionalCursor(o['cursor'])
	if (cursor === 'bad' || cursor === null) return shape('CURSOR_CHANGE.cursor required')
	const eventId = asInt(o['eventId'])
	const serverTs = asInt(o['serverTs'])
	if (eventId === null || serverTs === null) return shape('CURSOR_CHANGE missing fields')
	return { ok: true, frame: { type: 'CURSOR_CHANGE', cursor, eventId, serverTs } }
}

function decodePlaylistUpdate(o: Obj): { ok: true; frame: PlaylistUpdateInFrame } | DecodeError {
	const entries = o['entries']
	const playlistVersion = asString(o['playlistVersion'])
	const serverTs = asInt(o['serverTs'])
	if (playlistVersion === null || serverTs === null) return shape('PLAYLIST_UPDATE missing fields')

	const parsed = decodePlaylistEntries(entries, 'PLAYLIST_UPDATE')
	if (!parsed.ok) return parsed
	return {
		ok: true,
		frame: { type: 'PLAYLIST_UPDATE', entries: parsed.entries, playlistVersion, serverTs },
	}
}

/**
 * Parse the `entries` array shared by `PLAYLIST_UPDATE` and `ROOM_STATE`.
 * Both carry the same wire shape; the encoder uses `encodePlaylistEntry`
 * for either. The caller passes its frame name so the shape errors stay
 * traceable to the originating decode path.
 *
 * @param raw The unparsed `entries` field — must be an array.
 * @param frameName Frame name used in error messages.
 */
function decodePlaylistEntries(
	raw: unknown,
	frameName: 'PLAYLIST_UPDATE' | 'ROOM_STATE',
): { ok: true; entries: PlaylistEntry[] } | DecodeError {
	if (!Array.isArray(raw)) return shape(`${frameName}.entries must be array`)
	const parsed: PlaylistEntry[] = []
	for (const e of raw) {
		if (!isObj(e)) return shape(`${frameName}.entries[] not object`)
		const entryId = asString(e['entryId'])
		const position = asInt(e['position'])
		const providerId = asString(e['providerId'])
		const videoId = asString(e['videoId'])
		const pageUrl = asString(e['pageUrl'])
		const source = e['source']
		const addedAt = asInt(e['addedAt'])
		const lastSeenAt = asInt(e['lastSeenAt'])
		if (
			entryId === null || position === null || providerId === null
			|| videoId === null || pageUrl === null || addedAt === null || lastSeenAt === null
		) {
			return shape(`${frameName}.entries[] missing required fields`)
		}
		if (
			source !== 'scraped'
			&& source !== 'curated'
			&& source !== 'auto_appended'
		) {
			return shape(`${frameName}.entries[].source invalid`)
		}
		parsed.push({
			entryId,
			position,
			providerId,
			videoId,
			pageUrl,
			label: asNullableString(e['label']),
			episodeNumber: asNullableInt(e['episodeNumber']),
			seasonNumber: asNullableInt(e['seasonNumber']),
			source,
			addedAt,
			lastSeenAt,
		})
	}
	return { ok: true, entries: parsed }
}

function decodeSyncAdjust(o: Obj): { ok: true; frame: SyncAdjustFrame } | DecodeError {
	const serverTime = asInt(o['serverTime'])
	const targetPos = asNumber(o['targetPos'])
	const mode = o['mode']
	if (serverTime === null || targetPos === null) return shape('SYNC_ADJUST missing fields')
	if (mode !== 'nudge-rate' && mode !== 'seek') return shape('SYNC_ADJUST.mode invalid')
	return { ok: true, frame: { type: 'SYNC_ADJUST', serverTime, targetPos, mode } }
}

function decodeClockPong(o: Obj): { ok: true; frame: ClockPongFrame } | DecodeError {
	const clientSendTime = asNumber(o['clientSendTime'])
	const serverRecvTime = asInt(o['serverRecvTime'])
	const serverSendTime = asInt(o['serverSendTime'])
	if (clientSendTime === null || serverRecvTime === null || serverSendTime === null) {
		return shape('CLOCK_PONG missing fields')
	}
	return {
		ok: true,
		frame: { type: 'CLOCK_PONG', clientSendTime, serverRecvTime, serverSendTime },
	}
}

function decodeError(o: Obj): { ok: true; frame: ErrorFrame } | DecodeError {
	const code = asString(o['code'])
	const message = asString(o['message'])
	const serverTs = asInt(o['serverTs'])
	if (code === null || message === null || serverTs === null) return shape('ERROR missing fields')
	return { ok: true, frame: { type: 'ERROR', code, message, serverTs } }
}

function decodeNotice(o: Obj): { ok: true; frame: NoticeFrame } | DecodeError {
	const event = o['event']
	if (
		event !== 'play' && event !== 'pause' && event !== 'seek'
		&& event !== 'cursor_change' && event !== 'client_joined' && event !== 'client_left'
	) {
		return shape('NOTICE.event invalid')
	}
	const category = o['category']
	if (category !== 'playback' && category !== 'presence') return shape('NOTICE.category invalid')
	const actor = o['actor']
	if (actor !== 'client' && actor !== 'owner' && actor !== 'system') return shape('NOTICE.actor invalid')
	const serverTs = asInt(o['serverTs'])
	if (serverTs === null) return shape('NOTICE missing serverTs')
	return {
		ok: true,
		frame: {
			type: 'NOTICE',
			event,
			category,
			actor,
			actorId: asNullableString(o['actorId']),
			data: decodeNoticeData(o['data']),
			serverTs,
		},
	}
}

/**
 * Parse a `NOTICE.data` blob loosely — every field is optional and
 * event-specific, and unknown fields are ignored (forward-compat). Returns
 * null when `data` is absent or not an object.
 *
 * @param v The raw `data` field off the wire.
 */
function decodeNoticeData(v: unknown): NoticeData | null {
	if (!isObj(v)) return null
	const data: NoticeData = {}
	const value = asNumber(v['value'])
	if (value !== null) data.value = value
	const nickname = asString(v['nickname'])
	if (nickname !== null) data.nickname = nickname
	const reason = asString(v['reason'])
	if (reason !== null) data.reason = reason
	if (isObj(v['videoRef'])) data.videoRef = { label: asNullableString(v['videoRef']['label']) }
	return data
}

function decodeOptionalCursor(v: unknown): CursorRef | null | 'bad' {
	if (v === null || v === undefined) return null
	if (!isObj(v)) return 'bad'
	const entryId = asString(v['entryId'])
	const providerId = asString(v['providerId'])
	const videoId = asString(v['videoId'])
	const pageUrl = asString(v['pageUrl'])
	const label = asNullableString(v['label'])
	if (entryId === null || providerId === null || videoId === null || pageUrl === null) return 'bad'
	return { entryId, providerId, videoId, pageUrl, label }
}

// ─── Field coercion helpers ────────────────────────────────────────────

function asString(v: unknown): string | null {
	return typeof v === 'string' ? v : null
}

function asNullableString(v: unknown): string | null {
	if (v === null || v === undefined) return null
	return typeof v === 'string' ? v : null
}

function asNumber(v: unknown): number | null {
	return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function asInt(v: unknown): number | null {
	return typeof v === 'number' && Number.isInteger(v) ? v : null
}

function asNullableInt(v: unknown): number | null {
	if (v === null || v === undefined) return null
	return asInt(v)
}

function asBool(v: unknown): boolean | null {
	return typeof v === 'boolean' ? v : null
}

function asPlayerState(v: unknown): PlayerState | null {
	return v === 'playing' || v === 'paused' || v === 'buffering' ? v : null
}

function shape(detail: string): DecodeError {
	return { ok: false, error: 'invalid_shape', detail }
}
