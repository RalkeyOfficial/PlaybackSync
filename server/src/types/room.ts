import type { WebSocket } from 'ws';
import type { RoomId, ClientId } from './ids';

/**
 * Playback state within a room
 * Note: Server state is either 'playing' or 'paused'. Only individual clients can be 'buffering'.
 */
export interface PlaybackState {
  /** Current player state: 'playing' or 'paused'. Buffering is client-specific, not server state. */
  playerState: 'playing' | 'paused';
  /** Current playback position in seconds */
  videoPos: number;
  /** Provider identifier (e.g., 'netflix', 'hulu') */
  provider: string;
  /** Episode number or identifier */
  episode: number;
  /** Timestamp of last explicit user event (play/pause/seek) in milliseconds */
  last_explicit_event_ts: number;
  /** Timestamp of last state update in milliseconds */
  last_state_update_ts: number;
  /** Last event ID for ordering */
  eventId: number;
}

/**
 * Content identity information
 */
export interface ContentIdentity {
  /** Episode ID or episode number */
  episodeId: string | number;
  /** Provider identifier */
  providerId: string;
  /** Derived content key computed from URL + provider + episode */
  derivedContentKey: string;
  /** Normalized page URL */
  pageUrl?: string;
}

/**
 * Client connection metadata
 */
export interface ClientConnection {
  /** Unique client identifier */
  clientId: ClientId;
  /** WebSocket connection object */
  conn: WebSocket;
  /** Last time client was seen (timestamp in milliseconds) */
  lastSeen: number;
  /** Optional tombstone timestamp - allows reconnection with same clientId */
  tombstonedUntil?: number;
  /** Last event ID the client acknowledged (for event replay on reconnection) */
  lastEventId?: number;
  /** Clock offset in milliseconds (serverTime - clientTime) */
  clockOffset?: number;
  /** Round-trip time in milliseconds */
  rtt?: number;
  /** Timestamp when clock offset was last updated (milliseconds) */
  clockSyncTime?: number;
  /** Whether the client is currently buffering (stops server from syncing this client) */
  isBuffering?: boolean;
}

/**
 * Recent event entry in the event log (ring buffer)
 */
export interface RecentEvent {
  /** Event type (e.g., 'play', 'pause', 'seek', 'episode_change') */
  type: string;
  /** Optional event value (e.g., seek position in seconds) */
  value?: number | string;
  /** Client ID that triggered the event */
  clientId?: ClientId;
  /** Timestamp when event occurred (milliseconds) */
  ts: number;
  /** Event ID for ordering */
  eventId: number;
}

/**
 * Room data structure containing all room state
 */
export interface Room {
  /** Unique room identifier */
  roomId: RoomId;
  /** Hashed password (HMAC-SHA256) - never store plaintext */
  passwordHash: string;
  /** Room creation timestamp (milliseconds) */
  createdAt: number;
  /** Room expiration timestamp (milliseconds) */
  expiresAt: number;
  /** Target video URL for the room - required for sharing functionality */
  targetUrl: string;
  /** Optional room name/nickname for identification */
  name?: string;
  /** Current playback state */
  state: PlaybackState;
  /** Content identity information */
  contentIdentity?: ContentIdentity;
  /** Map of connected clients */
  connectedClients: Map<ClientId, ClientConnection>;
  /** Ring buffer of recent events (last N events) */
  eventLog: RecentEvent[];
}
