/**
 * EVENT message handler
 * Handles play/pause/seek events from clients
 */

import { logger } from '../utils/logger';
import { getConfig } from '../config';
import type { RoomId } from '../types/ids';
import { validateMessage, formatValidationError } from '../utils/validation';
import { validateRoomForWebSocket } from '../utils/room-validation';
import type { EventMessage } from '../types/messages';
import { RateLimiter } from '../utils/rate-limiter';
import { sendError } from '../utils/message-helpers';
import { addEventToLog } from '../utils/connection-helpers';
import { broadcastState } from '../utils/broadcasting';
import type { ExtendedWebSocket } from '../utils/message-helpers';

/**
 * Extended WebSocket interface with rate limiter state
 */
export interface ExtendedWebSocketWithRateLimit extends ExtendedWebSocket {
  /** Rate limiter state for this connection */
  rateLimiterState?: ReturnType<RateLimiter['createState']>;
}

/**
 * Map to track WebSocket connections by roomId
 */
type ConnectionsByRoom = Map<RoomId, Set<ExtendedWebSocket>>;

/**
 * Handle EVENT message - process play/pause/seek events
 * @param ws - WebSocket connection
 * @param message - EVENT message from client
 * @param roomId - Room identifier
 * @param connectionsByRoom - Map of roomId to Set of WebSocket connections
 */
export function handleEventMessage(
  ws: ExtendedWebSocketWithRateLimit,
  message: unknown,
  roomId: RoomId,
  connectionsByRoom: ConnectionsByRoom
): void {
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
  broadcastState(room, connectionsByRoom);

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
