/**
 * WebSocket broadcasting utilities
 * Functions for broadcasting messages to all clients in a room
 */

import { WebSocket } from 'ws';
import { logger } from './logger';
import { getConfig } from '../config';
import { RateLimiter } from './rate-limiter';
import { rateLimitedTotal } from './metrics';
import type { RoomId } from '../types/ids';
import type { StateMessage, EpisodeChangeMessage } from '../types/messages';
import type { Room } from '../types/room';

/**
 * Per-room broadcast rate limiter state
 * Tracks broadcast rate for each room to prevent DoS
 */
const roomBroadcastRateLimiters = new Map<RoomId, ReturnType<RateLimiter['createState']>>();

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
 * Includes rate limiting to prevent broadcast floods
 * @param room - Room to broadcast to
 * @param connectionsByRoom - Map of roomId to Set of WebSocket connections
 */
export function broadcastState(
  room: Room,
  connectionsByRoom: Map<RoomId, Set<ExtendedWebSocket>>
): void {
  const config = getConfig();

  // Check broadcast rate limit per room
  let rateLimiterState = roomBroadcastRateLimiters.get(room.roomId);
  if (!rateLimiterState) {
    // Initialize rate limiter for this room
    const rateLimiter = new RateLimiter(config.maxBroadcastRatePerSec);
    rateLimiterState = rateLimiter.createState();
    roomBroadcastRateLimiters.set(room.roomId, rateLimiterState);
  }

  const rateLimiter = new RateLimiter(config.maxBroadcastRatePerSec);
  if (!rateLimiter.check(rateLimiterState)) {
    logger.warn(
      {
        roomId: room.roomId,
      },
      'Broadcast rate limit exceeded for room'
    );
    rateLimitedTotal.inc({ type: 'broadcast' });
    // Still allow broadcast but log the violation
    // This prevents DoS while allowing legitimate high-frequency updates
  }

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
    logger.debug({ roomId: room.roomId }, 'No connections to broadcast STATE to');
    return;
  }

  let successCount = 0;
  let failureCount = 0;

  for (const ws of roomConnections) {
    try {
      if (ws.readyState === WebSocket.OPEN && ws.clientId) {
        ws.send(JSON.stringify(stateMessage));
        successCount++;
      } else {
        logger.debug(
          {
            roomId: room.roomId,
            clientId: ws.clientId || undefined,
            readyState: ws.readyState,
          },
          'Skipping STATE broadcast: connection not ready or missing clientId'
        );
      }
    } catch (error) {
      failureCount++;
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

  logger.debug(
    {
      roomId: room.roomId,
      eventId: room.state.eventId,
      successCount,
      failureCount,
      totalConnections: roomConnections.size,
    },
    'STATE broadcast completed'
  );
}

/**
 * Broadcast EPISODE_CHANGE message to all connected clients in a room
 * Includes rate limiting to prevent broadcast floods
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

  const config = getConfig();

  // Check broadcast rate limit per room
  let rateLimiterState = roomBroadcastRateLimiters.get(room.roomId);
  if (!rateLimiterState) {
    // Initialize rate limiter for this room
    const rateLimiter = new RateLimiter(config.maxBroadcastRatePerSec);
    rateLimiterState = rateLimiter.createState();
    roomBroadcastRateLimiters.set(room.roomId, rateLimiterState);
  }

  const rateLimiter = new RateLimiter(config.maxBroadcastRatePerSec);
  if (!rateLimiter.check(rateLimiterState)) {
    logger.warn(
      {
        roomId: room.roomId,
      },
      'Broadcast rate limit exceeded for room'
    );
    rateLimitedTotal.inc({ type: 'broadcast' });
    // Still allow broadcast but log the violation
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
    logger.debug({ roomId: room.roomId }, 'No connections to broadcast EPISODE_CHANGE to');
    return;
  }

  let successCount = 0;
  let failureCount = 0;

  for (const ws of roomConnections) {
    try {
      if (ws.readyState === WebSocket.OPEN && ws.clientId) {
        ws.send(JSON.stringify(episodeChangeMessage));
        successCount++;
      } else {
        logger.debug(
          {
            roomId: room.roomId,
            clientId: ws.clientId || undefined,
            readyState: ws.readyState,
          },
          'Skipping EPISODE_CHANGE broadcast: connection not ready or missing clientId'
        );
      }
    } catch (error) {
      failureCount++;
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

  logger.debug(
    {
      roomId: room.roomId,
      eventId: room.state.eventId,
      episodeId: room.contentIdentity.episodeId,
      successCount,
      failureCount,
      totalConnections: roomConnections.size,
    },
    'EPISODE_CHANGE broadcast completed'
  );
}

/**
 * Clean up broadcast rate limiter state for a room
 * Should be called when a room is deleted
 * @param roomId - Room identifier
 */
export function cleanupBroadcastRateLimiter(roomId: RoomId): void {
  roomBroadcastRateLimiters.delete(roomId);
}
