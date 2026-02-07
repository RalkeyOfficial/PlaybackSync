/**
 * Tests for room storage module
 */

import {
  createRoom,
  getRoom,
  deleteRoom,
  listActiveRooms,
  clearAllRooms,
} from '../../storage/rooms';
import { toRoomId } from '../../types/ids';

describe('Room Storage', () => {
  const testRoomId = toRoomId('123e4567-e89b-12d3-a456-426614174000');
  const testPasswordHash = 'hashed-password-123';
  const testTtlSeconds = 3600; // 1 hour
  const testTargetUrl = 'https://example.com/video';

  beforeEach(() => {
    // Clear all rooms before each test to ensure isolation
    clearAllRooms();
  });

  describe('createRoom', () => {
    it('should create room with correct structure', () => {
      const room = createRoom(testRoomId, testPasswordHash, testTtlSeconds, testTargetUrl);

      expect(room).toBeDefined();
      expect(room.roomId).toBe(testRoomId);
      expect(room.passwordHash).toBe(testPasswordHash);
      expect(room.targetUrl).toBe(testTargetUrl);
      expect(room.createdAt).toBeGreaterThan(0);
      expect(room.expiresAt).toBeGreaterThan(room.createdAt);
      expect(room.connectedClients).toBeInstanceOf(Map);
      expect(room.eventLog).toBeInstanceOf(Array);
    });

    it('should set expiration timestamp correctly (createdAt + TTL)', () => {
      const beforeCreate = Date.now();
      const room = createRoom(testRoomId, testPasswordHash, testTtlSeconds, testTargetUrl);
      const afterCreate = Date.now();

      expect(room.createdAt).toBeGreaterThanOrEqual(beforeCreate);
      expect(room.createdAt).toBeLessThanOrEqual(afterCreate);
      expect(room.expiresAt).toBe(room.createdAt + testTtlSeconds * 1000);
    });

    it('should initialize room state with default values', () => {
      const room = createRoom(testRoomId, testPasswordHash, testTtlSeconds, testTargetUrl);

      expect(room.state.playerState).toBe('paused');
      expect(room.state.videoPos).toBe(0);
      expect(room.state.provider).toBe('');
      expect(room.state.episode).toBe(0);
      expect(room.state.eventId).toBe(0);
      expect(room.state.last_explicit_event_ts).toBeGreaterThan(0);
      expect(room.state.last_state_update_ts).toBeGreaterThan(0);
    });

    it('should initialize with empty connectedClients Map', () => {
      const room = createRoom(testRoomId, testPasswordHash, testTtlSeconds, testTargetUrl);

      expect(room.connectedClients.size).toBe(0);
    });

    it('should initialize with empty eventLog array', () => {
      const room = createRoom(testRoomId, testPasswordHash, testTtlSeconds, testTargetUrl);

      expect(room.eventLog.length).toBe(0);
    });

    it('should allow multiple rooms to be stored independently', () => {
      const roomId1 = toRoomId('123e4567-e89b-12d3-a456-426614174001');
      const roomId2 = toRoomId('123e4567-e89b-12d3-a456-426614174002');

      const room1 = createRoom(roomId1, 'hash1', testTtlSeconds, testTargetUrl);
      const room2 = createRoom(roomId2, 'hash2', testTtlSeconds, testTargetUrl);

      expect(room1.roomId).toBe(roomId1);
      expect(room2.roomId).toBe(roomId2);
      expect(room1.passwordHash).toBe('hash1');
      expect(room2.passwordHash).toBe('hash2');
    });
  });

  describe('getRoom', () => {
    it('should return correct room by ID', () => {
      const room = createRoom(testRoomId, testPasswordHash, testTtlSeconds, testTargetUrl);
      const retrieved = getRoom(testRoomId);

      expect(retrieved).toBeDefined();
      expect(retrieved?.roomId).toBe(room.roomId);
      expect(retrieved?.passwordHash).toBe(room.passwordHash);
      expect(retrieved?.createdAt).toBe(room.createdAt);
    });

    it('should return undefined for non-existent room', () => {
      const nonExistentId = toRoomId('999e9999-e99b-99d9-a999-999999999999');
      const retrieved = getRoom(nonExistentId);

      expect(retrieved).toBeUndefined();
    });
  });

  describe('deleteRoom', () => {
    it('should remove room from storage', () => {
      createRoom(testRoomId, testPasswordHash, testTtlSeconds, testTargetUrl);
      expect(getRoom(testRoomId)).toBeDefined();

      const deleted = deleteRoom(testRoomId);

      expect(deleted).toBe(true);
      expect(getRoom(testRoomId)).toBeUndefined();
    });

    it('should return false when deleting non-existent room', () => {
      const nonExistentId = toRoomId('999e9999-e99b-99d9-a999-999999999999');
      const deleted = deleteRoom(nonExistentId);

      expect(deleted).toBe(false);
    });
  });

  describe('listActiveRooms', () => {
    it('should return empty array when no rooms exist', () => {
      const rooms = listActiveRooms();

      expect(rooms).toBeInstanceOf(Array);
      expect(rooms.length).toBe(0);
    });

    it('should return list of active rooms with correct fields', () => {
      const room = createRoom(testRoomId, testPasswordHash, testTtlSeconds, testTargetUrl);
      const rooms = listActiveRooms();

      expect(rooms.length).toBeGreaterThan(0);
      const foundRoom = rooms.find(r => r.id === testRoomId);
      expect(foundRoom).toBeDefined();
      expect(foundRoom).toHaveProperty('id');
      expect(foundRoom).toHaveProperty('createdAt');
      expect(foundRoom).toHaveProperty('participantCount');
      expect(foundRoom).toHaveProperty('last_state');
      expect(foundRoom?.id).toBe(testRoomId);
      expect(foundRoom?.createdAt).toBe(room.createdAt);
      expect(foundRoom?.participantCount).toBe(0);
    });

    it('should return correct participantCount (0 for new rooms)', () => {
      createRoom(testRoomId, testPasswordHash, testTtlSeconds, testTargetUrl);
      const rooms = listActiveRooms();
      const foundRoom = rooms.find(r => r.id === testRoomId);

      expect(foundRoom?.participantCount).toBe(0);
    });

    it('should return correct last_state from room.state', () => {
      const room = createRoom(testRoomId, testPasswordHash, testTtlSeconds, testTargetUrl);
      const rooms = listActiveRooms();
      const foundRoom = rooms.find(r => r.id === testRoomId);

      expect(foundRoom?.last_state.playerState).toBe(room.state.playerState);
      expect(foundRoom?.last_state.videoPos).toBe(room.state.videoPos);
      expect(foundRoom?.last_state.provider).toBe(room.state.provider);
      expect(foundRoom?.last_state.episode).toBe(room.state.episode);
    });

    it('should filter expired rooms', async () => {
      // Create an active room
      const activeRoomId = toRoomId('123e4567-e89b-12d3-a456-426614174004');
      createRoom(activeRoomId, testPasswordHash, testTtlSeconds, testTargetUrl);

      // Create a room with TTL of 0 (expires immediately: expiresAt = createdAt)
      const expiredRoomId = toRoomId('123e4567-e89b-12d3-a456-426614174003');
      createRoom(expiredRoomId, testPasswordHash, 0, testTargetUrl);

      // Add a small delay to ensure expiresAt < now (since TTL=0 means expiresAt = createdAt)
      await new Promise(resolve => setTimeout(resolve, 1));

      const rooms = listActiveRooms();

      // Active room should appear
      const activeFound = rooms.find(r => r.id === activeRoomId);
      expect(activeFound).toBeDefined();

      // Room with TTL 0 has expiresAt = createdAt, which should be < now after delay
      // So it should be filtered out (expiresAt < now check)
      const expiredFound = rooms.find(r => r.id === expiredRoomId);
      expect(expiredFound).toBeUndefined();
    });

    it('should return rooms sorted by createdAt (newest first)', async () => {
      const roomId1 = toRoomId('123e4567-e89b-12d3-a456-426614174005');
      const roomId2 = toRoomId('123e4567-e89b-12d3-a456-426614174006');

      // Create rooms with small delay to ensure different timestamps
      const room1 = createRoom(roomId1, testPasswordHash, testTtlSeconds, testTargetUrl);
      // Small delay
      await new Promise(resolve => setTimeout(resolve, 10));
      createRoom(roomId2, testPasswordHash, testTtlSeconds, testTargetUrl);

      const rooms = listActiveRooms();

      // Should be sorted newest first
      expect(rooms[0].id).toBe(roomId2);
      expect(rooms[0].createdAt).toBeGreaterThan(room1.createdAt);
    });
  });
});
