export interface ConnectedClient {
	clientId: string
	nickname: string
	isBuffering: boolean
	lastSeenMs: number
}

export type PlaylistEntrySource = 'scraped' | 'curated' | 'auto_appended'

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
	addedBy: string
	addedAt: number
	lastSeenAt: number
}

export interface RoomLiveState {
	connectedCount: number
	clients: ConnectedClient[]
	playerState: string
	videoPos: number
	lastActivityMs: number | null
}

export interface Room {
	uuid: string
	name: string | null
	bootstrapUrl: string
	singleMode: boolean
	freeformMode: boolean
	playlist: PlaylistEntry[]
	cursorEntryId: string | null
	createdAt: number
	expiresAt: number
	shareLink: string
	live: RoomLiveState | null
}

export interface InitialPlaylistEntry {
	providerId: string
	videoId: string
	pageUrl: string
	label?: string | null
	episodeNumber?: number | null
	seasonNumber?: number | null
}

export interface CreateRoomPayload {
	bootstrapUrl: string
	name?: string | null
	ttl?: number | null
	singleMode?: boolean
	freeformMode?: boolean
	initialEntries?: InitialPlaylistEntry[]
}

export interface CreatedRoom extends Room {
	password: string
}

export interface RoomClientsResponse {
	connectedCount: number
	clients: ConnectedClient[]
}
