/**
 * Type definitions and core interfaces for PlaybackSync server
 *
 * This module exports all type definitions used throughout the application,
 * including room data structures, client connections, message types, and
 * branded identifier types.
 */

// Branded types for UUID identifiers
export type { RoomId, ClientId } from './ids';
export { isValidUuid, toRoomId, toClientId } from './ids';

// Room data structures
export type { Room, ClientConnection, RecentEvent, PlaybackState, ContentIdentity } from './room';

// WebSocket message types
export type {
  JoinMessage,
  EventMessage,
  EpisodeChangeRequestMessage,
  TimeReportMessage,
  StateMessage,
  RoomStateMessage,
  CommandMessage,
  EpisodeChangeMessage,
  ContentMismatchMessage,
  ErrorMessage,
  ServerShutdownMessage,
  ClientToServerMessage,
  ServerToClientMessage,
  WebSocketMessage,
} from './messages';
