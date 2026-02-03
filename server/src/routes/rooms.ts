/**
 * Room management API endpoints
 */

import { FastifyPluginAsync } from 'fastify';
import crypto from 'crypto';
import { getConfig } from '../config';
import { logger, maskId } from '../utils/logger';
import { hashPassword } from '../utils/password';
import { createRoom, listActiveRooms } from '../storage/rooms';
import { toRoomId } from '../types/ids';

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
 * @param shareHostname - Optional share hostname from config
 * @returns Share link (relative path or full URL)
 */
function buildShareLink(roomId: string, shareHostname?: string): string {
  if (shareHostname) {
    return `https://${shareHostname}/${roomId}`;
  }
  return `/${roomId}`;
}

/**
 * Request body schema for POST /api/rooms
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
  },
  required: ['targetUrl'],
  additionalProperties: false,
} as const;

/**
 * Response schema for POST /api/rooms
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
 * Response schema for GET /api/rooms
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
      last_state: {
        type: 'object',
        properties: {
          paused: { type: 'boolean' },
          time: { type: 'number' },
          provider: { type: 'string' },
          episode: { type: 'number' },
          last_explicit_event_ts: { type: 'number' },
          last_state_update_ts: { type: 'number' },
          eventId: { type: 'number' },
        },
        required: [
          'paused',
          'time',
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
 * Rooms API plugin
 */
const roomsPlugin: FastifyPluginAsync = async fastify => {
  // Load config lazily when plugin is registered (after env vars are set)
  const config = getConfig();

  /**
   * POST /api/rooms - Create a new room
   */
  fastify.post<{ Body: { ttl?: number; targetUrl: string } }>(
    '/api/rooms',
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

      // Create room in storage
      createRoom(roomId, passwordHash, ttlSeconds, targetUrl);

      // Build share link
      const shareLink = buildShareLink(roomIdString, config.shareHostname);

      // Log room creation with structured logging
      logger.info(
        {
          roomId: maskId(roomId),
          ttl: ttlSeconds,
          targetUrl,
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
   * GET /api/rooms - List all active rooms
   */
  fastify.get(
    '/api/rooms',
    {
      schema: {
        response: {
          200: listRoomsResponseSchema,
        },
      },
    },
    async () => {
      const rooms = listActiveRooms();

      // Transform to response format (convert RoomId to string)
      return rooms.map(room => ({
        id: room.id as string,
        createdAt: room.createdAt,
        participantCount: room.participantCount,
        expiresAt: room.expiresAt,
        last_state: room.last_state,
      }));
    }
  );
};

export default roomsPlugin;
