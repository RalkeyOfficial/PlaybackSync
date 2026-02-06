/**
 * EPISODE_CHANGE_REQUEST message handler
 * Handles episode change requests from clients
 */

import { logger } from '../utils/logger';
import type { RoomId } from '../types/ids';
import { validateMessage, formatValidationError } from '../utils/validation';
import { validateRoomForWebSocket } from '../utils/room-validation';
import type { EpisodeChangeRequestMessage } from '../types/messages';
import { sendError } from '../utils/message-helpers';
import { addEventToLog, computeDerivedContentKey } from '../utils/connection-helpers';
import { broadcastState, broadcastEpisodeChange } from '../utils/broadcasting';
import type { ExtendedWebSocket } from '../utils/message-helpers';

/**
 * Map to track WebSocket connections by roomId
 */
type ConnectionsByRoom = Map<RoomId, Set<ExtendedWebSocket>>;

/**
 * Handle EPISODE_CHANGE_REQUEST message - process episode change events
 * @param ws - WebSocket connection
 * @param message - EPISODE_CHANGE_REQUEST message from client
 * @param roomId - Room identifier
 * @param connectionsByRoom - Map of roomId to Set of WebSocket connections
 */
export function handleEpisodeChangeRequest(
  ws: ExtendedWebSocket,
  message: unknown,
  roomId: RoomId,
  connectionsByRoom: ConnectionsByRoom
): void {
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
  const previousEpisode = room.contentIdentity?.episodeId;
  room.state.paused = true;
  room.state.time = 0;

  logger.debug(
    {
      roomId: roomId,
      clientId: ws.clientId,
      previousEpisode,
      newEpisode: episodeChangeRequest.episodeId,
      providerId: episodeChangeRequest.providerId,
    },
    'State transition: episode change'
  );

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
  broadcastEpisodeChange(room, connectionsByRoom);

  // Also broadcast STATE to ensure all clients have updated playback state
  broadcastState(room, connectionsByRoom);

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
