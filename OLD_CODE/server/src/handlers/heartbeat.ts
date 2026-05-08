/**
 * HEARTBEAT message handler
 * Handles regular status updates from clients for drift detection
 */

import { logger } from '../utils/logger';
import type { RoomId } from '../types/ids';
import { validateMessage, formatValidationError } from '../utils/validation';
import { validateRoomForWebSocket } from '../utils/room-validation';
import type { HeartbeatMessage, SyncAdjustMessage } from '../types/messages';
import { sendError, type ExtendedWebSocket } from '../utils/message-helpers';
import {
  calculateExpectedTime,
  calculateDrift,
  selectSyncMode,
  shouldSkipReconciliation,
  exceedsDriftThreshold,
} from '../utils/drift-reconciliation';
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
 * Send SYNC_ADJUST message to a specific client
 * @param ws - WebSocket connection to send to
 * @param targetPos - Target playback position in seconds
 * @param mode - Sync adjustment mode
 */
function sendSyncAdjust(
  ws: ExtendedWebSocket,
  targetPos: number,
  mode: 'nudge-rate' | 'seek'
): void {
  const syncAdjustMessage: SyncAdjustMessage = {
    type: 'SYNC_ADJUST',
    serverTime: Date.now(),
    targetPos,
    mode,
  };

  try {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(syncAdjustMessage));
      logger.debug(
        {
          roomId: ws.roomId,
          clientId: ws.clientId || undefined,
          targetPos,
          mode,
        },
        'Sent SYNC_ADJUST message to client'
      );
    }
  } catch (error) {
    logger.warn(
      {
        error,
        roomId: ws.roomId,
        clientId: ws.clientId || undefined,
      },
      'Failed to send SYNC_ADJUST message to client'
    );
  }
}

/**
 * Handle HEARTBEAT message - process client status updates and detect drift
 * @param ws - WebSocket connection
 * @param message - HEARTBEAT message from client
 * @param roomId - Room identifier
 * @param connectionsByRoom - Map of roomId to Set of WebSocket connections
 */
export function handleHeartbeatMessage(
  ws: ExtendedWebSocketWithRateLimit,
  message: unknown,
  roomId: RoomId,
  _connectionsByRoom: ConnectionsByRoom
): void {
  // Verify client is authenticated (has clientId)
  if (!ws.clientId) {
    logger.warn(
      {
        roomId: roomId,
      },
      'HEARTBEAT message received before JOIN'
    );
    sendError(ws, 'NOT_AUTHENTICATED', 'Must join room before sending heartbeat');
    return;
  }

  // Validate HEARTBEAT message schema
  const validation = validateMessage(message, 'HEARTBEAT');
  if (!validation.valid) {
    logger.warn(
      {
        roomId: roomId,
        clientId: ws.clientId,
        errors: validation.errors,
      },
      'HEARTBEAT message validation failed'
    );
    sendError(
      ws,
      'INVALID_MESSAGE',
      `Message validation failed: ${formatValidationError(validation.errors || [])}`
    );
    return;
  }

  const heartbeatMessage = message as HeartbeatMessage;

  // Validate room exists and is not expired
  const room = validateRoomForWebSocket(roomId, ws);
  if (!room) {
    // Error already sent by validateRoomForWebSocket
    return;
  }

  // Update client lastSeen timestamp
  const client = room.connectedClients.get(ws.clientId);
  if (client) {
    client.lastSeen = Date.now();

    // Skip drift reconciliation if client is buffering
    // BUFFER_START tells the server to stop trying to sync that client
    if (client.isBuffering) {
      logger.debug(
        {
          roomId: roomId,
          clientId: ws.clientId,
        },
        'Skipping drift reconciliation: client is buffering'
      );
      return;
    }
  }

  // Skip drift reconciliation if in cooldown window after explicit event
  if (shouldSkipReconciliation(room)) {
    logger.debug(
      {
        roomId: roomId,
        clientId: ws.clientId,
      },
      'Skipping drift reconciliation: within cooldown window'
    );
    return;
  }

  // TODO: Content identity initialization issue
  // According to unified_v1_backend_and_network_design.md:
  // - "Drift correction logic (nudging vs seek) is unchanged within a content boundary"
  // - "No drift correction is applied across episode boundaries"
  //
  // Problem: Currently, contentIdentity is only set via EPISODE_CHANGE_REQUEST, which means:
  // - Rooms created without an episode change have no contentIdentity
  // - Drift reconciliation cannot distinguish between "same content" vs "different content"
  // - This blocks drift correction for normal use cases where clients start on the same episode
  //
  // Potential solution: Add contentIdentity fields to JOIN message so the first client to join
  // establishes the content identity for the room. This would allow:
  // - Proper initialization of contentIdentity when room is first used
  // - Detection of content mismatches during JOIN (client reports different content than room)
  // - Enforcement of "no drift correction across episode boundaries" rule
  //
  // For now, drift reconciliation proceeds without content identity checks.
  // This means drift correction works but cannot prevent correction across episode boundaries.
  //
  // if (!room.contentIdentity) {
  //   logger.debug(
  //     {
  //       roomId: roomId,
  //       clientId: ws.clientId,
  //     },
  //     'Skipping drift reconciliation: no content identity set'
  //   );
  //   return;
  // }

  // Calculate expected playback time
  const expectedTime = calculateExpectedTime(room);

  // Calculate drift
  const driftMs = calculateDrift(heartbeatMessage.currentPos, expectedTime);

  // Check if drift exceeds threshold
  if (!exceedsDriftThreshold(driftMs)) {
    // Drift is within acceptable range - no correction needed
    logger.debug(
      {
        roomId: roomId,
        clientId: ws.clientId,
        driftMs,
        expectedTime,
        reportedPos: heartbeatMessage.currentPos,
      },
      'Drift within acceptable threshold'
    );
    return;
  }

  // Select sync adjustment mode based on drift amount
  const syncMode = selectSyncMode(driftMs);

  // Send SYNC_ADJUST message to this client
  sendSyncAdjust(ws, expectedTime, syncMode);

  logger.info(
    {
      roomId: roomId,
      clientId: ws.clientId,
      driftMs,
      expectedTime,
      reportedPos: heartbeatMessage.currentPos,
      syncMode,
    },
    'Drift detected and SYNC_ADJUST sent to client'
  );
}
