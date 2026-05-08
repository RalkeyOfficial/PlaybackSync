/**
 * BUFFER_START and BUFFER_END message handlers
 * Handles buffering state notifications from clients
 */

import { logger } from '../utils/logger';
import type { RoomId } from '../types/ids';
import { validateMessage, formatValidationError } from '../utils/validation';
import { validateRoomForWebSocket } from '../utils/room-validation';
import type { BufferStartMessage, BufferEndMessage } from '../types/messages';
import { sendError, sendRoomState, type ExtendedWebSocket } from '../utils/message-helpers';
import type { RateLimiterState } from '../utils/rate-limiter';

/**
 * Extended WebSocket interface with connection metadata
 */
export interface ExtendedWebSocketWithRateLimit extends ExtendedWebSocket {
  /** Rate limiter state for this connection */
  rateLimiterState?: RateLimiterState;
}

/**
 * Map to track WebSocket connections by roomId
 */
type ConnectionsByRoom = Map<RoomId, Set<ExtendedWebSocket>>;

/**
 * Handle BUFFER_START message - mark client as buffering (stop syncing)
 * @param ws - WebSocket connection
 * @param message - BUFFER_START message from client
 * @param roomId - Room identifier
 * @param connectionsByRoom - Map of roomId to Set of WebSocket connections
 */
export function handleBufferStartMessage(
  ws: ExtendedWebSocketWithRateLimit,
  message: unknown,
  roomId: RoomId,
  _connectionsByRoom: ConnectionsByRoom
): void {
  // Verify client is authenticated (has clientId)
  if (!ws.clientId) {
    logger.warn(
      {
        roomId: roomId,
      },
      'BUFFER_START message received before JOIN'
    );
    sendError(ws, 'NOT_AUTHENTICATED', 'Must join room before sending buffer start');
    return;
  }

  // Validate BUFFER_START message schema
  const validation = validateMessage(message, 'BUFFER_START');
  if (!validation.valid) {
    logger.warn(
      {
        roomId: roomId,
        clientId: ws.clientId,
        errors: validation.errors,
      },
      'BUFFER_START message validation failed'
    );
    sendError(
      ws,
      'INVALID_MESSAGE',
      `Message validation failed: ${formatValidationError(validation.errors || [])}`
    );
    return;
  }

  const bufferStartMessage = message as BufferStartMessage;

  // Validate room exists and is not expired
  const room = validateRoomForWebSocket(roomId, ws);
  if (!room) {
    // Error already sent by validateRoomForWebSocket
    return;
  }

  // Get client connection and mark as buffering
  const client = room.connectedClients.get(ws.clientId);
  if (client) {
    client.lastSeen = Date.now();
    client.isBuffering = true;

    logger.info(
      {
        roomId: roomId,
        clientId: ws.clientId,
        videoPos: bufferStartMessage.videoPos,
      },
      'Client marked as buffering - server will stop syncing this client'
    );
  } else {
    logger.warn(
      {
        roomId: roomId,
        clientId: ws.clientId,
      },
      'BUFFER_START received but client not found in room'
    );
  }
}

/**
 * Handle BUFFER_END message - unmark client as buffering and send ROOM_STATE update
 * @param ws - WebSocket connection
 * @param message - BUFFER_END message from client
 * @param roomId - Room identifier
 * @param connectionsByRoom - Map of roomId to Set of WebSocket connections
 */
export function handleBufferEndMessage(
  ws: ExtendedWebSocketWithRateLimit,
  message: unknown,
  roomId: RoomId,
  _connectionsByRoom: ConnectionsByRoom
): void {
  // Verify client is authenticated (has clientId)
  if (!ws.clientId) {
    logger.warn(
      {
        roomId: roomId,
      },
      'BUFFER_END message received before JOIN'
    );
    sendError(ws, 'NOT_AUTHENTICATED', 'Must join room before sending buffer end');
    return;
  }

  // Validate BUFFER_END message schema
  const validation = validateMessage(message, 'BUFFER_END');
  if (!validation.valid) {
    logger.warn(
      {
        roomId: roomId,
        clientId: ws.clientId,
        errors: validation.errors,
      },
      'BUFFER_END message validation failed'
    );
    sendError(
      ws,
      'INVALID_MESSAGE',
      `Message validation failed: ${formatValidationError(validation.errors || [])}`
    );
    return;
  }

  const bufferEndMessage = message as BufferEndMessage;

  // Validate room exists and is not expired
  const room = validateRoomForWebSocket(roomId, ws);
  if (!room) {
    // Error already sent by validateRoomForWebSocket
    return;
  }

  // Get client connection and unmark as buffering
  const client = room.connectedClients.get(ws.clientId);
  if (client) {
    client.lastSeen = Date.now();
    client.isBuffering = false;

    logger.info(
      {
        roomId: roomId,
        clientId: ws.clientId,
        videoPos: bufferEndMessage.videoPos,
      },
      'Client buffering ended - server can re-try syncing and sending room state update'
    );

    // Send ROOM_STATE update to client with current room state
    // This allows the client to sync up after buffering
    sendRoomState(ws, room, ws.clientId, client.lastEventId);
  } else {
    logger.warn(
      {
        roomId: roomId,
        clientId: ws.clientId,
      },
      'BUFFER_END received but client not found in room'
    );
  }
}
