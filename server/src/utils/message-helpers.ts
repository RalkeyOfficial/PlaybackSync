/**
 * WebSocket message sending utilities
 * Helper functions for sending messages to WebSocket clients
 */

import { WebSocket } from 'ws';
import { logger } from './logger';
import type { RoomId, ClientId } from '../types/ids';
import type { ErrorMessage, RoomStateMessage } from '../types/messages';
import type { Room } from '../types/room';

/**
 * Extended WebSocket interface with connection metadata
 * Re-exported here for use in message helpers
 */
export interface ExtendedWebSocket extends WebSocket {
  /** Room ID this connection belongs to (set after JOIN) */
  roomId?: RoomId;
  /** Client ID for this connection (set after JOIN) */
  clientId?: ClientId;
}

/**
 * Send an ERROR message to a WebSocket client
 */
export function sendError(ws: ExtendedWebSocket, code: string, message: string): void {
  const errorMessage: ErrorMessage = {
    type: 'ERROR',
    code,
    message,
    server_ts: Date.now(),
  };

  try {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(errorMessage));
    }
  } catch (error) {
    logger.warn(
      {
        error,
        roomId: ws.roomId,
        clientId: ws.clientId || undefined,
        code,
      },
      'Failed to send ERROR message to client'
    );
  }
}

/**
 * Send a ROOM_STATE message to a WebSocket client
 */
export function sendRoomState(ws: ExtendedWebSocket, room: Room, clientId: ClientId): void {
  const roomStateMessage: RoomStateMessage = {
    type: 'ROOM_STATE',
    clientId,
    paused: room.state.paused,
    time: room.state.time,
    lastEventId: room.state.eventId,
    server_ts: Date.now(),
  };

  // Add optional fields if they exist
  if (room.contentIdentity) {
    roomStateMessage.episodeId = room.contentIdentity.episodeId;
    roomStateMessage.providerId = room.contentIdentity.providerId;
    roomStateMessage.derivedContentKey = room.contentIdentity.derivedContentKey;
  } else if (room.state.provider || room.state.episode) {
    // Fallback to state fields if contentIdentity not set
    if (room.state.provider) {
      roomStateMessage.providerId = room.state.provider;
    }
    if (room.state.episode) {
      roomStateMessage.episodeId = room.state.episode;
    }
  }

  try {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(roomStateMessage));
    }
  } catch (error) {
    logger.warn(
      {
        error,
        roomId: ws.roomId,
        clientId: ws.clientId || undefined,
      },
      'Failed to send ROOM_STATE message to client'
    );
  }
}
