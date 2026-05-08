/**
 * WebSocket message sending utilities
 * Helper functions for sending messages to WebSocket clients
 */

import { WebSocket } from 'ws';
import { logger } from './logger';
import type { RoomId, ClientId } from '../types/ids';
import type { ErrorMessage, RoomStateMessage, ContentMismatchMessage } from '../types/messages';
import type { Room } from '../types/room';
import { getCurrentVideoPos } from './drift-reconciliation';

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
 * Send a CONTENT_MISMATCH message to a WebSocket client
 * Sent when a client's content identity doesn't match the room's content identity
 */
export function sendContentMismatch(
  ws: ExtendedWebSocket,
  expectedContentKey: string,
  reportedContentKey?: string
): void {
  const contentMismatchMessage: ContentMismatchMessage = {
    type: 'CONTENT_MISMATCH',
    expectedContentKey,
    reportedContentKey,
    server_ts: Date.now(),
  };

  try {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(contentMismatchMessage));
    }
  } catch (error) {
    logger.warn(
      {
        error,
        roomId: ws.roomId,
        clientId: ws.clientId || undefined,
      },
      'Failed to send CONTENT_MISMATCH message to client'
    );
  }
}

/**
 * Send a ROOM_STATE message to a WebSocket client
 * According to backend_network_design_v1.md section 7: includes recentEvents[] since lastEventId for event replay
 * @param ws - WebSocket connection
 * @param room - Room object containing state and event log
 * @param clientId - Client identifier
 * @param lastKnownEventId - Optional: client's last known eventId for event replay filtering
 */
export function sendRoomState(
  ws: ExtendedWebSocket,
  room: Room,
  clientId: ClientId,
  lastKnownEventId?: number
): void {
  const roomStateMessage: RoomStateMessage = {
    type: 'ROOM_STATE',
    clientId,
    playerState: room.state.playerState,
    videoPos: getCurrentVideoPos(room),
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

  // Include recent events for event replay if client provided lastKnownEventId
  // According to backend_network_design_v1.md section 7:
  // "Request ROOM_STATE; server returns { videoPos, playerState, lastEventId } and any recentEvents[] since lastEventId"
  if (lastKnownEventId !== undefined && room.eventLog.length > 0) {
    // Filter events that occurred after client's last known eventId
    // Events are stored in eventId order (monotonically increasing)
    const recentEvents = room.eventLog.filter(event => event.eventId > lastKnownEventId);

    if (recentEvents.length > 0) {
      // Sort by eventId to ensure correct order (should already be sorted, but be safe)
      recentEvents.sort((a, b) => a.eventId - b.eventId);

      roomStateMessage.recentEvents = recentEvents.map(event => ({
        type: event.type,
        value: event.value,
        clientId: event.clientId,
        ts: event.ts,
        eventId: event.eventId,
      }));
    }
  }

  try {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(roomStateMessage));
      logger.debug(
        {
          roomId: ws.roomId,
          clientId,
          lastEventId: room.state.eventId,
          recentEventsCount: roomStateMessage.recentEvents?.length || 0,
        },
        'ROOM_STATE sent to client'
      );
    } else {
      logger.debug(
        {
          roomId: ws.roomId,
          clientId,
          readyState: ws.readyState,
        },
        'Skipping ROOM_STATE send: connection not ready'
      );
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
