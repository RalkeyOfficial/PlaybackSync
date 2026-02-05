/**
 * Public share endpoint for participants to join rooms
 * Uses HTTP Basic Authentication - browser shows login prompt automatically
 */

import { FastifyPluginAsync } from 'fastify';
import { getConfig } from '../config';
import { logger, maskId } from '../utils/logger';
import { verifyPassword } from '../utils/password';
import { toRoomId } from '../types/ids';
import { roomValidationPreHandler } from '../utils/room-validation';

/**
 * Parse HTTP Basic Authentication header
 * @param authHeader - Authorization header value (e.g., "Basic base64string")
 * @returns Object with username and password, or null if invalid
 */
function parseBasicAuth(
  authHeader: string | undefined
): { username: string; password: string } | null {
  if (!authHeader || !authHeader.startsWith('Basic ')) {
    return null;
  }

  try {
    const base64Credentials = authHeader.substring(6); // Remove "Basic " prefix
    const credentials = Buffer.from(base64Credentials, 'base64').toString('utf-8');
    const [username, password] = credentials.split(':', 2);

    // Username can be empty/ignored, but password is required
    if (password === undefined) {
      return null;
    }

    return {
      username: username || '',
      password: password,
    };
  } catch {
    return null;
  }
}

/**
 * Build redirect URL with sync parameters
 * @param targetUrl - Target video URL
 * @param roomId - Room identifier
 * @param password - Room password
 * @param syncHostname - WebSocket hostname from config
 * @returns Redirect URL with sync parameters
 */
function buildRedirectUrl(
  targetUrl: string,
  roomId: string,
  password: string,
  syncHostname?: string
): string {
  const url = new URL(targetUrl);

  // Build WebSocket URL
  const wsUrl = syncHostname ? `wss://${syncHostname}/${roomId}` : `wss://localhost/${roomId}`;

  // Add sync parameters
  url.searchParams.set('sync_url', wsUrl);
  url.searchParams.set('sync_password', password);

  return url.toString();
}

/**
 * Share endpoint plugin
 * Handles GET /:roomId with HTTP Basic Authentication
 */
const sharePlugin: FastifyPluginAsync = async fastify => {
  // Load config lazily when plugin is registered (after env vars are set)
  const config = getConfig();

  /**
   * GET /:roomId - Public share endpoint with HTTP Basic Auth
   */
  fastify.get<{ Params: { roomId: string } }>(
    '/:roomId',
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

      // Check for Authorization header
      const authHeader = request.headers.authorization;
      const credentials = parseBasicAuth(authHeader);

      // If no Authorization header, return 401 with WWW-Authenticate header
      // This triggers the browser's Basic Auth prompt
      if (!credentials) {
        return reply.code(401).header('WWW-Authenticate', `Basic realm="Room ${roomIdString}"`).send({
          statusCode: 401,
          error: 'Unauthorized',
          message: 'Authentication required',
        });
      }

      // Verify password (username is ignored per spec)
      const passwordValid = verifyPassword(
        credentials.password,
        room.passwordHash,
        config.serverSecret
      );

      if (!passwordValid) {
        // Log failed authentication attempt
        logger.warn(
          {
            roomId: maskId(roomId),
          },
          'share.auth_failed'
        );

        return reply.code(401).header('WWW-Authenticate', `Basic realm="Room ${roomIdString}"`).send({
          statusCode: 401,
          error: 'Unauthorized',
          message: 'Invalid password',
        });
      }

      // Password is valid - build redirect URL with sync parameters
      const redirectUrl = buildRedirectUrl(
        room.targetUrl,
        roomIdString,
        credentials.password,
        config.syncHostname
      );

      // Log successful authentication
      logger.info(
        {
          roomId: maskId(roomId),
          targetUrl: room.targetUrl,
        },
        'share.auth_success'
      );

      // Redirect to targetUrl with sync parameters
      return reply.redirect(302, redirectUrl);
    }
  );
};

export default sharePlugin;
