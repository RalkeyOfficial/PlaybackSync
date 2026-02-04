/**
 * WebSocket connection handler and manager
 * Handles WebSocket upgrade, connection lifecycle, and message routing
 */

import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import { logger, maskId } from '../utils/logger';
import { getConfig } from '../config';
import type { RoomId, ClientId } from '../types/ids';

/**
 * Map to track WebSocket connections by roomId
 * Key: roomId, Value: Set of ExtendedWebSocket connections
 */
const connectionsByRoom = new Map<RoomId, Set<ExtendedWebSocket>>();

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
  logger.info({ url: req.url }, 'WebSocket connection established');

  // Set up connection timeout - close if no JOIN received within timeout
  ws.joinTimeout = setTimeout(() => {
    if (ws.readyState === WebSocket.OPEN) {
      logger.warn('WebSocket connection closed due to JOIN timeout');
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

      // Handle JOIN message (will be implemented in Step 3.3)
      if (message.type === 'JOIN') {
        logger.info(
          {
            roomId: message.roomId,
            clientId: maskId(message.clientId),
          },
          'JOIN message received'
        );
        // TODO: Process JOIN message (Step 3.3)
        // For now, just store metadata and track connection
        const roomId = message.roomId as RoomId;
        ws.roomId = roomId;
        ws.clientId = message.clientId as ClientId;

        // Track connection by roomId
        if (!connectionsByRoom.has(roomId)) {
          connectionsByRoom.set(roomId, new Set());
        }
        connectionsByRoom.get(roomId)!.add(ws);
      } else {
        // Other message types will be handled in later steps
        logger.debug({ messageType: message.type }, 'Message received');
      }
    } catch (error) {
      logger.error({ error }, 'Error processing WebSocket message');
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
    // TODO: Remove client from room.connectedClients (Step 5.2)
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
