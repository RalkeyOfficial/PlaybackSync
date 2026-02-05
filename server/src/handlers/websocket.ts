/**
 * WebSocket connection handler and manager
 * Handles WebSocket upgrade, connection lifecycle, and message routing
 */

import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import { randomUUID, createHash } from 'crypto';
import { logger } from '../utils/logger';
import { getConfig } from '../config';
import type { RoomId, ClientId } from '../types/ids';
import { toRoomId, toClientId, isValidUuid } from '../types/ids';
import { getRoom } from '../storage/rooms';
import { verifyPassword } from '../utils/password';
import { validateMessage, formatValidationError } from '../utils/validation';
import { validateRoomForConnection, validateRoomForWebSocket } from '../utils/room-validation';
import type {
  JoinMessage,
  RoomStateMessage,
  ErrorMessage,
  EventMessage,
  StateMessage,
  EpisodeChangeRequestMessage,
  EpisodeChangeMessage,
} from '../types/messages';
import type { Room } from '../types/room';
import { RateLimiter, type RateLimiterState } from '../utils/rate-limiter';

/**
 * Map to track WebSocket connections by roomId
 * Key: roomId, Value: Set of ExtendedWebSocket connections
 */
const connectionsByRoom = new Map<RoomId, Set<ExtendedWebSocket>>();

/**
 * Maximum number of events to keep in event log (ring buffer size)
 */
const MAX_EVENT_LOG_SIZE = 100;

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
        clientId: ws.clientId || undefined,
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

  try {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(roomStateMessage));
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

/**
 * Broadcast STATE message to all connected clients in a room
 */
function broadcastState(room: Room): void {
  const now = Date.now();
  const stateMessage: StateMessage = {
    type: 'STATE',
    paused: room.state.paused,
    time: room.state.time,
    server_ts: now,
    eventId: room.state.eventId,
  };

  // Add optional fields if they exist
  if (room.state.provider) {
    stateMessage.provider = room.state.provider;
  }
  if (room.state.episode) {
    stateMessage.episode = room.state.episode;
  }

  // Broadcast to all connected clients
  const roomConnections = connectionsByRoom.get(room.roomId);
  if (!roomConnections) {
    return;
  }

  for (const ws of roomConnections) {
    try {
      if (ws.readyState === WebSocket.OPEN && ws.clientId) {
        ws.send(JSON.stringify(stateMessage));
      }
    } catch (error) {
      logger.warn(
        {
          error,
          roomId: room.roomId,
          clientId: ws.clientId || undefined,
        },
        'Failed to send STATE message to client'
      );
    }
  }
}

/**
 * Add event to event log (ring buffer)
 */
function addEventToLog(room: Room, eventType: string, value: number | string | undefined, clientId: ClientId): void {
  const event: Room['eventLog'][0] = {
    type: eventType,
    clientId,
    ts: Date.now(),
    eventId: room.state.eventId,
  };

  if (value !== undefined) {
    event.value = value;
  }

  room.eventLog.push(event);

  // Maintain ring buffer size
  if (room.eventLog.length > MAX_EVENT_LOG_SIZE) {
    room.eventLog.shift(); // Remove oldest event
  }
}

/**
 * Compute derivedContentKey from URL + provider + episode
 * Uses SHA-256 hash of normalized URL path + providerId + episodeId
 */
function computeDerivedContentKey(
  pageUrl: string,
  providerId: string,
  episodeId: string | number
): string {
  try {
    // Normalize URL (remove query params and hash for consistency)
    const normalizedUrl = new URL(pageUrl).pathname;
    const keyString = `${providerId}:${normalizedUrl}:${episodeId}`;
    return createHash('sha256').update(keyString).digest('hex');
  } catch (error) {
    // If URL parsing fails, use the full URL as-is
    logger.warn({ error, pageUrl }, 'Failed to parse URL for derivedContentKey, using full URL');
    const keyString = `${providerId}:${pageUrl}:${episodeId}`;
    return createHash('sha256').update(keyString).digest('hex');
  }
}

/**
 * Broadcast EPISODE_CHANGE message to all connected clients in a room
 */
function broadcastEpisodeChange(room: Room): void {
  if (!room.contentIdentity) {
    logger.warn({ roomId: room.roomId }, 'Cannot broadcast EPISODE_CHANGE: no contentIdentity');
    return;
  }

  const now = Date.now();
  const episodeChangeMessage: EpisodeChangeMessage = {
    type: 'EPISODE_CHANGE',
    eventId: room.state.eventId,
    episodeId: room.contentIdentity.episodeId,
    providerId: room.contentIdentity.providerId,
    derivedContentKey: room.contentIdentity.derivedContentKey,
    server_ts: now,
  };

  // Broadcast to all connected clients
  const roomConnections = connectionsByRoom.get(room.roomId);
  if (!roomConnections) {
    return;
  }

  for (const ws of roomConnections) {
    try {
      if (ws.readyState === WebSocket.OPEN && ws.clientId) {
        ws.send(JSON.stringify(episodeChangeMessage));
      }
    } catch (error) {
      logger.warn(
        {
          error,
          roomId: room.roomId,
          clientId: ws.clientId || undefined,
        },
        'Failed to send EPISODE_CHANGE message to client'
      );
    }
  }
}

/**
 * Handle EPISODE_CHANGE_REQUEST message - process episode change events
 */
function handleEpisodeChangeRequest(ws: ExtendedWebSocket, message: unknown, roomId: RoomId): void {
  // Verify client is authenticated (has clientId)
  if (!ws.clientId) {
    logger.warn(
      {
        roomId: roomId,
      },
      'EPISODE_CHANGE_REQUEST message received before JOIN'
    );
    sendError(ws, 'NOT_AUTHENTICATED', 'Must join room before sending episode change requests');
    return;
  }

  // Validate EPISODE_CHANGE_REQUEST message schema
  const validation = validateMessage(message, 'EPISODE_CHANGE_REQUEST');
  if (!validation.valid) {
    logger.warn(
      {
        roomId: roomId,
        clientId: ws.clientId,
        errors: validation.errors,
      },
      'EPISODE_CHANGE_REQUEST message validation failed'
    );
    sendError(
      ws,
      'INVALID_MESSAGE',
      `Message validation failed: ${formatValidationError(validation.errors || [])}`
    );
    return;
  }

  const episodeChangeRequest = message as EpisodeChangeRequestMessage;

  // Validate room exists and is not expired
  const room = validateRoomForWebSocket(roomId, ws);
  if (!room) {
    // Error already sent by validateRoomForWebSocket
    return;
  }

  // Derive derivedContentKey from URL + provider + episode
  const derivedContentKey = computeDerivedContentKey(
    episodeChangeRequest.pageUrl,
    episodeChangeRequest.providerId,
    episodeChangeRequest.episodeId
  );

  // Process episode change
  const now = Date.now();
  room.state.eventId += 1;
  room.state.last_explicit_event_ts = now;
  room.state.last_state_update_ts = now;

  // Reset playback state (hard reset)
  room.state.paused = true;
  room.state.time = 0;

  // Update room state with new episode info
  room.contentIdentity = {
    episodeId: episodeChangeRequest.episodeId,
    providerId: episodeChangeRequest.providerId,
    derivedContentKey,
    pageUrl: episodeChangeRequest.pageUrl,
  };

  // Update legacy state fields for backward compatibility
  room.state.provider = episodeChangeRequest.providerId;
  room.state.episode =
    typeof episodeChangeRequest.episodeId === 'number'
      ? episodeChangeRequest.episodeId
      : parseInt(episodeChangeRequest.episodeId, 10) || 0;

  // Add event to log
  addEventToLog(room, 'episode_change', episodeChangeRequest.episodeId, ws.clientId);

  // Broadcast EPISODE_CHANGE to all clients
  broadcastEpisodeChange(room);

  // Also broadcast STATE to ensure all clients have updated playback state
  broadcastState(room);

  logger.info(
    {
      roomId: roomId,
      clientId: ws.clientId,
      episodeId: episodeChangeRequest.episodeId,
      providerId: episodeChangeRequest.providerId,
      eventId: room.state.eventId,
    },
    'Episode change processed and broadcast'
  );
}

/**
 * Handle EVENT message - process play/pause/seek events
 */
function handleEventMessage(ws: ExtendedWebSocket, message: unknown, roomId: RoomId): void {
  const eventConfig = getConfig();

  // Verify client is authenticated (has clientId)
  if (!ws.clientId) {
    logger.warn(
      {
        roomId: roomId,
      },
      'EVENT message received before JOIN'
    );
    sendError(ws, 'NOT_AUTHENTICATED', 'Must join room before sending events');
    return;
  }

  // Validate EVENT message schema
  const validation = validateMessage(message, 'EVENT');
  if (!validation.valid) {
    logger.warn(
      {
        roomId: roomId,
        clientId: ws.clientId,
        errors: validation.errors,
      },
      'EVENT message validation failed'
    );
    sendError(
      ws,
      'INVALID_MESSAGE',
      `Message validation failed: ${formatValidationError(validation.errors || [])}`
    );
    return;
  }

  const eventMessage = message as EventMessage;

  // Validate room exists and is not expired
  const room = validateRoomForWebSocket(roomId, ws);
  if (!room) {
    // Error already sent by validateRoomForWebSocket
    return;
  }

  // Check rate limit
  if (!ws.rateLimiterState) {
    // Initialize rate limiter if not already done
    const rateLimiter = new RateLimiter(eventConfig.rateLimitEventsPerSec);
    ws.rateLimiterState = rateLimiter.createState();
  }

  const rateLimiter = new RateLimiter(eventConfig.rateLimitEventsPerSec);
  if (!rateLimiter.check(ws.rateLimiterState)) {
    logger.warn(
      {
        roomId: roomId,
        clientId: ws.clientId,
        event: eventMessage.event,
      },
      'Rate limit exceeded for EVENT message'
    );
    sendError(ws, 'RATE_LIMITED', 'Rate limit exceeded');
    return;
  }

  // Process event
  const now = Date.now();
  room.state.eventId += 1;
  room.state.last_explicit_event_ts = now;
  room.state.last_state_update_ts = now;

  // Update state based on event type
  switch (eventMessage.event) {
    case 'play':
      room.state.paused = false;
      break;
    case 'pause':
      room.state.paused = true;
      break;
    case 'seek':
      if (eventMessage.value !== undefined) {
        room.state.time = eventMessage.value;
      }
      break;
  }

  // Add event to log
  addEventToLog(room, eventMessage.event, eventMessage.value, ws.clientId);

  // Broadcast STATE to all clients
  broadcastState(room);

  logger.info(
    {
      roomId: roomId,
      clientId: ws.clientId,
      event: eventMessage.event,
      value: eventMessage.value,
      eventId: room.state.eventId,
    },
    'Event processed and state broadcast'
  );
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
  /** Rate limiter state for this connection */
  rateLimiterState?: RateLimiterState;
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
        handleJoinMessage(ws, message, roomId);
      } else if (message.type === 'EVENT') {
        // Handle EVENT message (play/pause/seek)
        handleEventMessage(ws, message, roomId);
      } else if (message.type === 'EPISODE_CHANGE_REQUEST') {
        // Handle EPISODE_CHANGE_REQUEST message
        handleEpisodeChangeRequest(ws, message, roomId);
      } else {
        // Other message types will be handled in later steps
        logger.debug({ messageType: message.type, roomId }, 'Message received');
      }
    } catch (error) {
      logger.error(
        { error, roomId: ws.roomId || undefined },
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
          // Note: conn remains pointing to closed connection, which is fine
          // The tombstone allows reconnection with same clientId
          logger.info(
            {
              roomId: ws.roomId,
              clientId: ws.clientId,
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
