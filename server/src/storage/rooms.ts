/**
 * In-memory room storage module
 */

import type { Room, PlaybackState } from '../types/room';
import type { RoomId } from '../types/ids';

/**
 * In-memory storage for rooms
 * Map key: roomId, value: Room object
 */
const rooms = new Map<RoomId, Room>();

/**
 * Create a new room with default state
 * @param roomId - Unique room identifier
 * @param passwordHash - Hashed password (HMAC-SHA256)
 * @param ttlSeconds - Time-to-live in seconds
 * @param targetUrl - Target video URL for the room (required for sharing)
 * @returns Created Room object
 */
export function createRoom(
  roomId: RoomId,
  passwordHash: string,
  ttlSeconds: number,
  targetUrl: string
): Room {
  const now = Date.now();

  const defaultState: PlaybackState = {
    paused: true,
    time: 0,
    provider: '',
    episode: 0,
    last_explicit_event_ts: now,
    last_state_update_ts: now,
    eventId: 0,
  };

  const room: Room = {
    roomId,
    passwordHash,
    createdAt: now,
    expiresAt: now + ttlSeconds * 1000,
    targetUrl,
    state: defaultState,
    connectedClients: new Map(),
    eventLog: [],
  };

  rooms.set(roomId, room);
  return room;
}

/**
 * Get a room by ID
 * @param roomId - Room identifier
 * @returns Room object if found, undefined otherwise
 */
export function getRoom(roomId: RoomId): Room | undefined {
  return rooms.get(roomId);
}

/**
 * Delete a room from storage
 * @param roomId - Room identifier
 * @returns True if room was deleted, false if room didn't exist
 */
export function deleteRoom(roomId: RoomId): boolean {
  return rooms.delete(roomId);
}

/**
 * Clear all rooms from storage
 * Useful for testing to reset state between tests
 */
export function clearAllRooms(): void {
  rooms.clear();
}

/**
 * Check if a room is expired
 * @param room - Room object to check
 * @returns True if room is expired, false otherwise
 */
export function isRoomExpired(room: Room): boolean {
  return room.expiresAt < Date.now();
}

/**
 * List all active (non-expired) rooms
 * @returns Array of room summaries sorted by creation time (newest first)
 */
export function listActiveRooms(): Array<{
  id: RoomId;
  createdAt: number;
  participantCount: number;
  last_state: PlaybackState;
  expiresAt: number;
}> {
  const now = Date.now();
  const activeRooms: Array<{
    id: RoomId;
    createdAt: number;
    participantCount: number;
    last_state: PlaybackState;
    expiresAt: number;
  }> = [];

  for (const [roomId, room] of rooms.entries()) {
    // Filter expired rooms (do not include rooms where the expired timestamp is equal to now)
    if (room.expiresAt > now) {
      activeRooms.push({
        id: roomId,
        createdAt: room.createdAt,
        participantCount: room.connectedClients.size,
        last_state: room.state,
        expiresAt: room.expiresAt,
      });
    }
  }

  // Sort by createdAt descending (newest first)
  activeRooms.sort((a, b) => b.createdAt - a.createdAt);

  return activeRooms;
}

/**
 * Clean up expired rooms by closing connections and removing them from storage
 * @param closeConnections - Function to close WebSocket connections for a room
 * @returns Number of rooms cleaned up
 */
export function cleanupExpiredRooms(closeConnections: (room: Room) => void): number {
  const now = Date.now();
  let cleanedCount = 0;
  const roomsToDelete: RoomId[] = [];

  // First pass: identify expired rooms
  for (const [roomId, room] of rooms.entries()) {
    if (room.expiresAt < now) {
      roomsToDelete.push(roomId);
    }
  }

  // Second pass: close connections and delete rooms
  for (const roomId of roomsToDelete) {
    const room = rooms.get(roomId);
    if (room) {
      // Close all WebSocket connections
      closeConnections(room);
      // Delete room from storage
      rooms.delete(roomId);
      cleanedCount++;
    }
  }

  return cleanedCount;
}
