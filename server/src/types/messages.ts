import type { ClientId } from './ids';

/**
 * Base message interface with common fields
 */
interface BaseMessage {
  /** Message type identifier */
  type: string;
}

/**
 * JOIN message - Client → Server
 * Sent when a client wants to join a room
 * roomId is extracted from the WebSocket URL path (`/:roomId`)
 * clientId is generated server-side (or provided for reconnection)
 */
export interface JoinMessage extends BaseMessage {
  type: 'JOIN';
  /** Room password (plaintext, will be hashed server-side) */
  password: string;
  /** Optional: Previous client identifier for reconnection (received from previous ROOM_STATE) */
  clientId?: ClientId | string;
  /** Last known playback time from client (seconds) */
  lastKnownTime?: number;
}

/**
 * EVENT message - Client → Server
 * Explicit control events (play, pause, seek)
 */
export interface EventMessage extends BaseMessage {
  type: 'EVENT';
  /** Event type: 'play', 'pause', or 'seek' */
  event: 'play' | 'pause' | 'seek';
  /** Optional value (required for seek events, in seconds) */
  value?: number;
  /** Client timestamp (monotonic or epoch ms) */
  client_ts: number;
}

/**
 * EPISODE_CHANGE_REQUEST message - Client → Server
 * Request to change the episode being watched
 */
export interface EpisodeChangeRequestMessage extends BaseMessage {
  type: 'EPISODE_CHANGE_REQUEST';
  /** Episode ID or episode number */
  episodeId: string | number;
  /** Provider identifier */
  providerId: string;
  /** Page URL */
  pageUrl: string;
  /** Client timestamp */
  clientTime: number;
}

/**
 * TIME_REPORT message - Client → Server
 * Sent in response to drift reconciliation requests
 */
export interface TimeReportMessage extends BaseMessage {
  type: 'TIME_REPORT';
  /** Current playback time reported by client (seconds) */
  current_time: number;
  /** Client timestamp */
  client_ts: number;
}

/**
 * STATE message - Server → Client
 * Authoritative playback state broadcast
 */
export interface StateMessage extends BaseMessage {
  type: 'STATE';
  /** Whether playback is paused */
  paused: boolean;
  /** Current playback time (seconds) */
  time: number;
  /** Provider identifier */
  provider?: string;
  /** Episode number or identifier */
  episode?: number;
  /** Server timestamp (monotonic or epoch ms) */
  server_ts: number;
  /** Event ID for ordering */
  eventId: number;
}

/**
 * ROOM_STATE message - Server → Client
 * Sent to clients on JOIN/REJOIN with full room state
 */
export interface RoomStateMessage extends BaseMessage {
  type: 'ROOM_STATE';
  /** Client identifier assigned by server (UUID v4) - use this for reconnection */
  clientId: ClientId | string;
  /** Playback state */
  paused: boolean;
  /** Current playback time (seconds) */
  time: number;
  /** Episode ID */
  episodeId?: string | number;
  /** Provider identifier */
  providerId?: string;
  /** Derived content key */
  derivedContentKey?: string;
  /** Last event ID */
  lastEventId: number;
  /** Server timestamp */
  serverTime: number;
}

/**
 * COMMAND message - Server → Client
 * Server-initiated action command
 */
export interface CommandMessage extends BaseMessage {
  type: 'COMMAND';
  /** Command type: 'seek', 'play', or 'pause' */
  cmd: 'seek' | 'play' | 'pause';
  /** Optional value (required for seek commands, in seconds) */
  value?: number;
  /** Server timestamp */
  server_ts?: number;
}

/**
 * EPISODE_CHANGE message - Server → Client
 * Authoritative episode change broadcast
 */
export interface EpisodeChangeMessage extends BaseMessage {
  type: 'EPISODE_CHANGE';
  /** Event ID for ordering */
  eventId: number;
  /** Episode ID */
  episodeId: string | number;
  /** Provider identifier */
  providerId: string;
  /** Derived content key */
  derivedContentKey: string;
  /** Server timestamp */
  serverTime: number;
}

/**
 * CONTENT_MISMATCH message - Server → Client
 * Advisory message when content identity doesn't match
 */
export interface ContentMismatchMessage extends BaseMessage {
  type: 'CONTENT_MISMATCH';
  /** Expected derived content key */
  expectedContentKey: string;
  /** Client-reported content key */
  reportedContentKey?: string;
  /** Server timestamp */
  server_ts: number;
}

/**
 * ERROR message - Server → Client
 * Error response for various failure scenarios
 */
export interface ErrorMessage extends BaseMessage {
  type: 'ERROR';
  /** Error code (e.g., 'AUTH_FAILED', 'INVALID_MESSAGE', 'RATE_LIMITED') */
  code: string;
  /** Human-readable error message */
  message: string;
  /** Optional server timestamp */
  server_ts?: number;
}

/**
 * SERVER_SHUTDOWN message - Server → Client
 * Notification sent to clients when server is shutting down
 */
export interface ServerShutdownMessage extends BaseMessage {
  type: 'SERVER_SHUTDOWN';
  /** Server timestamp */
  server_ts: number;
}

/**
 * Union type of all client-to-server messages
 */
export type ClientToServerMessage =
  | JoinMessage
  | EventMessage
  | EpisodeChangeRequestMessage
  | TimeReportMessage;

/**
 * Union type of all server-to-client messages
 */
export type ServerToClientMessage =
  | StateMessage
  | RoomStateMessage
  | CommandMessage
  | EpisodeChangeMessage
  | ContentMismatchMessage
  | ErrorMessage
  | ServerShutdownMessage;

/**
 * Union type of all WebSocket messages
 */
export type WebSocketMessage = ClientToServerMessage | ServerToClientMessage;
