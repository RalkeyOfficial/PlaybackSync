/**
 * JOIN message handler
 * Handles client authentication and registration with a room
 */

import { logger } from '../utils/logger';
import { getConfig } from '../config';
import type { RoomId, ClientId } from '../types/ids';
import { toClientId } from '../types/ids';
import { verifyPassword } from '../utils/password';
import { validateMessage, formatValidationError } from '../utils/validation';
import { validateRoomForWebSocket } from '../utils/room-validation';
import type { JoinMessage } from '../types/messages';
import { RateLimiter } from '../utils/rate-limiter';
import { sendError, sendRoomState, type ExtendedWebSocket } from '../utils/message-helpers';
import { generateClientId } from '../utils/connection-helpers';

/**
 * Extended WebSocket interface with connection metadata
 * Re-exported here for use in join handler
 */
export interface ExtendedWebSocketWithRateLimit extends ExtendedWebSocket {
  /** Rate limiter state for this connection */
  rateLimiterState?: ReturnType<RateLimiter['createState']>;
}

/**
 * Map to track WebSocket connections by roomId
 * This will be passed in from the main websocket handler
 */
type ConnectionsByRoom = Map<RoomId, Set<ExtendedWebSocket>>;

/**
 * Handle JOIN message - authenticate client and register with room
 * @param ws - WebSocket connection
 * @param message - JOIN message from client
 * @param roomId - Room identifier
 * @param connectionsByRoom - Map of roomId to Set of WebSocket connections
 */
export function handleJoinMessage(
  ws: ExtendedWebSocketWithRateLimit,
  message: unknown,
  roomId: RoomId,
  connectionsByRoom: ConnectionsByRoom
): void {
  const config = getConfig();

  // Validate JOIN message schema
  const validation = validateMessage(message, 'JOIN');
  if (!validation.valid) {
    logger.warn(
      {
        roomId: roomId,
        errors: validation.errors,
      },
      'JOIN message validation failed'
    );
    sendError(
      ws,
      'INVALID_MESSAGE',
      `Message validation failed: ${formatValidationError(validation.errors || [])}`
    );
    ws.close(1003, 'Invalid JOIN message');
    return;
  }

  const joinMessage = message as JoinMessage;

  // Room existence already verified in handleConnection, but verify again in case room was deleted
  const room = validateRoomForWebSocket(roomId, ws);
  if (!room) {
    // Error already sent by validateRoomForWebSocket
    ws.close(1008, 'Room not found');
    return;
  }

  // Generate or use provided clientId for reconnection
  let clientId: ClientId;
  if (joinMessage.clientId) {
    // Client provided clientId for reconnection
    try {
      clientId = toClientId(joinMessage.clientId);
    } catch (error) {
      logger.warn(
        {
          roomId: roomId,
          clientId: joinMessage.clientId,
        },
        'JOIN failed: invalid clientId format'
      );
      sendError(ws, 'INVALID_MESSAGE', 'Invalid clientId format');
      ws.close(1003, 'Invalid clientId format');
      return;
    }
  } else {
    // Generate new clientId
    clientId = generateClientId();
  }

  // Verify password hash matches
  const passwordValid = verifyPassword(
    joinMessage.password,
    room.passwordHash,
    config.serverSecret
  );
  if (!passwordValid) {
    logger.warn(
      {
        roomId: roomId,
        clientId: clientId,
      },
      'JOIN failed: authentication failed'
    );
    sendError(ws, 'AUTH_FAILED', 'Invalid room or password');
    ws.close(1008, 'Authentication failed');
    return;
  }

  // Check for client tombstone (reconnection)
  const existingClient = room.connectedClients.get(clientId);
  const now = Date.now();
  let isReconnection = false;

  if (existingClient) {
    // Check if tombstone is still valid
    if (existingClient.tombstonedUntil && existingClient.tombstonedUntil > now) {
      // Valid tombstone - reattach connection
      isReconnection = true;
      existingClient.conn = ws;
      existingClient.lastSeen = now;
      existingClient.tombstonedUntil = undefined; // Clear tombstone
      logger.info(
        {
          roomId: roomId,
          clientId: clientId,
        },
        'Client reconnected with valid tombstone'
      );
    } else {
      // Tombstone expired or no tombstone - remove old entry
      room.connectedClients.delete(clientId);
    }
  }

  // Add client to room.connectedClients (or update if reconnection)
  if (!isReconnection) {
    room.connectedClients.set(clientId, {
      clientId,
      conn: ws,
      lastSeen: now,
    });
    logger.info(
      {
        roomId: roomId,
        clientId: clientId,
      },
      'Client joined room'
    );
  }

  // Store connection metadata
  ws.roomId = roomId;
  ws.clientId = clientId;

  // Initialize rate limiter for this connection
  const rateLimiter = new RateLimiter(config.rateLimitEventsPerSec);
  ws.rateLimiterState = rateLimiter.createState();

  // Track connection by roomId
  if (!connectionsByRoom.has(roomId)) {
    connectionsByRoom.set(roomId, new Set());
  }
  connectionsByRoom.get(roomId)!.add(ws);

  // Send current STATE to joining client (includes clientId)
  sendRoomState(ws, room, clientId);
}
