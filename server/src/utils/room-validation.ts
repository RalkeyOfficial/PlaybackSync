/**
 * Room validation utilities for HTTP routes and WebSocket handlers
 * Provides reusable functions to check room existence and expiration
 */

import type { FastifyRequest, FastifyReply } from 'fastify';
import type { RoomId } from '../types/ids';
import type { Room } from '../types/room';
import { getRoom, isRoomExpired } from '../storage/rooms';
import { cleanupExpiredRoom } from './room-cleanup';
import { logger, maskId } from './logger';
import { toRoomId, isValidUuid } from '../types/ids';
import { WebSocket } from 'ws';
import type { ExtendedWebSocket } from '../handlers/websocket';
import type { ErrorMessage } from '../types/messages';

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
        clientId: ws.clientId ? maskId(ws.clientId) : undefined,
        code,
      },
      'Failed to send ERROR message to client'
    );
  }
}

/**
 * Validate room exists and is not expired for WebSocket connection upgrade
 * Closes connection if room is invalid
 * @param roomId - Room identifier to validate
 * @param ws - WebSocket connection
 * @returns Room object if valid, null if invalid (connection already closed)
 */
export function validateRoomForConnection(roomId: RoomId, ws: ExtendedWebSocket): Room | null {
  const room = getRoom(roomId);
  if (!room) {
    logger.warn({ roomId: maskId(roomId) }, 'WebSocket connection rejected: room not found');
    ws.close(1008, 'Room not found');
    return null;
  }

  if (isRoomExpired(room)) {
    logger.warn({ roomId: maskId(roomId) }, 'WebSocket connection rejected: room expired');
    // Clean up expired room in background (don't await)
    setImmediate(() => {
      cleanupExpiredRoom(roomId, room);
    });
    ws.close(1008, 'Room not found');
    return null;
  }

  return room;
}

/**
 * Validate room exists and is not expired for WebSocket message handlers
 * Sends ERROR message if room is invalid (does not close connection)
 * @param roomId - Room identifier to validate
 * @param ws - WebSocket connection
 * @returns Room object if valid, null if invalid (error already sent)
 */
export function validateRoomForWebSocket(roomId: RoomId, ws: ExtendedWebSocket): Room | null {
  const room = getRoom(roomId);
  if (!room) {
    logger.warn({ roomId: maskId(roomId) }, 'Room not found');
    sendError(ws, 'ROOM_NOT_FOUND', 'Room not found');
    return null;
  }

  if (isRoomExpired(room)) {
    logger.warn({ roomId: maskId(roomId) }, 'Room not found');
    // Clean up expired room in background (don't await)
    setImmediate(() => {
      cleanupExpiredRoom(roomId, room);
    });
    sendError(ws, 'ROOM_NOT_FOUND', 'Room not found');
    return null;
  }

  return room;
}

/**
 * Fastify preHandler hook to validate room exists and is not expired
 * Attaches validated room to request.room for use in route handlers
 * Sends 404 response if room is not found or expired
 * @param request - Fastify request object
 * @param reply - Fastify reply object
 * @returns Promise that resolves to undefined if validation fails (response already sent)
 */
export async function roomValidationPreHandler(
  request: FastifyRequest<{ Params: { roomId: string } }>,
  reply: FastifyReply
): Promise<void> {
  const { roomId: roomIdString } = request.params;

  // Validate UUID format
  if (!isValidUuid(roomIdString)) {
    reply.code(400).send({
      statusCode: 400,
      error: 'Bad Request',
      message: `Invalid UUID format for roomId: ${roomIdString}`,
    });
    return;
  }

  // Convert to RoomId type
  let roomId: RoomId;
  try {
    roomId = toRoomId(roomIdString);
  } catch (error) {
    reply.code(400).send({
      statusCode: 400,
      error: 'Bad Request',
      message: `Invalid UUID format for roomId: ${roomIdString}`,
    });
    return;
  }

  // Get room from storage
  const room = getRoom(roomId);
  if (!room) {
    reply.code(404).send({
      statusCode: 404,
      error: 'Not Found',
      message: `Room not found: ${roomIdString}`,
    });
    return;
  }

  // Check if room is expired - clean up in background and return 404
  if (isRoomExpired(room)) {
    // Clean up expired room in background (don't await)
    setImmediate(() => {
      cleanupExpiredRoom(roomId, room);
    });

    reply.code(404).send({
      statusCode: 404,
      error: 'Not Found',
      message: `Room not found: ${roomIdString}`,
    });
    return;
  }

  // Attach room to request for use in route handler
  (request as FastifyRequest & { room: Room }).room = room;
}
