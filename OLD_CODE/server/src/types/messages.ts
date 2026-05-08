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
  /** Optional: Episode ID or episode number (required for content identity validation) */
  episodeId?: string | number;
  /** Optional: Provider identifier (required for content identity validation) */
  providerId?: string;
  /** Optional: Page URL (required for content identity validation) */
  pageUrl?: string;
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
  /** Client timestamp (monotonic or epoch ms) */
  client_ts: number;
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
 * HEARTBEAT message - Client → Server
 * Regular status update from client for drift detection and buffering detection
 */
export interface HeartbeatMessage extends BaseMessage {
  type: 'HEARTBEAT';
  /** Current playback position reported by client (seconds) */
  currentPos: number;
  /** Current player state */
  playerState: 'playing' | 'paused' | 'buffering';
  /** Optional clock sample for clock synchronization (client timestamp) */
  clockSample?: number;
}

/**
 * CLOCK_PING message - Client → Server
 * Clock synchronization request (NTP-style)
 * Used to calculate per-client clock offset and RTT
 */
export interface ClockPingMessage extends BaseMessage {
  type: 'CLOCK_PING';
  /** Client timestamp when ping was sent (epoch ms) */
  clientSendTime: number;
}

/**
 * CLOCK_PONG message - Server → Client
 * Clock synchronization response (NTP-style)
 * Client calculates offset and RTT from these timestamps
 */
export interface ClockPongMessage extends BaseMessage {
  type: 'CLOCK_PONG';
  /** Client timestamp when ping was sent (from CLOCK_PING) */
  clientSendTime: number;
  /** Server timestamp when ping was received (epoch ms) */
  serverRecvTime: number;
  /** Server timestamp when pong is being sent (epoch ms) */
  serverSendTime: number;
  /** Client should fill this in when pong is received (epoch ms) */
  clientRecvTime?: number;
}

/**
 * BUFFER_START message - Client → Server
 * Sent immediately when playback stalls and buffering begins
 * Tells the server to stop trying to sync that client
 */
export interface BufferStartMessage extends BaseMessage {
  type: 'BUFFER_START';
  /** Current playback position when buffering started (seconds) */
  videoPos: number;
}

/**
 * BUFFER_END message - Client → Server
 * Sent immediately when buffering ends and playback can resume
 * Tells the server it can re-try syncing again, and should send an update to the client with the current room state
 */
export interface BufferEndMessage extends BaseMessage {
  type: 'BUFFER_END';
  /** Current playback position when buffering ended (seconds) */
  videoPos: number;
}

/**
 * STATE message - Server → Client
 * Authoritative playback state broadcast
 * Note: Server state is either 'playing' or 'paused'. Only individual clients can be 'buffering'.
 */
export interface StateMessage extends BaseMessage {
  type: 'STATE';
  /** Current player state: 'playing' or 'paused'. Buffering is client-specific, not server state. */
  playerState: 'playing' | 'paused';
  /** Current playback position in seconds */
  videoPos: number;
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
 * According to backend_network_design_v1.md section 7: includes recentEvents[] since lastEventId for event replay
 * Note: Server state is either 'playing' or 'paused'. Only individual clients can be 'buffering'.
 */
export interface RoomStateMessage extends BaseMessage {
  type: 'ROOM_STATE';
  /** Client identifier assigned by server (UUID v4) - use this for reconnection */
  clientId: ClientId | string;
  /** Current player state: 'playing' or 'paused'. Buffering is client-specific, not server state. */
  playerState: 'playing' | 'paused';
  /** Current playback position in seconds */
  videoPos: number;
  /** Episode ID */
  episodeId?: string | number;
  /** Provider identifier */
  providerId?: string;
  /** Derived content key */
  derivedContentKey?: string;
  /** Last event ID */
  lastEventId: number;
  /** Server timestamp (monotonic or epoch ms) */
  server_ts: number;
  /** Recent events since client's last known eventId (for event replay on reconnection) */
  recentEvents?: Array<{
    /** Event type (e.g., 'play', 'pause', 'seek', 'episode_change') */
    type: string;
    /** Optional event value (e.g., seek position in seconds) */
    value?: number | string;
    /** Client ID that triggered the event */
    clientId?: ClientId | string;
    /** Timestamp when event occurred (milliseconds) */
    ts: number;
    /** Event ID for ordering */
    eventId: number;
  }>;
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
  /** Server timestamp (monotonic or epoch ms) */
  server_ts: number;
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
 * SYNC_ADJUST message - Server → Client
 * Server-driven corrective action for drift reconciliation
 */
export interface SyncAdjustMessage extends BaseMessage {
  type: 'SYNC_ADJUST';
  /** Server timestamp (monotonic or epoch ms) */
  serverTime: number;
  /** Target playback position to sync to (seconds) */
  targetPos: number;
  /** Sync adjustment mode: 'nudge-rate' for small corrections, 'seek' for large corrections */
  mode: 'nudge-rate' | 'seek';
}

/**
 * Union type of all client-to-server messages
 */
export type ClientToServerMessage =
  | JoinMessage
  | EventMessage
  | EpisodeChangeRequestMessage
  | TimeReportMessage
  | HeartbeatMessage
  | ClockPingMessage
  | BufferStartMessage
  | BufferEndMessage;

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
  | ServerShutdownMessage
  | SyncAdjustMessage
  | ClockPongMessage;

/**
 * Union type of all WebSocket messages
 */
export type WebSocketMessage = ClientToServerMessage | ServerToClientMessage;
