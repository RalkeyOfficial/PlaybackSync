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
import { sendError, sendRoomState, sendContentMismatch, type ExtendedWebSocket } from '../utils/message-helpers';
import { generateClientId, computeDerivedContentKey } from '../utils/connection-helpers';
import { rateLimitedTotal } from '../utils/metrics';

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

  // Check connection count limit per room
  const currentConnections = connectionsByRoom.get(roomId)?.size || 0;
  if (currentConnections >= config.maxConnectionsPerRoom) {
    logger.warn(
      {
        roomId: roomId,
        currentConnections,
        maxConnections: config.maxConnectionsPerRoom,
      },
      'JOIN failed: room connection limit exceeded'
    );
    rateLimitedTotal.inc({ type: 'connection' });
    sendError(
      ws,
      'ROOM_FULL',
      `Room connection limit exceeded (max: ${config.maxConnectionsPerRoom})`
    );
    ws.close(1008, 'Room connection limit exceeded');
    return;
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

  logger.debug(
    {
      roomId: roomId,
      clientId: clientId,
    },
    'JOIN authentication successful'
  );

  // Content identity validation and initialization
  // According to unified_v1_backend_and_network_design.md section 5:
  // - If room has no content identity, set it from first client's JOIN
  // - If room has content identity, validate client's content matches
  // - If mismatch, send CONTENT_MISMATCH and reject join
  if (!room.contentIdentity) {
    // Room has no content identity yet - set it from first client's JOIN
    if (joinMessage.episodeId && joinMessage.providerId && joinMessage.pageUrl) {
      const derivedContentKey = computeDerivedContentKey(
        joinMessage.pageUrl,
        joinMessage.providerId,
        joinMessage.episodeId
      );
      
      room.contentIdentity = {
        episodeId: joinMessage.episodeId,
        providerId: joinMessage.providerId,
        derivedContentKey,
        pageUrl: joinMessage.pageUrl,
      };

      // Update legacy state fields for backward compatibility
      room.state.provider = joinMessage.providerId;
      room.state.episode =
        typeof joinMessage.episodeId === 'number'
          ? joinMessage.episodeId
          : parseInt(joinMessage.episodeId, 10) || 0;

      logger.info(
        {
          roomId: roomId,
          clientId: clientId,
          episodeId: joinMessage.episodeId,
          providerId: joinMessage.providerId,
          derivedContentKey,
        },
        'Content identity established from first client join'
      );
    } else {
      // Client didn't provide content identity fields - this is acceptable for first join
      // Room will remain without content identity until an episode change occurs
      logger.debug(
        {
          roomId: roomId,
          clientId: clientId,
        },
        'First client join without content identity fields - room remains without content identity'
      );
    }
  } else {
    // Room has content identity - validate client's content matches
    if (!joinMessage.episodeId || !joinMessage.providerId || !joinMessage.pageUrl) {
      logger.warn(
        {
          roomId: roomId,
          clientId: clientId,
          expectedContentKey: room.contentIdentity.derivedContentKey,
        },
        'JOIN failed: room has content identity but client did not provide content identity fields'
      );
      sendContentMismatch(ws, room.contentIdentity.derivedContentKey);
      sendError(
        ws,
        'CONTENT_MISMATCH',
        'Room has established content identity. Please provide episodeId, providerId, and pageUrl in JOIN message.'
      );
      ws.close(1008, 'Content identity mismatch');
      return;
    }

    // Compute client's derivedContentKey and compare with room's
    const clientDerivedContentKey = computeDerivedContentKey(
      joinMessage.pageUrl,
      joinMessage.providerId,
      joinMessage.episodeId
    );

    if (clientDerivedContentKey !== room.contentIdentity.derivedContentKey) {
      logger.warn(
        {
          roomId: roomId,
          clientId: clientId,
          expectedContentKey: room.contentIdentity.derivedContentKey,
          reportedContentKey: clientDerivedContentKey,
          expectedEpisodeId: room.contentIdentity.episodeId,
          reportedEpisodeId: joinMessage.episodeId,
          expectedProviderId: room.contentIdentity.providerId,
          reportedProviderId: joinMessage.providerId,
        },
        'JOIN failed: content identity mismatch'
      );
      sendContentMismatch(ws, room.contentIdentity.derivedContentKey, clientDerivedContentKey);
      sendError(
        ws,
        'CONTENT_MISMATCH',
        'Content identity mismatch. Client content does not match room content.'
      );
      ws.close(1008, 'Content identity mismatch');
      return;
    }

    logger.debug(
      {
        roomId: roomId,
        clientId: clientId,
        derivedContentKey: clientDerivedContentKey,
      },
      'Content identity validation successful'
    );
  }

  // Check for client tombstone (reconnection)
  // According to backend_design_v1.md:
  // - Tombstone allows "re-association" with same clientId
  // - If tombstone valid: preserve state (lastEventId) for event replay
  // - If tombstone expired: still use same clientId, but treat as new client (no state preservation)
  const existingClient = room.connectedClients.get(clientId);
  const now = Date.now();
  let isReconnection = false;
  let lastKnownEventId: number | undefined;

  if (existingClient) {
    // Check if tombstone is still valid
    if (existingClient.tombstonedUntil && existingClient.tombstonedUntil > now) {
      // Valid tombstone - reattach connection and preserve state
      isReconnection = true;
      lastKnownEventId = existingClient.lastEventId; // Store before updating
      existingClient.conn = ws;
      existingClient.lastSeen = now;
      existingClient.tombstonedUntil = undefined; // Clear tombstone
      existingClient.lastEventId = room.state.eventId; // Update to current state
      logger.info(
        {
          roomId: roomId,
          clientId: clientId,
        },
        'Client reconnected with valid tombstone'
      );
    } else {
      // Tombstone expired or no tombstone - remove old entry
      // Client will be treated as new (same clientId, but no state preservation)
      room.connectedClients.delete(clientId);
      logger.info(
        {
          roomId: roomId,
          clientId: clientId,
        },
        'Tombstone expired, reconnecting with same clientId as new client'
      );
    }
  }

  // Add client to room.connectedClients (or update if reconnection)
  if (!isReconnection) {
    room.connectedClients.set(clientId, {
      clientId,
      conn: ws,
      lastSeen: now,
      lastEventId: room.state.eventId, // Track current eventId for new client
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

  // Determine lastKnownEventId for event replay
  // According to backend_network_design_v1.md section 7:
  // "Request ROOM_STATE; server returns { videoPos, playerState, lastEventId } and any recentEvents[] since lastEventId"
  // For reconnections with valid tombstone, include recent events since the client's last known eventId
  // For new clients (including expired tombstone), don't include recentEvents (client will sync from current state)
  // lastKnownEventId is already set above if isReconnection === true

  logger.debug(
    {
      roomId: roomId,
      clientId: clientId,
      isReconnection,
      lastKnownEventId,
      currentEventId: room.state.eventId,
    },
    'Sending ROOM_STATE to joining client'
  );

  // Send current STATE to joining client (includes clientId and recentEvents for replay if reconnection)
  sendRoomState(ws, room, clientId, lastKnownEventId);
}
