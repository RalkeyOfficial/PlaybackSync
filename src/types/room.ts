export interface Room {
	uuid: string
	name: string | null
	targetUrl: string
	createdAt: number
	expiresAt: number
	shareLink: string
}

export interface CreateRoomPayload {
	targetUrl: string
	name?: string | null
	ttl?: number | null
}

export interface CreatedRoom extends Room {
	password: string
}
