/**
 * WebSocket connection handler and manager
 * Handles WebSocket upgrade, connection lifecycle, and message routing
 */

import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import { logger } from '../utils/logger';
import { getConfig } from '../config';
import type { RoomId, ClientId } from '../types/ids';
import { getRoom } from '../storage/rooms';
import { validateRoomForConnection } from '../utils/room-validation';
import { extractRoomIdFromUrl } from '../utils/connection-helpers';
import { handleJoinMessage } from './join';
import { handleEventMessage } from './event';
import { handleEpisodeChangeRequest } from './episode-change';
import { handleHeartbeatMessage } from './heartbeat';
import type { RateLimiterState } from '../utils/rate-limiter';

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
  /** Rate limiter state for this connection */
  rateLimiterState?: RateLimiterState;
}

/**
 * Map to track WebSocket connections by roomId
 * Key: roomId, Value: Set of ExtendedWebSocket connections
 */
export const connectionsByRoom = new Map<RoomId, Set<ExtendedWebSocket>>();

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
  const room = validateRoomForConnection(roomId, ws);
  if (!room) {
    // Connection already closed by validateRoomForConnection
    return;
  }

  // Store roomId on connection for later use
  ws.roomId = roomId;

  logger.info({ url: req.url, roomId: roomId }, 'WebSocket connection established');

  // Set up connection timeout - close if no JOIN received within timeout
  ws.joinTimeout = setTimeout(() => {
    if (ws.readyState === WebSocket.OPEN) {
      logger.warn({ roomId: roomId }, 'WebSocket connection closed due to JOIN timeout');
      ws.close(1008, 'JOIN timeout - no JOIN message received');
    }
  }, config.joinTimeoutMs);

  // Set up message event handler
  ws.on('message', (data: Buffer) => {
    try {
      const messageStr = data.toString('utf-8');
      const message = JSON.parse(messageStr);

      // Handle JOIN message
      if (message.type === 'JOIN') {
        // Clear JOIN timeout only when JOIN message is received
        if (ws.joinTimeout) {
          clearTimeout(ws.joinTimeout);
          ws.joinTimeout = undefined;
        }
        handleJoinMessage(ws, message, roomId, connectionsByRoom);
      } else if (message.type === 'EVENT') {
        // Handle EVENT message (play/pause/seek)
        handleEventMessage(ws, message, roomId, connectionsByRoom);
      } else if (message.type === 'EPISODE_CHANGE_REQUEST') {
        // Handle EPISODE_CHANGE_REQUEST message
        handleEpisodeChangeRequest(ws, message, roomId, connectionsByRoom);
      } else if (message.type === 'HEARTBEAT') {
        // Handle HEARTBEAT message for drift detection
        handleHeartbeatMessage(ws, message, roomId, connectionsByRoom);
      } else {
        // Other message types will be handled in later steps
        logger.debug({ messageType: message.type, roomId }, 'Message received');
      }
    } catch (error) {
      logger.error({ error, roomId: ws.roomId || undefined }, 'Error processing WebSocket message');
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
        clientId: ws.clientId || undefined,
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
          // Store last event ID the client saw for event replay on reconnection
          // According to backend_network_design_v1.md section 7: server returns recentEvents[] since lastEventId
          client.lastEventId = room.state.eventId;
          // Note: conn remains pointing to closed connection, which is fine
          // The tombstone allows reconnection with same clientId
          logger.info(
            {
              roomId: ws.roomId,
              clientId: ws.clientId,
              tombstonedUntil: client.tombstonedUntil,
              lastEventId: client.lastEventId,
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
        clientId: ws.clientId || undefined,
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

  logger.info({ roomId }, 'Closing WebSocket connections for room');

  // Close all connections for this room
  for (const ws of roomConnections) {
    try {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close(1001, 'Room deleted');
      }
    } catch (error) {
      logger.warn(
        {
          roomId: roomId,
          clientId: ws.clientId || undefined,
          error,
        },
        'Failed to close WebSocket connection during room deletion'
      );
    }
  }

  // Remove room from tracking
  connectionsByRoom.delete(roomId);
}
