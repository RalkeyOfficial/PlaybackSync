/**
 * Room cleanup utilities for closing connections and cleaning up expired rooms
 */

import type { Room } from '../types/room';
import { logger, maskId } from './logger';
import { deleteRoom, cleanupExpiredRooms } from '../storage/rooms';
import type { RoomId } from '../types/ids';

/**
 * Close all WebSocket connections for a room
 * @param room - Room object containing connected clients
 */
export function closeRoomConnections(room: Room): void {
  for (const client of room.connectedClients.values()) {
    try {
      // Check if connection is still open (readyState === 1 means OPEN)
      if (client.conn.readyState === 1) {
        client.conn.close();
      }
    } catch (error) {
      // Log warning but continue cleanup
      logger.warn(
        {
          roomId: maskId(room.roomId),
          clientId: maskId(client.clientId),
          error,
        },
        'Failed to close WebSocket connection during room cleanup'
      );
    }
  }
}

/**
 * Clean up a single expired room by closing connections and deleting it
 * @param roomId - Room identifier
 * @param room - Room object to clean up
 */
export function cleanupExpiredRoom(roomId: RoomId, room: Room): void {
  try {
    // Close all WebSocket connections
    closeRoomConnections(room);
    // Delete room from storage
    deleteRoom(roomId);
    logger.debug({ roomId: maskId(roomId) }, 'Expired room cleaned up');
  } catch (error) {
    logger.error({ roomId: maskId(roomId), error }, 'Error cleaning up expired room');
  }
}

/**
 * Background task to clean up expired rooms
 * Runs periodically to remove expired rooms and close their connections
 * @returns Number of rooms cleaned up
 */
export function runCleanupTask(): number {
  try {
    const cleanedCount = cleanupExpiredRooms(closeRoomConnections);
    if (cleanedCount > 0) {
      logger.info({ cleanedCount }, 'room.cleanup.completed');
    }
    return cleanedCount;
  } catch (error) {
    logger.error({ error }, 'room.cleanup.error');
    return 0;
  }
}
