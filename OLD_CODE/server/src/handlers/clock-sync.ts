/**
 * CLOCK_PING message handler
 * Handles clock synchronization requests from clients (NTP-style)
 */

import { logger } from '../utils/logger';
import type { RoomId } from '../types/ids';
import { validateMessage, formatValidationError } from '../utils/validation';
import { validateRoomForWebSocket } from '../utils/room-validation';
import type { ClockPingMessage, ClockPongMessage } from '../types/messages';
import { sendError, type ExtendedWebSocket } from '../utils/message-helpers';
import { WebSocket } from 'ws';
import type { RateLimiterState } from '../utils/rate-limiter';

/**
 * Extended WebSocket interface with connection metadata
 */
export interface ExtendedWebSocketWithRateLimit extends ExtendedWebSocket {
  /** Rate limiter state for this connection */
  rateLimiterState?: RateLimiterState;
}

/**
 * Map to track WebSocket connections by roomId
 */
type ConnectionsByRoom = Map<RoomId, Set<ExtendedWebSocket>>;

/**
 * Handle CLOCK_PING message - respond with CLOCK_PONG for clock synchronization
 * @param ws - WebSocket connection
 * @param message - CLOCK_PING message from client
 * @param roomId - Room identifier
 * @param connectionsByRoom - Map of roomId to Set of WebSocket connections
 */
export function handleClockPingMessage(
  ws: ExtendedWebSocketWithRateLimit,
  message: unknown,
  roomId: RoomId,
  _connectionsByRoom: ConnectionsByRoom
): void {
  // Verify client is authenticated (has clientId)
  // Note: CLOCK_PING can be sent before JOIN according to design, but we'll require JOIN first
  // for consistency with other handlers and to track clock offset per client
  if (!ws.clientId) {
    logger.warn(
      {
        roomId: roomId,
      },
      'CLOCK_PING message received before JOIN'
    );
    sendError(ws, 'NOT_AUTHENTICATED', 'Must join room before sending clock ping');
    return;
  }

  // Validate CLOCK_PING message schema
  const validation = validateMessage(message, 'CLOCK_PING');
  if (!validation.valid) {
    logger.warn(
      {
        roomId: roomId,
        clientId: ws.clientId,
        errors: validation.errors,
      },
      'CLOCK_PING message validation failed'
    );
    sendError(
      ws,
      'INVALID_MESSAGE',
      `Message validation failed: ${formatValidationError(validation.errors || [])}`
    );
    return;
  }

  const clockPingMessage = message as ClockPingMessage;

  // Validate room exists and is not expired
  const room = validateRoomForWebSocket(roomId, ws);
  if (!room) {
    // Error already sent by validateRoomForWebSocket
    return;
  }

  // Record server receive time immediately
  const serverRecvTime = Date.now();

  // Get client connection to update clock offset and RTT
  const client = room.connectedClients.get(ws.clientId);
  if (client) {
    client.lastSeen = Date.now();
  }

  // Record server send time (as close to sending as possible)
  const serverSendTime = Date.now();

  // Calculate RTT: (serverSendTime - serverRecvTime) is server processing time
  // Actual RTT will be calculated by client: (clientRecvTime - clientSendTime)
  // But we can estimate it here for tracking purposes
  // Note: This is an approximation; true RTT requires clientRecvTime from client
  const estimatedRTT = serverSendTime - serverRecvTime;

  // Send CLOCK_PONG response
  const clockPongMessage: ClockPongMessage = {
    type: 'CLOCK_PONG',
    clientSendTime: clockPingMessage.clientSendTime,
    serverRecvTime,
    serverSendTime,
    // clientRecvTime will be filled in by client when it receives this message
  };

  try {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(clockPongMessage));
      logger.debug(
        {
          roomId: roomId,
          clientId: ws.clientId,
          clientSendTime: clockPingMessage.clientSendTime,
          serverRecvTime,
          serverSendTime,
          estimatedRTT,
        },
        'Sent CLOCK_PONG message to client'
      );

      // Update client connection with estimated RTT
      // Note: True clock offset requires client to calculate from all 4 timestamps
      // We can store the estimated RTT for monitoring purposes
      if (client) {
        client.rtt = estimatedRTT;
        client.clockSyncTime = Date.now();
        // Clock offset calculation: offset = ((serverRecvTime - clientSendTime) + (serverSendTime - clientRecvTime)) / 2
        // But we don't have clientRecvTime yet, so we'll wait for client to report it
        // For now, we can estimate: offset ≈ serverRecvTime - clientSendTime (one-way estimate)
        // This is approximate and will be refined when client completes the calculation
        const estimatedOffset = serverRecvTime - clockPingMessage.clientSendTime;
        client.clockOffset = estimatedOffset;
      }
    }
  } catch (error) {
    logger.warn(
      {
        error,
        roomId: roomId,
        clientId: ws.clientId || undefined,
      },
      'Failed to send CLOCK_PONG message to client'
    );
  }
}
