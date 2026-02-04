/**
 * WebSocket connection handler and manager
 * Handles WebSocket upgrade, connection lifecycle, and message routing
 */

import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import { randomUUID } from 'crypto';
import { logger, maskId } from '../utils/logger';
import { getConfig } from '../config';
import type { RoomId, ClientId } from '../types/ids';
import { toRoomId, toClientId, isValidUuid } from '../types/ids';
import { getRoom, isRoomExpired } from '../storage/rooms';
import { verifyPassword } from '../utils/password';
import { validateMessage, formatValidationError } from '../utils/validation';
import type { JoinMessage, RoomStateMessage, ErrorMessage } from '../types/messages';
import type { Room } from '../types/room';

/**
 * Map to track WebSocket connections by roomId
 * Key: roomId, Value: Set of ExtendedWebSocket connections
 */
const connectionsByRoom = new Map<RoomId, Set<ExtendedWebSocket>>();

/**
 * Send an ERROR message to a WebSocket client
 */
function sendError(ws: ExtendedWebSocket, code: string, message: string): void {
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
        clientId: ws.clientId ? maskId(ws.clientId) : undefined,
        code,
      },
      'Failed to send ERROR message to client'
    );
  }
}

/**
 * Generate a new client ID (UUID v4)
 */
function generateClientId(): ClientId {
  return randomUUID() as ClientId;
}

/**
 * Extract roomId from WebSocket URL path
 * Expected format: /{roomId} or /{roomId}?query=params
 */
function extractRoomIdFromUrl(url: string | undefined): RoomId | null {
  if (!url) {
    return null;
  }

  // Remove query string and hash if present
  const path = url.split('?')[0].split('#')[0];

  // Extract roomId from path (should be /{roomId})
  const match = path.match(/^\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  if (!match || !match[1]) {
    return null;
  }

  const roomIdString = match[1];
  if (!isValidUuid(roomIdString)) {
    return null;
  }

  return toRoomId(roomIdString);
}

/**
 * Send a ROOM_STATE message to a WebSocket client
 */
function sendRoomState(ws: ExtendedWebSocket, room: Room, clientId: ClientId): void {
  const roomStateMessage: RoomStateMessage = {
    type: 'ROOM_STATE',
    clientId,
    paused: room.state.paused,
    time: room.state.time,
    lastEventId: room.state.eventId,
    serverTime: Date.now(),
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
        clientId: ws.clientId ? maskId(ws.clientId) : undefined,
      },
      'Failed to send ROOM_STATE message to client'
    );
  }
}

/**
 * Handle JOIN message - authenticate client and register with room
 */
function handleJoinMessage(ws: ExtendedWebSocket, message: unknown, roomId: RoomId): void {
  const config = getConfig();

  // Validate JOIN message schema
  const validation = validateMessage(message, 'JOIN');
  if (!validation.valid) {
    logger.warn(
      {
        roomId: maskId(roomId),
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
  const room = getRoom(roomId);
  if (!room) {
    logger.warn(
      {
        roomId: maskId(roomId),
      },
      'JOIN failed: room not found (room may have been deleted)'
    );
    sendError(ws, 'ROOM_NOT_FOUND', 'Room not found');
    ws.close(1008, 'Room not found');
    return;
  }

  if (isRoomExpired(room)) {
    logger.warn(
      {
        roomId: maskId(roomId),
      },
      'JOIN failed: room not found'
    );
    sendError(ws, 'ROOM_NOT_FOUND', 'Room not found');
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
          roomId: maskId(roomId),
          clientId: maskId(joinMessage.clientId),
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
        roomId: maskId(roomId),
        clientId: maskId(clientId),
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
          roomId: maskId(roomId),
          clientId: maskId(clientId),
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
        roomId: maskId(roomId),
        clientId: maskId(clientId),
      },
      'Client joined room'
    );
  }

  // Store connection metadata
  ws.roomId = roomId;
  ws.clientId = clientId;

  // Track connection by roomId
  if (!connectionsByRoom.has(roomId)) {
    connectionsByRoom.set(roomId, new Set());
  }
  connectionsByRoom.get(roomId)!.add(ws);

  // Send current STATE to joining client (includes clientId)
  sendRoomState(ws, room, clientId);
}

/**
 * Extended WebSocket interface with connection metadata
 */
export interface ExtendedWebSocket extends WebSocket {
  /** Room ID this connection belongs to (set after JOIN) */
  roomId?: RoomId;
  /** Client ID for this connection (set after JOIN) */
  clientId?: ClientId;
  /** Timeout timer for JOIN message */
  joinTimeout?: NodeJS.Timeout;
}

/**
 * Handle WebSocket connection upgrade
 * Sets up event handlers and connection timeout
 * Exported for testing purposes
 */
export function handleConnection(ws: ExtendedWebSocket, req: { url?: string }): void {
  const config = getConfig();

  // Extract roomId from URL path
  const roomId = extractRoomIdFromUrl(req.url);
  if (!roomId) {
    logger.warn(
      { url: req.url },
      'WebSocket connection rejected: invalid or missing roomId in URL'
    );
    ws.close(1008, 'Invalid roomId in URL path');
    return;
  }

  // Verify room exists and is not expired before accepting connection
  const room = getRoom(roomId);
  if (!room) {
    logger.warn({ roomId: maskId(roomId) }, 'WebSocket connection rejected: room not found');
    ws.close(1008, 'Room not found');
    return;
  }

  if (isRoomExpired(room)) {
    logger.warn({ roomId: maskId(roomId) }, 'WebSocket connection rejected: room expired');
    ws.close(1008, 'Room not found');
    return;
  }

  // Store roomId on connection for later use
  ws.roomId = roomId;

  logger.info({ url: req.url, roomId: maskId(roomId) }, 'WebSocket connection established');

  // Set up connection timeout - close if no JOIN received within timeout
  ws.joinTimeout = setTimeout(() => {
    if (ws.readyState === WebSocket.OPEN) {
      logger.warn({ roomId: maskId(roomId) }, 'WebSocket connection closed due to JOIN timeout');
      ws.close(1008, 'JOIN timeout - no JOIN message received');
    }
  }, config.joinTimeoutMs);

  // Set up message event handler
  ws.on('message', (data: Buffer) => {
    try {
      // Clear JOIN timeout if message received (will be validated as JOIN later)
      if (ws.joinTimeout) {
        clearTimeout(ws.joinTimeout);
        ws.joinTimeout = undefined;
      }

      const messageStr = data.toString('utf-8');
      const message = JSON.parse(messageStr);

      // Handle JOIN message
      if (message.type === 'JOIN') {
        handleJoinMessage(ws, message, roomId);
      } else {
        // Other message types will be handled in later steps
        logger.debug({ messageType: message.type, roomId: maskId(roomId) }, 'Message received');
      }
    } catch (error) {
      logger.error(
        { error, roomId: ws.roomId ? maskId(ws.roomId) : undefined },
        'Error processing WebSocket message'
      );
      if (ws.readyState === WebSocket.OPEN) {
        ws.close(1003, 'Invalid message format');
      }
    }
  });

  // Set up close event handler
  ws.on('close', (code: number, reason: Buffer) => {
    const reasonStr = reason ? reason.toString('utf-8') : '';
    logger.info(
      {
        code,
        reason: reasonStr,
        roomId: ws.roomId,
        clientId: ws.clientId ? maskId(ws.clientId) : undefined,
      },
      'WebSocket connection closed'
    );

    // Clean up timeout if still active
    if (ws.joinTimeout) {
      clearTimeout(ws.joinTimeout);
      ws.joinTimeout = undefined;
    }

    // Remove connection from tracking
    if (ws.roomId) {
      const roomConnections = connectionsByRoom.get(ws.roomId);
      if (roomConnections) {
        roomConnections.delete(ws);
        // Clean up empty sets
        if (roomConnections.size === 0) {
          connectionsByRoom.delete(ws.roomId);
        }
      }
    }

    // Clean up connection metadata
    // Create tombstone for client reconnection if client was registered
    if (ws.roomId && ws.clientId) {
      const room = getRoom(ws.roomId);
      if (room) {
        const client = room.connectedClients.get(ws.clientId);
        if (client && client.conn === ws) {
          // Create tombstone for reconnection
          const config = getConfig();
          client.tombstonedUntil = Date.now() + config.clientTombstoneMs;
          // Note: conn remains pointing to closed connection, which is fine
          // The tombstone allows reconnection with same clientId
          logger.info(
            {
              roomId: maskId(ws.roomId),
              clientId: maskId(ws.clientId),
              tombstonedUntil: client.tombstonedUntil,
            },
            'Client disconnected, tombstone created'
          );
        }
      }
    }
  });

  // Set up error event handler
  ws.on('error', (error: Error) => {
    logger.error(
      {
        error,
        roomId: ws.roomId,
        clientId: ws.clientId ? maskId(ws.clientId) : undefined,
      },
      'WebSocket connection error'
    );

    // Close connection on error
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close(1011, 'Internal server error');
    }
  });
}

/**
 * Set up WebSocket server and upgrade handler for Fastify
 * @param server - Fastify server instance
 */
export function setupWebSocketServer(server: {
  server?: {
    on: (
      event: 'upgrade',
      handler: (request: IncomingMessage, socket: Duplex, head: Buffer) => void
    ) => void;
  };
}): void {
  // Create WebSocket server
  const wss = new WebSocketServer({
    noServer: true,
  });

  // Handle HTTP upgrade requests
  // Access the underlying Node.js server from Fastify
  const nodeServer = server.server;
  if (nodeServer) {
    nodeServer.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      wss.handleUpgrade(request, socket, head, (ws: WebSocket) => {
        handleConnection(ws as ExtendedWebSocket, request);
      });
    });
  }

  logger.info('WebSocket server initialized');
}

/**
 * Close all WebSocket connections for a specific room
 * Used when a room is deleted via DELETE /api/rooms/:roomId
 * @param roomId - Room identifier
 */
export function closeConnectionsForRoom(roomId: RoomId): void {
  const roomConnections = connectionsByRoom.get(roomId);
  if (!roomConnections) {
    return;
  }

  logger.info({ roomId: maskId(roomId) }, 'Closing WebSocket connections for room');

  // Close all connections for this room
  for (const ws of roomConnections) {
    try {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close(1001, 'Room deleted');
      }
    } catch (error) {
      logger.warn(
        {
          roomId: maskId(roomId),
          clientId: ws.clientId ? maskId(ws.clientId) : undefined,
          error,
        },
        'Failed to close WebSocket connection during room deletion'
      );
    }
  }

  // Remove room from tracking
  connectionsByRoom.delete(roomId);
}
