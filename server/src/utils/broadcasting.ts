/**
 * WebSocket broadcasting utilities
 * Functions for broadcasting messages to all clients in a room
 */

import { WebSocket } from 'ws';
import { logger } from './logger';
import type { RoomId } from '../types/ids';
import type { StateMessage, EpisodeChangeMessage } from '../types/messages';
import type { Room } from '../types/room';

/**
 * Extended WebSocket interface with connection metadata
 */
export interface ExtendedWebSocket extends WebSocket {
  /** Room ID this connection belongs to (set after JOIN) */
  roomId?: RoomId;
  /** Client ID for this connection (set after JOIN) */
  clientId?: string;
}

/**
 * Broadcast STATE message to all connected clients in a room
 * @param room - Room to broadcast to
 * @param connectionsByRoom - Map of roomId to Set of WebSocket connections
 */
export function broadcastState(
  room: Room,
  connectionsByRoom: Map<RoomId, Set<ExtendedWebSocket>>
): void {
  const now = Date.now();
  const stateMessage: StateMessage = {
    type: 'STATE',
    paused: room.state.paused,
    time: room.state.time,
    server_ts: now,
    eventId: room.state.eventId,
  };

  // Add optional fields if they exist
  if (room.state.provider) {
    stateMessage.provider = room.state.provider;
  }
  if (room.state.episode) {
    stateMessage.episode = room.state.episode;
  }

  // Broadcast to all connected clients
  const roomConnections = connectionsByRoom.get(room.roomId);
  if (!roomConnections) {
    return;
  }

  for (const ws of roomConnections) {
    try {
      if (ws.readyState === WebSocket.OPEN && ws.clientId) {
        ws.send(JSON.stringify(stateMessage));
      }
    } catch (error) {
      logger.warn(
        {
          error,
          roomId: room.roomId,
          clientId: ws.clientId || undefined,
        },
        'Failed to send STATE message to client'
      );
    }
  }
}

/**
 * Broadcast EPISODE_CHANGE message to all connected clients in a room
 * @param room - Room to broadcast to
 * @param connectionsByRoom - Map of roomId to Set of WebSocket connections
 */
export function broadcastEpisodeChange(
  room: Room,
  connectionsByRoom: Map<RoomId, Set<ExtendedWebSocket>>
): void {
  if (!room.contentIdentity) {
    logger.warn({ roomId: room.roomId }, 'Cannot broadcast EPISODE_CHANGE: no contentIdentity');
    return;
  }

  const now = Date.now();
  const episodeChangeMessage: EpisodeChangeMessage = {
    type: 'EPISODE_CHANGE',
    eventId: room.state.eventId,
    episodeId: room.contentIdentity.episodeId,
    providerId: room.contentIdentity.providerId,
    derivedContentKey: room.contentIdentity.derivedContentKey,
    server_ts: now,
  };

  // Broadcast to all connected clients
  const roomConnections = connectionsByRoom.get(room.roomId);
  if (!roomConnections) {
    return;
  }

  for (const ws of roomConnections) {
    try {
      if (ws.readyState === WebSocket.OPEN && ws.clientId) {
        ws.send(JSON.stringify(episodeChangeMessage));
      }
    } catch (error) {
      logger.warn(
        {
          error,
          roomId: room.roomId,
          clientId: ws.clientId || undefined,
        },
        'Failed to send EPISODE_CHANGE message to client'
      );
    }
  }
}
