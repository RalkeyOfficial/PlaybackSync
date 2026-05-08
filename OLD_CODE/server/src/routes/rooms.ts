/**
 * Room management API endpoints
 */

import { FastifyPluginAsync } from 'fastify';
import crypto from 'crypto';
import { WebSocket } from 'ws';
import { getConfig } from '../config';
import { logger } from '../utils/logger';
import { hashPassword } from '../utils/password';
import { createRoom, listActiveRooms, deleteRoom } from '../storage/rooms';
import { toRoomId, toClientId } from '../types/ids';
import { closeRoomConnections } from '../utils/room-cleanup';
import { closeConnectionsForRoom, connectionsByRoom } from '../handlers/websocket';
import { roomValidationPreHandler } from '../utils/room-validation';
import { getCurrentVideoPos } from '../utils/drift-reconciliation';

/**
 * Generate a random alphanumeric password
 * @param length - Password length (default: 16)
 * @returns Random password string
 */
function generatePassword(length = 16): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let password = '';
  for (let i = 0; i < length; i++) {
    password += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return password;
}

/**
 * Generate UUID v4 using Node.js crypto.randomUUID() (available in Node 14.17.0+)
 * Falls back to manual generation if not available
 */
function generateRoomId(): string {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback for older Node.js versions
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Build share link for a room
 * @param roomId - Room identifier
 * @param hostname - Optional hostname from config
 * @returns Share link (relative path or full URL)
 */
function buildShareLink(roomId: string, hostname?: string): string {
  if (hostname) {
    return `https://${hostname}/${roomId}`;
  }
  return `/${roomId}`;
}

/**
 * Request body schema for POST /admin/api/rooms
 */
const createRoomSchema = {
  type: 'object',
  properties: {
    ttl: {
      type: 'number',
      minimum: 1,
    },
    targetUrl: {
      type: 'string',
      format: 'uri',
    },
    name: {
      type: 'string',
    },
  },
  required: ['targetUrl'],
  additionalProperties: false,
} as const;

/**
 * Response schema for POST /admin/api/rooms
 */
const createRoomResponseSchema = {
  type: 'object',
  properties: {
    roomId: { type: 'string' },
    password: { type: 'string' },
    shareLink: { type: 'string' },
  },
  required: ['roomId', 'password', 'shareLink'],
} as const;

/**
 * Response schema for GET /admin/api/rooms
 */
const listRoomsResponseSchema = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      createdAt: { type: 'number' },
      participantCount: { type: 'number' },
      expiresAt: { type: 'number' },
      name: { type: 'string' },
      last_state: {
        type: 'object',
        properties: {
          playerState: { type: 'string', enum: ['playing', 'paused'] },
          videoPos: { type: 'number' },
          provider: { type: 'string' },
          episode: { type: 'number' },
          last_explicit_event_ts: { type: 'number' },
          last_state_update_ts: { type: 'number' },
          eventId: { type: 'number' },
        },
        required: [
          'playerState',
          'videoPos',
          'provider',
          'episode',
          'last_explicit_event_ts',
          'last_state_update_ts',
          'eventId',
        ],
      },
    },
    required: ['id', 'createdAt', 'participantCount', 'expiresAt', 'last_state'],
  },
} as const;

/**
 * Response schema for GET /admin/api/rooms/:roomId
 */
const getRoomDetailsResponseSchema = {
  type: 'object',
  properties: {
    roomId: { type: 'string' },
    createdAt: { type: 'number' },
    expiresAt: { type: 'number' },
    targetUrl: { type: 'string' },
    name: { type: 'string' },
    state: {
      type: 'object',
      properties: {
        playerState: { type: 'string', enum: ['playing', 'paused'] },
        videoPos: { type: 'number' },
        provider: { type: 'string' },
        episode: { type: 'number' },
        eventId: { type: 'number' },
        last_explicit_event_ts: { type: 'number' },
        last_state_update_ts: { type: 'number' },
      },
      required: [
        'playerState',
        'videoPos',
        'provider',
        'episode',
        'eventId',
        'last_explicit_event_ts',
        'last_state_update_ts',
      ],
    },
    connectedClients: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          clientId: { type: 'string' },
          lastSeen: { type: 'number' },
          tombstonedUntil: { type: 'number' },
        },
        required: ['clientId', 'lastSeen'],
      },
    },
    recentEvents: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string' },
          value: { oneOf: [{ type: 'number' }, { type: 'string' }] },
          clientId: { type: 'string' },
          ts: { type: 'number' },
          eventId: { type: 'number' },
        },
        required: ['type', 'ts', 'eventId'],
      },
    },
  },
  required: [
    'roomId',
    'createdAt',
    'expiresAt',
    'targetUrl',
    'state',
    'connectedClients',
    'recentEvents',
  ],
} as const;

/**
 * Rooms API plugin
 */
const roomsPlugin: FastifyPluginAsync = async fastify => {
  // Load config lazily when plugin is registered (after env vars are set)
  const config = getConfig();

  /**
   * POST /admin/api/rooms - Create a new room
   */
  fastify.post<{ Body: { ttl?: number; targetUrl: string; name?: string } }>(
    '/admin/api/rooms',
    {
      schema: {
        body: createRoomSchema,
        response: {
          201: createRoomResponseSchema,
        },
      },
    },
    async (request, reply) => {
      // Generate room ID (UUID v4)
      const roomIdString = generateRoomId();
      const roomId = toRoomId(roomIdString);

      // Generate random password
      const password = generatePassword();

      // Hash password using HMAC-SHA256
      const passwordHash = hashPassword(password, config.serverSecret);

      // Get TTL from request or use default from config
      const ttlSeconds = request.body.ttl ?? config.roomTtlSeconds;

      // Extract targetUrl from request (required)
      const targetUrl = request.body.targetUrl;

      // Extract name from request (optional)
      const name = request.body.name;

      // Create room in storage
      createRoom(roomId, passwordHash, ttlSeconds, targetUrl, name);

      // Build share link
      const shareLink = buildShareLink(roomIdString, config.hostname);

      // Log room creation with structured logging
      logger.info(
        {
          roomId,
          ttl: ttlSeconds,
          targetUrl,
          name,
          hostname: config.hostname,
        },
        'room.created'
      );

      // Return room credentials (password only returned once on creation)
      return reply.code(201).send({
        roomId: roomIdString,
        password,
        shareLink,
      });
    }
  );

  /**
   * GET /admin/api/rooms - List all active rooms
   */
  fastify.get(
    '/admin/api/rooms',
    {
      schema: {
        response: {
          200: listRoomsResponseSchema,
        },
      },
    },
    async () => {
      const rooms = listActiveRooms();

      // Log room list access
      logger.debug({ roomCount: rooms.length }, 'Room list requested');

      // Transform to response format (convert RoomId to string)
      return rooms.map(room => ({
        id: room.id as string,
        createdAt: room.createdAt,
        participantCount: room.participantCount,
        expiresAt: room.expiresAt,
        ...(room.name !== undefined && { name: room.name }),
        last_state: room.last_state,
      }));
    }
  );

  /**
   * GET /admin/api/rooms/:roomId - Get room details
   */
  fastify.get<{ Params: { roomId: string } }>(
    '/admin/api/rooms/:roomId',
    {
      schema: {
        params: {
          type: 'object',
          properties: {
            roomId: {
              type: 'string',
              pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
              description: 'UUID v4 format',
            },
          },
          required: ['roomId'],
        },
        response: {
          200: getRoomDetailsResponseSchema,
        },
      },
      preHandler: roomValidationPreHandler,
    },
    async (request, reply) => {
      // Room is validated and attached to request by preHandler
      const room = request.room!;

      logger.debug(
        {
          roomId: room.roomId,
          participantCount: room.connectedClients.size,
          eventLogSize: room.eventLog.length,
        },
        'Room details requested'
      );

      // Transform connectedClients Map to array (exclude WebSocket conn object)
      const connectedClients = Array.from(room.connectedClients.values()).map(client => ({
        clientId: client.clientId as string,
        lastSeen: client.lastSeen,
        ...(client.tombstonedUntil !== undefined && { tombstonedUntil: client.tombstonedUntil }),
      }));

      // Return room details (exclude passwordHash)
      // Use getCurrentVideoPos to ensure API returns expected_time when playing
      const currentState = {
        ...room.state,
        videoPos: getCurrentVideoPos(room),
      };
      return reply.code(200).send({
        roomId: room.roomId as string,
        createdAt: room.createdAt,
        expiresAt: room.expiresAt,
        targetUrl: room.targetUrl,
        ...(room.name !== undefined && { name: room.name }),
        state: currentState,
        connectedClients,
        recentEvents: room.eventLog,
      });
    }
  );

  /**
   * DELETE /admin/api/rooms/:roomId - Delete room and close connections
   */
  fastify.delete<{ Params: { roomId: string } }>(
    '/admin/api/rooms/:roomId',
    {
      schema: {
        params: {
          type: 'object',
          properties: {
            roomId: {
              type: 'string',
              pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
              description: 'UUID v4 format',
            },
          },
          required: ['roomId'],
        },
      },
      preHandler: roomValidationPreHandler,
    },
    async (request, reply) => {
      // Room is validated and attached to request by preHandler
      const room = request.room!;
      const { roomId: roomIdString } = request.params;
      const roomId = toRoomId(roomIdString);

      // Close all WebSocket connections
      // First close connections tracked by WebSocket handler (includes connections that haven't completed JOIN)
      closeConnectionsForRoom(roomId);
      // Then close connections tracked in room.connectedClients (for connections that completed JOIN)
      closeRoomConnections(room);

      // Delete room from storage
      const deleted = deleteRoom(roomId);
      if (!deleted) {
        // This shouldn't happen since we already checked room exists
        return reply.code(404).send({
          statusCode: 404,
          error: 'Not Found',
          message: `Room not found: ${roomIdString}`,
        });
      }

      // Log room deletion with structured logging
      logger.info(
        {
          roomId: roomId,
        },
        'room.deleted'
      );

      // Return 204 No Content on success
      return reply.code(204).send();
    }
  );

  /**
   * DELETE /admin/api/rooms/:roomId/clients/:clientId - Remove a client from a room
   */
  fastify.delete<{ Params: { roomId: string; clientId: string } }>(
    '/admin/api/rooms/:roomId/clients/:clientId',
    {
      schema: {
        params: {
          type: 'object',
          properties: {
            roomId: {
              type: 'string',
              pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
              description: 'UUID v4 format',
            },
            clientId: {
              type: 'string',
              pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
              description: 'UUID v4 format',
            },
          },
          required: ['roomId', 'clientId'],
        },
      },
      preHandler: roomValidationPreHandler,
    },
    async (request, reply) => {
      // Room is validated and attached to request by preHandler
      const room = request.room!;
      const { roomId: roomIdString, clientId: clientIdString } = request.params;
      const roomId = toRoomId(roomIdString);
      const clientId = toClientId(clientIdString);

      // Check if client exists in room
      const client = room.connectedClients.get(clientId);
      if (!client) {
        return reply.code(404).send({
          statusCode: 404,
          error: 'Not Found',
          message: `Client not found in room: ${clientIdString}`,
        });
      }

      // Close WebSocket connection if still open
      try {
        if (client.conn.readyState === WebSocket.OPEN || client.conn.readyState === WebSocket.CONNECTING) {
          client.conn.close(1001, 'Client removed by admin');
        }
      } catch (error) {
        logger.warn(
          {
            roomId,
            clientId,
            error,
          },
          'Failed to close WebSocket connection during client removal'
        );
      }

      // Remove client from room.connectedClients
      room.connectedClients.delete(clientId);

      // Remove connection from connectionsByRoom if it exists
      const roomConnections = connectionsByRoom.get(roomId);
      if (roomConnections) {
        // Find and remove the connection
        for (const ws of roomConnections) {
          if (ws.clientId === clientId) {
            roomConnections.delete(ws);
            // Clean up empty sets
            if (roomConnections.size === 0) {
              connectionsByRoom.delete(roomId);
            }
            break;
          }
        }
      }

      // Log client removal with structured logging
      logger.info(
        {
          roomId,
          clientId,
        },
        'client.removed'
      );

      // Return 204 No Content on success
      return reply.code(204).send();
    }
  );
};

export default roomsPlugin;
