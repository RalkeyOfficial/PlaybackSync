export interface ConnectedClient {
	clientId: string
	nickname: string
	isBuffering: boolean
	lastSeenMs: number
}

export interface ContentIdentity {
	providerId: string
	episodeId: string
	pageUrl: string
	contentKey: string
}

export interface RoomLiveState {
	connectedCount: number
	clients: ConnectedClient[]
	playerState: string
	videoPos: number
	contentIdentity: ContentIdentity | null
	lastActivityMs: number | null
}

export interface Room {
	uuid: string
	name: string | null
	targetUrl: string
	createdAt: number
	expiresAt: number
	shareLink: string
	live: RoomLiveState | null
}

export interface CreateRoomPayload {
	targetUrl: string
	name?: string | null
	ttl?: number | null
}

export interface CreatedRoom extends Room {
	password: string
}

export interface RoomClientsResponse {
	connectedCount: number
	clients: ConnectedClient[]
}
