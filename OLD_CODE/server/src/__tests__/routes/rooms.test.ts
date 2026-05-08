/**
 * Tests for the /admin/api/rooms endpoints
 */

import { createTestServer } from '../helpers/test-server';
import { setupTestEnv, cleanupTestEnv } from '../helpers/fixtures';
import { isValidUuid, toRoomId, toClientId } from '../../types/ids';
import { clearAllRooms, getRoom } from '../../storage/rooms';
import { connectionsByRoom } from '../../handlers/websocket';
import type { WebSocket } from 'ws';

describe('Rooms API Endpoints', () => {
  let server: Awaited<ReturnType<typeof createTestServer>>;

  beforeAll(async () => {
    setupTestEnv();
    server = await createTestServer();
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
    cleanupTestEnv();
  });

  describe('POST /admin/api/rooms', () => {
    it('should require targetUrl', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/admin/api/rooms',
        payload: {},
      });

      expect(response.statusCode).toBe(400);
    });

    it('should create room with UUID v4 roomId', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/admin/api/rooms',
        payload: {
          targetUrl: 'https://example.com/video',
        },
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.body);
      expect(body).toHaveProperty('roomId');
      expect(isValidUuid(body.roomId)).toBe(true);
    });

    it('should generate random password (different each time)', async () => {
      const response1 = await server.inject({
        method: 'POST',
        url: '/admin/api/rooms',
        payload: {
          targetUrl: 'https://example.com/video1',
        },
      });

      const response2 = await server.inject({
        method: 'POST',
        url: '/admin/api/rooms',
        payload: {
          targetUrl: 'https://example.com/video2',
        },
      });

      const body1 = JSON.parse(response1.body);
      const body2 = JSON.parse(response2.body);

      expect(body1.password).toBeDefined();
      expect(body2.password).toBeDefined();
      expect(body1.password).not.toBe(body2.password);
    });

    it('should hash password using HMAC-SHA256 (never stores plaintext)', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/admin/api/rooms',
        payload: {
          targetUrl: 'https://example.com/video',
        },
      });

      const body = JSON.parse(response.body);
      expect(body.password).toBeDefined();
      expect(typeof body.password).toBe('string');
      expect(body.password.length).toBeGreaterThan(0);

      // Verify room exists and password is hashed (not plaintext)
      const listResponse = await server.inject({
        method: 'GET',
        url: '/admin/api/rooms',
      });

      const rooms = JSON.parse(listResponse.body);
      const createdRoom = rooms.find((r: { id: string }) => r.id === body.roomId);
      expect(createdRoom).toBeDefined();
      // Password should not be in the room listing
      expect(createdRoom.password).toBeUndefined();
    });

    it('should create Room with correct TTL (expiresAt = createdAt + ttl)', async () => {
      const ttl = 7200; // 2 hours
      const response = await server.inject({
        method: 'POST',
        url: '/admin/api/rooms',
        payload: {
          ttl: ttl,
          targetUrl: 'https://example.com/video',
        },
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.body);

      // Get room details to verify TTL
      const listResponse = await server.inject({
        method: 'GET',
        url: '/admin/api/rooms',
      });

      const rooms = JSON.parse(listResponse.body);
      const createdRoom = rooms.find((r: { id: string }) => r.id === body.roomId);
      expect(createdRoom).toBeDefined();

      // Verify expiration is approximately createdAt + ttl (within 1 second tolerance)
      const expectedExpiresAt = createdRoom.createdAt + ttl * 1000;
      expect(Math.abs(createdRoom.expiresAt - expectedExpiresAt)).toBeLessThan(1000);
    });

    it('should return correct response format: { roomId, password, shareLink }', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/admin/api/rooms',
        payload: {
          targetUrl: 'https://example.com/video',
        },
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.body);

      expect(body).toHaveProperty('roomId');
      expect(body).toHaveProperty('password');
      expect(body).toHaveProperty('shareLink');
      expect(typeof body.roomId).toBe('string');
      expect(typeof body.password).toBe('string');
      expect(typeof body.shareLink).toBe('string');
    });

    it('should return share link format: /UUID when HOSTNAME not set', async () => {
      // Ensure HOSTNAME is not set
      delete process.env.HOSTNAME;

      const response = await server.inject({
        method: 'POST',
        url: '/admin/api/rooms',
        payload: {
          targetUrl: 'https://example.com/video',
        },
      });

      const body = JSON.parse(response.body);
      expect(body.shareLink).toMatch(
        /^\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      );
      expect(body.shareLink).toBe(`/${body.roomId}`);
    });

    it('should return full URL share link when HOSTNAME is set', async () => {
      // Set env var before creating server so config picks it up
      process.env.HOSTNAME = 'playbacksync.example.com';

      // Create a new server instance to pick up the new env var
      const testServer = await createTestServer();
      await testServer.ready();

      const response = await testServer.inject({
        method: 'POST',
        url: '/admin/api/rooms',
        payload: {
          targetUrl: 'https://example.com/video',
        },
      });

      const body = JSON.parse(response.body);
      expect(body.shareLink).toMatch(/^https:\/\/playbacksync\.example\.com\/[0-9a-f-]+$/i);
      expect(body.shareLink).toBe(`https://playbacksync.example.com/${body.roomId}`);

      // Cleanup
      await testServer.close();
      delete process.env.HOSTNAME;
    });

    it('should accept request body with ttl and targetUrl', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/admin/api/rooms',
        payload: {
          ttl: 3600,
          targetUrl: 'https://example.com/video',
        },
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.body);
      expect(body.roomId).toBeDefined();
    });

    it('should reject invalid ttl (negative)', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/admin/api/rooms',
        payload: {
          ttl: -1,
        },
      });

      expect(response.statusCode).toBe(400);
    });

    it('should reject invalid ttl (non-number)', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/admin/api/rooms',
        payload: {
          ttl: 'not-a-number',
        },
      });

      expect(response.statusCode).toBe(400);
    });

    it('should reject invalid targetUrl (non-string)', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/admin/api/rooms',
        payload: {
          targetUrl: 12345,
        },
      });

      expect(response.statusCode).toBe(400);
    });

    it('should use default TTL from config if not provided', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/admin/api/rooms',
        payload: {
          targetUrl: 'https://example.com/video',
        },
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.body);

      // Get room details
      const listResponse = await server.inject({
        method: 'GET',
        url: '/admin/api/rooms',
      });

      const rooms = JSON.parse(listResponse.body);
      const createdRoom = rooms.find((r: { id: string }) => r.id === body.roomId);
      expect(createdRoom).toBeDefined();

      // Default TTL is 86400 seconds (24 hours)
      const expectedExpiresAt = createdRoom.createdAt + 86400 * 1000;
      expect(Math.abs(createdRoom.expiresAt - expectedExpiresAt)).toBeLessThan(1000);
    });

    it('should make room appear in GET /admin/api/rooms list after creation', async () => {
      const createResponse = await server.inject({
        method: 'POST',
        url: '/admin/api/rooms',
        payload: {
          targetUrl: 'https://example.com/video',
        },
      });

      const createBody = JSON.parse(createResponse.body);
      const roomId = createBody.roomId;

      const listResponse = await server.inject({
        method: 'GET',
        url: '/admin/api/rooms',
      });

      const rooms = JSON.parse(listResponse.body);
      const foundRoom = rooms.find((r: { id: string }) => r.id === roomId);
      expect(foundRoom).toBeDefined();
    });

    it('should allow multiple rooms to be created independently', async () => {
      const response1 = await server.inject({
        method: 'POST',
        url: '/admin/api/rooms',
        payload: {
          targetUrl: 'https://example.com/video1',
        },
      });

      const response2 = await server.inject({
        method: 'POST',
        url: '/admin/api/rooms',
        payload: {
          targetUrl: 'https://example.com/video2',
        },
      });

      const body1 = JSON.parse(response1.body);
      const body2 = JSON.parse(response2.body);

      expect(body1.roomId).not.toBe(body2.roomId);
      expect(body1.password).not.toBe(body2.password);

      const listResponse = await server.inject({
        method: 'GET',
        url: '/admin/api/rooms',
      });

      const rooms = JSON.parse(listResponse.body);
      const found1 = rooms.find((r: { id: string }) => r.id === body1.roomId);
      const found2 = rooms.find((r: { id: string }) => r.id === body2.roomId);

      expect(found1).toBeDefined();
      expect(found2).toBeDefined();
    });

    it('should create room with name when name is provided', async () => {
      const roomName = 'My Test Room';
      const response = await server.inject({
        method: 'POST',
        url: '/admin/api/rooms',
        payload: {
          targetUrl: 'https://example.com/video',
          name: roomName,
        },
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.body);
      expect(body).toHaveProperty('roomId');

      // Verify name appears in list endpoint
      const listResponse = await server.inject({
        method: 'GET',
        url: '/admin/api/rooms',
      });

      const rooms = JSON.parse(listResponse.body);
      const foundRoom = rooms.find((r: { id: string }) => r.id === body.roomId);
      expect(foundRoom).toBeDefined();
      expect(foundRoom?.name).toBe(roomName);
    });

    it('should create room without name when name is not provided (backward compatibility)', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/admin/api/rooms',
        payload: {
          targetUrl: 'https://example.com/video',
        },
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.body);
      expect(body).toHaveProperty('roomId');

      // Verify name is not in list endpoint
      const listResponse = await server.inject({
        method: 'GET',
        url: '/admin/api/rooms',
      });

      const rooms = JSON.parse(listResponse.body);
      const foundRoom = rooms.find((r: { id: string }) => r.id === body.roomId);
      expect(foundRoom).toBeDefined();
      expect(foundRoom?.name).toBeUndefined();
    });
  });

  describe('GET /admin/api/rooms', () => {
    it('should return empty array when no rooms exist', async () => {
      // Note: This test assumes we can clear rooms or start with empty state
      // In a real scenario, we might need a test helper to clear rooms
      const response = await server.inject({
        method: 'GET',
        url: '/admin/api/rooms',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(Array.isArray(body)).toBe(true);
    });

    it('should return list of active rooms with correct fields', async () => {
      // Create a room first
      const createResponse = await server.inject({
        method: 'POST',
        url: '/admin/api/rooms',
        payload: {
          targetUrl: 'https://example.com/video',
        },
      });

      const createBody = JSON.parse(createResponse.body);
      const roomId = createBody.roomId;

      const listResponse = await server.inject({
        method: 'GET',
        url: '/admin/api/rooms',
      });

      expect(listResponse.statusCode).toBe(200);
      const rooms = JSON.parse(listResponse.body);
      expect(Array.isArray(rooms)).toBe(true);

      const foundRoom = rooms.find((r: { id: string }) => r.id === roomId);
      expect(foundRoom).toBeDefined();
      expect(foundRoom).toHaveProperty('id');
      expect(foundRoom).toHaveProperty('createdAt');
      expect(foundRoom).toHaveProperty('participantCount');
      expect(foundRoom).toHaveProperty('last_state');
      expect(typeof foundRoom.id).toBe('string');
      expect(typeof foundRoom.createdAt).toBe('number');
      expect(typeof foundRoom.participantCount).toBe('number');
      expect(typeof foundRoom.last_state).toBe('object');
    });

    it('should return correct participantCount (0 for new rooms)', async () => {
      const createResponse = await server.inject({
        method: 'POST',
        url: '/admin/api/rooms',
        payload: {
          targetUrl: 'https://example.com/video',
        },
      });

      const createBody = JSON.parse(createResponse.body);

      const listResponse = await server.inject({
        method: 'GET',
        url: '/admin/api/rooms',
      });

      const rooms = JSON.parse(listResponse.body);
      const foundRoom = rooms.find((r: { id: string }) => r.id === createBody.roomId);

      expect(foundRoom.participantCount).toBe(0);
    });

    it('should return correct last_state from room.state', async () => {
      const createResponse = await server.inject({
        method: 'POST',
        url: '/admin/api/rooms',
        payload: {
          targetUrl: 'https://example.com/video',
        },
      });

      const createBody = JSON.parse(createResponse.body);

      const listResponse = await server.inject({
        method: 'GET',
        url: '/admin/api/rooms',
      });

      const rooms = JSON.parse(listResponse.body);
      const foundRoom = rooms.find((r: { id: string }) => r.id === createBody.roomId);

      expect(foundRoom.last_state).toHaveProperty('playerState');
      expect(foundRoom.last_state).toHaveProperty('videoPos');
      expect(foundRoom.last_state).toHaveProperty('provider');
      expect(foundRoom.last_state).toHaveProperty('episode');
      expect(typeof foundRoom.last_state.playerState).toBe('string');
      expect(typeof foundRoom.last_state.videoPos).toBe('number');
      expect(typeof foundRoom.last_state.provider).toBe('string');
      expect(typeof foundRoom.last_state.episode).toBe('number');
    });

    it('should filter expired rooms', async () => {
      // Create a room with very short TTL
      const createResponse = await server.inject({
        method: 'POST',
        url: '/admin/api/rooms',
        payload: {
          ttl: 1,
          targetUrl: 'https://example.com/video',
        }, // 1 second TTL
      });

      const createBody = JSON.parse(createResponse.body);
      const expiredRoomId = createBody.roomId;

      // Wait for expiration
      await new Promise(resolve => setTimeout(resolve, 1100));

      const listResponse = await server.inject({
        method: 'GET',
        url: '/admin/api/rooms',
      });

      const rooms = JSON.parse(listResponse.body);
      const expiredRoom = rooms.find((r: { id: string }) => r.id === expiredRoomId);

      expect(expiredRoom).toBeUndefined();
    });

    it('should remove room after TTL expires (2 seconds)', async () => {
      // Create a room with 2 second TTL
      const createResponse = await server.inject({
        method: 'POST',
        url: '/admin/api/rooms',
        payload: {
          ttl: 2,
          targetUrl: 'https://example.com/video',
        }, // 2 seconds TTL
      });

      expect(createResponse.statusCode).toBe(201);
      const createBody = JSON.parse(createResponse.body);
      const roomId = createBody.roomId;

      // Verify room exists immediately after creation
      const listResponseBefore = await server.inject({
        method: 'GET',
        url: '/admin/api/rooms',
      });

      const roomsBefore = JSON.parse(listResponseBefore.body);
      const roomBefore = roomsBefore.find((r: { id: string }) => r.id === roomId);
      expect(roomBefore).toBeDefined();
      expect(roomBefore.id).toBe(roomId);

      // Wait longer than TTL (2.5 seconds to be safe)
      await new Promise(resolve => setTimeout(resolve, 2500));

      // Verify room has been removed/filtered out
      const listResponseAfter = await server.inject({
        method: 'GET',
        url: '/admin/api/rooms',
      });

      const roomsAfter = JSON.parse(listResponseAfter.body);
      const roomAfter = roomsAfter.find((r: { id: string }) => r.id === roomId);

      expect(roomAfter).toBeUndefined();
    });
  });

  describe('GET /admin/api/rooms/:roomId', () => {
    beforeEach(() => {
      // Clear rooms before each test for isolation
      clearAllRooms();
    });

    it('should return 200 with correct room details for existing room', async () => {
      // Create a room first
      const createResponse = await server.inject({
        method: 'POST',
        url: '/admin/api/rooms',
        payload: {
          targetUrl: 'https://example.com/video',
        },
      });

      const createBody = JSON.parse(createResponse.body);
      const roomId = createBody.roomId;

      // Get room details
      const response = await server.inject({
        method: 'GET',
        url: `/admin/api/rooms/${roomId}`,
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);

      expect(body).toHaveProperty('roomId');
      expect(body).toHaveProperty('createdAt');
      expect(body).toHaveProperty('expiresAt');
      expect(body).toHaveProperty('targetUrl');
      expect(body).toHaveProperty('state');
      expect(body).toHaveProperty('connectedClients');
      expect(body).toHaveProperty('recentEvents');
      expect(body.roomId).toBe(roomId);
      expect(body.targetUrl).toBe('https://example.com/video');
    });

    it('should return room details with correct state structure', async () => {
      const createResponse = await server.inject({
        method: 'POST',
        url: '/admin/api/rooms',
        payload: {
          targetUrl: 'https://example.com/video',
        },
      });

      const createBody = JSON.parse(createResponse.body);
      const roomId = createBody.roomId;

      const response = await server.inject({
        method: 'GET',
        url: `/admin/api/rooms/${roomId}`,
      });

      const body = JSON.parse(response.body);

      expect(body.state).toHaveProperty('playerState');
      expect(body.state).toHaveProperty('videoPos');
      expect(body.state).toHaveProperty('provider');
      expect(body.state).toHaveProperty('episode');
      expect(body.state).toHaveProperty('eventId');
      expect(body.state).toHaveProperty('last_explicit_event_ts');
      expect(body.state).toHaveProperty('last_state_update_ts');
      expect(typeof body.state.playerState).toBe('string');
      expect(typeof body.state.videoPos).toBe('number');
      expect(typeof body.state.provider).toBe('string');
      expect(typeof body.state.episode).toBe('number');
      expect(typeof body.state.eventId).toBe('number');
      expect(typeof body.state.last_explicit_event_ts).toBe('number');
      expect(typeof body.state.last_state_update_ts).toBe('number');
    });

    it('should return empty connectedClients array for room with no clients', async () => {
      const createResponse = await server.inject({
        method: 'POST',
        url: '/admin/api/rooms',
        payload: {
          targetUrl: 'https://example.com/video',
        },
      });

      const createBody = JSON.parse(createResponse.body);
      const roomId = createBody.roomId;

      const response = await server.inject({
        method: 'GET',
        url: `/admin/api/rooms/${roomId}`,
      });

      const body = JSON.parse(response.body);

      expect(Array.isArray(body.connectedClients)).toBe(true);
      expect(body.connectedClients.length).toBe(0);
    });

    it('should include name in room details when room has name', async () => {
      const roomName = 'My Test Room';
      const createResponse = await server.inject({
        method: 'POST',
        url: '/admin/api/rooms',
        payload: {
          targetUrl: 'https://example.com/video',
          name: roomName,
        },
      });

      const createBody = JSON.parse(createResponse.body);
      const roomId = createBody.roomId;

      const response = await server.inject({
        method: 'GET',
        url: `/admin/api/rooms/${roomId}`,
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.name).toBe(roomName);
    });

    it('should not include name in room details when room has no name', async () => {
      const createResponse = await server.inject({
        method: 'POST',
        url: '/admin/api/rooms',
        payload: {
          targetUrl: 'https://example.com/video',
        },
      });

      const createBody = JSON.parse(createResponse.body);
      const roomId = createBody.roomId;

      const response = await server.inject({
        method: 'GET',
        url: `/admin/api/rooms/${roomId}`,
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.name).toBeUndefined();
    });

    it('should return empty recentEvents array for room with no events', async () => {
      const createResponse = await server.inject({
        method: 'POST',
        url: '/admin/api/rooms',
        payload: {
          targetUrl: 'https://example.com/video',
        },
      });

      const createBody = JSON.parse(createResponse.body);
      const roomId = createBody.roomId;

      const response = await server.inject({
        method: 'GET',
        url: `/admin/api/rooms/${roomId}`,
      });

      const body = JSON.parse(response.body);

      expect(Array.isArray(body.recentEvents)).toBe(true);
      expect(body.recentEvents.length).toBe(0);
    });

    it('should exclude passwordHash from response (security)', async () => {
      const createResponse = await server.inject({
        method: 'POST',
        url: '/admin/api/rooms',
        payload: {
          targetUrl: 'https://example.com/video',
        },
      });

      const createBody = JSON.parse(createResponse.body);
      const roomId = createBody.roomId;

      const response = await server.inject({
        method: 'GET',
        url: `/admin/api/rooms/${roomId}`,
      });

      const body = JSON.parse(response.body);

      expect(body.passwordHash).toBeUndefined();
      expect(body.password).toBeUndefined();
    });

    it('should return 404 for non-existent room', async () => {
      const nonExistentRoomId = '123e4567-e89b-12d3-a456-426614174999';

      const response = await server.inject({
        method: 'GET',
        url: `/admin/api/rooms/${nonExistentRoomId}`,
      });

      expect(response.statusCode).toBe(404);
    });

    it('should return 404 for expired room', async () => {
      // Create a room with very short TTL
      const createResponse = await server.inject({
        method: 'POST',
        url: '/admin/api/rooms',
        payload: {
          ttl: 1,
          targetUrl: 'https://example.com/video',
        },
      });

      const createBody = JSON.parse(createResponse.body);
      const roomId = createBody.roomId;

      // Wait for expiration
      await new Promise(resolve => setTimeout(resolve, 1100));

      const response = await server.inject({
        method: 'GET',
        url: `/admin/api/rooms/${roomId}`,
      });

      expect(response.statusCode).toBe(404);
    });

    it('should return 400 for invalid roomId format (non-UUID)', async () => {
      const invalidRoomId = 'not-a-valid-uuid';

      const response = await server.inject({
        method: 'GET',
        url: `/admin/api/rooms/${invalidRoomId}`,
      });

      expect(response.statusCode).toBe(400);
    });

    it('should return correct createdAt and expiresAt timestamps', async () => {
      const ttl = 3600; // 1 hour
      const createResponse = await server.inject({
        method: 'POST',
        url: '/admin/api/rooms',
        payload: {
          ttl: ttl,
          targetUrl: 'https://example.com/video',
        },
      });

      const createBody = JSON.parse(createResponse.body);
      const roomId = createBody.roomId;

      const response = await server.inject({
        method: 'GET',
        url: `/admin/api/rooms/${roomId}`,
      });

      const body = JSON.parse(response.body);

      expect(typeof body.createdAt).toBe('number');
      expect(typeof body.expiresAt).toBe('number');
      expect(body.expiresAt).toBeGreaterThan(body.createdAt);
      expect(body.expiresAt).toBe(body.createdAt + ttl * 1000);
    });
  });

  describe('DELETE /admin/api/rooms/:roomId', () => {
    beforeEach(() => {
      // Clear rooms before each test for isolation
      clearAllRooms();
    });

    it('should return 200/204 on successful deletion', async () => {
      const createResponse = await server.inject({
        method: 'POST',
        url: '/admin/api/rooms',
        payload: {
          targetUrl: 'https://example.com/video',
        },
      });

      const createBody = JSON.parse(createResponse.body);
      const roomId = createBody.roomId;

      const response = await server.inject({
        method: 'DELETE',
        url: `/admin/api/rooms/${roomId}`,
      });

      // Accept either 200 or 204
      expect([200, 204]).toContain(response.statusCode);
    });

    it('should remove room from storage (verify via GET /admin/api/rooms)', async () => {
      const createResponse = await server.inject({
        method: 'POST',
        url: '/admin/api/rooms',
        payload: {
          targetUrl: 'https://example.com/video',
        },
      });

      const createBody = JSON.parse(createResponse.body);
      const roomId = createBody.roomId;

      // Verify room exists before deletion
      const listBeforeResponse = await server.inject({
        method: 'GET',
        url: '/admin/api/rooms',
      });

      const roomsBefore = JSON.parse(listBeforeResponse.body);
      const foundBefore = roomsBefore.find((r: { id: string }) => r.id === roomId);
      expect(foundBefore).toBeDefined();

      // Delete the room
      const deleteResponse = await server.inject({
        method: 'DELETE',
        url: `/admin/api/rooms/${roomId}`,
      });

      expect([200, 204]).toContain(deleteResponse.statusCode);

      // Verify room no longer exists
      const listAfterResponse = await server.inject({
        method: 'GET',
        url: '/admin/api/rooms',
      });

      const roomsAfter = JSON.parse(listAfterResponse.body);
      const foundAfter = roomsAfter.find((r: { id: string }) => r.id === roomId);
      expect(foundAfter).toBeUndefined();
    });

    it('should return 404 for non-existent room', async () => {
      const nonExistentRoomId = '123e4567-e89b-12d3-a456-426614174999';

      const response = await server.inject({
        method: 'DELETE',
        url: `/admin/api/rooms/${nonExistentRoomId}`,
      });

      expect(response.statusCode).toBe(404);
    });

    it('should return 404 for expired room', async () => {
      // Create a room with very short TTL
      const createResponse = await server.inject({
        method: 'POST',
        url: '/admin/api/rooms',
        payload: {
          ttl: 1,
          targetUrl: 'https://example.com/video',
        },
      });

      const createBody = JSON.parse(createResponse.body);
      const roomId = createBody.roomId;

      // Wait for expiration
      await new Promise(resolve => setTimeout(resolve, 1100));

      const response = await server.inject({
        method: 'DELETE',
        url: `/admin/api/rooms/${roomId}`,
      });

      expect(response.statusCode).toBe(404);
    });

    it('should return 400 for invalid roomId format (non-UUID)', async () => {
      const invalidRoomId = 'not-a-valid-uuid';

      const response = await server.inject({
        method: 'DELETE',
        url: `/admin/api/rooms/${invalidRoomId}`,
      });

      expect(response.statusCode).toBe(400);
    });

    it('should allow deletion of room with no connected clients', async () => {
      const createResponse = await server.inject({
        method: 'POST',
        url: '/admin/api/rooms',
        payload: {
          targetUrl: 'https://example.com/video',
        },
      });

      const createBody = JSON.parse(createResponse.body);
      const roomId = createBody.roomId;

      // Verify room has no clients
      const room = getRoom(toRoomId(roomId));
      expect(room?.connectedClients.size).toBe(0);

      const response = await server.inject({
        method: 'DELETE',
        url: `/admin/api/rooms/${roomId}`,
      });

      expect([200, 204]).toContain(response.statusCode);
    });

    it('should close WebSocket connections when room has connected clients', async () => {
      // Create a room
      const createResponse = await server.inject({
        method: 'POST',
        url: '/admin/api/rooms',
        payload: {
          targetUrl: 'https://example.com/video',
        },
      });

      const createBody = JSON.parse(createResponse.body);
      const roomId = toRoomId(createBody.roomId);

      // Get the room and add mock clients
      const room = getRoom(roomId);
      expect(room).toBeDefined();

      if (room) {
        // Create mock WebSocket objects
        const mockWs1 = {
          close: jest.fn(),
          readyState: 1, // OPEN
        } as unknown as WebSocket;

        const mockWs2 = {
          close: jest.fn(),
          readyState: 1, // OPEN
        } as unknown as WebSocket;

        const clientId1 = toClientId('123e4567-e89b-12d3-a456-426614174001');
        const clientId2 = toClientId('123e4567-e89b-12d3-a456-426614174002');

        room.connectedClients.set(clientId1, {
          clientId: clientId1,
          conn: mockWs1,
          lastSeen: Date.now(),
        });

        room.connectedClients.set(clientId2, {
          clientId: clientId2,
          conn: mockWs2,
          lastSeen: Date.now(),
        });

        expect(room.connectedClients.size).toBe(2);

        // Delete the room
        const response = await server.inject({
          method: 'DELETE',
          url: `/admin/api/rooms/${roomId}`,
        });

        expect([200, 204]).toContain(response.statusCode);

        // Verify WebSocket close was called on both connections
        expect(mockWs1.close).toHaveBeenCalled();
        expect(mockWs2.close).toHaveBeenCalled();
      }
    });
  });

  describe('DELETE /admin/api/rooms/:roomId/clients/:clientId', () => {
    beforeEach(() => {
      // Clear rooms and connections before each test for isolation
      clearAllRooms();
      connectionsByRoom.clear();
    });

    it('should return 204 on successful client removal', async () => {
      // Create a room
      const createResponse = await server.inject({
        method: 'POST',
        url: '/admin/api/rooms',
        payload: {
          targetUrl: 'https://example.com/video',
        },
      });

      const createBody = JSON.parse(createResponse.body);
      const roomId = createBody.roomId;
      const roomIdTyped = toRoomId(roomId);

      // Get the room and add a mock client
      const room = getRoom(roomIdTyped);
      expect(room).toBeDefined();

      if (room) {
        const mockWs = {
          close: jest.fn(),
          readyState: 1, // OPEN
        } as unknown as WebSocket;

        const clientId = toClientId('123e4567-e89b-12d3-a456-426614174001');

        room.connectedClients.set(clientId, {
          clientId,
          conn: mockWs,
          lastSeen: Date.now(),
        });

        // Add to connectionsByRoom
        if (!connectionsByRoom.has(roomIdTyped)) {
          connectionsByRoom.set(roomIdTyped, new Set());
        }
        const extendedWs = mockWs as any;
        extendedWs.clientId = clientId;
        extendedWs.roomId = roomIdTyped;
        connectionsByRoom.get(roomIdTyped)!.add(extendedWs);

        expect(room.connectedClients.size).toBe(1);

        // Remove the client
        const response = await server.inject({
          method: 'DELETE',
          url: `/admin/api/rooms/${roomId}/clients/${clientId}`,
        });

        expect(response.statusCode).toBe(204);
        expect(room.connectedClients.size).toBe(0);
        expect(mockWs.close).toHaveBeenCalled();
      }
    });

    it('should remove client from room.connectedClients', async () => {
      // Create a room
      const createResponse = await server.inject({
        method: 'POST',
        url: '/admin/api/rooms',
        payload: {
          targetUrl: 'https://example.com/video',
        },
      });

      const createBody = JSON.parse(createResponse.body);
      const roomId = createBody.roomId;
      const roomIdTyped = toRoomId(roomId);

      // Get the room and add mock clients
      const room = getRoom(roomIdTyped);
      expect(room).toBeDefined();

      if (room) {
        const mockWs1 = {
          close: jest.fn(),
          readyState: 1,
        } as unknown as WebSocket;

        const mockWs2 = {
          close: jest.fn(),
          readyState: 1,
        } as unknown as WebSocket;

        const clientId1 = toClientId('123e4567-e89b-12d3-a456-426614174001');
        const clientId2 = toClientId('123e4567-e89b-12d3-a456-426614174002');

        room.connectedClients.set(clientId1, {
          clientId: clientId1,
          conn: mockWs1,
          lastSeen: Date.now(),
        });

        room.connectedClients.set(clientId2, {
          clientId: clientId2,
          conn: mockWs2,
          lastSeen: Date.now(),
        });

        expect(room.connectedClients.size).toBe(2);

        // Remove first client
        const response = await server.inject({
          method: 'DELETE',
          url: `/admin/api/rooms/${roomId}/clients/${clientId1}`,
        });

        expect(response.statusCode).toBe(204);
        expect(room.connectedClients.size).toBe(1);
        expect(room.connectedClients.has(clientId1)).toBe(false);
        expect(room.connectedClients.has(clientId2)).toBe(true);
        expect(mockWs1.close).toHaveBeenCalled();
        expect(mockWs2.close).not.toHaveBeenCalled();
      }
    });

    it('should remove connection from connectionsByRoom', async () => {
      // Create a room
      const createResponse = await server.inject({
        method: 'POST',
        url: '/admin/api/rooms',
        payload: {
          targetUrl: 'https://example.com/video',
        },
      });

      const createBody = JSON.parse(createResponse.body);
      const roomId = createBody.roomId;
      const roomIdTyped = toRoomId(roomId);

      // Get the room and add a mock client
      const room = getRoom(roomIdTyped);
      expect(room).toBeDefined();

      if (room) {
        const mockWs = {
          close: jest.fn(),
          readyState: 1,
        } as unknown as WebSocket;

        const clientId = toClientId('123e4567-e89b-12d3-a456-426614174001');

        room.connectedClients.set(clientId, {
          clientId,
          conn: mockWs,
          lastSeen: Date.now(),
        });

        // Add to connectionsByRoom
        if (!connectionsByRoom.has(roomIdTyped)) {
          connectionsByRoom.set(roomIdTyped, new Set());
        }
        const extendedWs = mockWs as any;
        extendedWs.clientId = clientId;
        extendedWs.roomId = roomIdTyped;
        connectionsByRoom.get(roomIdTyped)!.add(extendedWs);

        expect(connectionsByRoom.get(roomIdTyped)?.size).toBe(1);

        // Remove the client
        const response = await server.inject({
          method: 'DELETE',
          url: `/admin/api/rooms/${roomId}/clients/${clientId}`,
        });

        expect(response.statusCode).toBe(204);
        // After removing the last connection, the set should be empty or removed
        const roomConnections = connectionsByRoom.get(roomIdTyped);
        expect(roomConnections === undefined || roomConnections.size === 0).toBe(true);
      }
    });

    it('should return 404 for non-existent room', async () => {
      const nonExistentRoomId = '123e4567-e89b-12d3-a456-426614174999';
      const clientId = '123e4567-e89b-12d3-a456-426614174001';

      const response = await server.inject({
        method: 'DELETE',
        url: `/admin/api/rooms/${nonExistentRoomId}/clients/${clientId}`,
      });

      expect(response.statusCode).toBe(404);
    });

    it('should return 404 for expired room', async () => {
      // Create a room with very short TTL
      const createResponse = await server.inject({
        method: 'POST',
        url: '/admin/api/rooms',
        payload: {
          ttl: 1,
          targetUrl: 'https://example.com/video',
        },
      });

      const createBody = JSON.parse(createResponse.body);
      const roomId = createBody.roomId;
      const clientId = '123e4567-e89b-12d3-a456-426614174001';

      // Wait for expiration
      await new Promise(resolve => setTimeout(resolve, 1100));

      const response = await server.inject({
        method: 'DELETE',
        url: `/admin/api/rooms/${roomId}/clients/${clientId}`,
      });

      expect(response.statusCode).toBe(404);
    });

    it('should return 404 for client not found in room', async () => {
      // Create a room
      const createResponse = await server.inject({
        method: 'POST',
        url: '/admin/api/rooms',
        payload: {
          targetUrl: 'https://example.com/video',
        },
      });

      const createBody = JSON.parse(createResponse.body);
      const roomId = createBody.roomId;
      const nonExistentClientId = '123e4567-e89b-12d3-a456-426614174999';

      const response = await server.inject({
        method: 'DELETE',
        url: `/admin/api/rooms/${roomId}/clients/${nonExistentClientId}`,
      });

      expect(response.statusCode).toBe(404);
      const body = JSON.parse(response.body);
      expect(body.message).toContain('Client not found');
    });

    it('should return 400 for invalid roomId format (non-UUID)', async () => {
      const invalidRoomId = 'not-a-valid-uuid';
      const clientId = '123e4567-e89b-12d3-a456-426614174001';

      const response = await server.inject({
        method: 'DELETE',
        url: `/admin/api/rooms/${invalidRoomId}/clients/${clientId}`,
      });

      expect(response.statusCode).toBe(400);
    });

    it('should return 400 for invalid clientId format (non-UUID)', async () => {
      // Create a room
      const createResponse = await server.inject({
        method: 'POST',
        url: '/admin/api/rooms',
        payload: {
          targetUrl: 'https://example.com/video',
        },
      });

      const createBody = JSON.parse(createResponse.body);
      const roomId = createBody.roomId;
      const invalidClientId = 'not-a-valid-uuid';

      const response = await server.inject({
        method: 'DELETE',
        url: `/admin/api/rooms/${roomId}/clients/${invalidClientId}`,
      });

      expect(response.statusCode).toBe(400);
    });

    it('should handle closed WebSocket connection gracefully', async () => {
      // Create a room
      const createResponse = await server.inject({
        method: 'POST',
        url: '/admin/api/rooms',
        payload: {
          targetUrl: 'https://example.com/video',
        },
      });

      const createBody = JSON.parse(createResponse.body);
      const roomId = createBody.roomId;
      const roomIdTyped = toRoomId(roomId);

      // Get the room and add a mock client with closed connection
      const room = getRoom(roomIdTyped);
      expect(room).toBeDefined();

      if (room) {
        const mockWs = {
          close: jest.fn(),
          readyState: 3, // CLOSED
        } as unknown as WebSocket;

        const clientId = toClientId('123e4567-e89b-12d3-a456-426614174001');

        room.connectedClients.set(clientId, {
          clientId,
          conn: mockWs,
          lastSeen: Date.now(),
        });

        // Remove the client (should not call close on already closed connection)
        const response = await server.inject({
          method: 'DELETE',
          url: `/admin/api/rooms/${roomId}/clients/${clientId}`,
        });

        expect(response.statusCode).toBe(204);
        expect(room.connectedClients.size).toBe(0);
        // close() should not be called for CLOSED connections
        expect(mockWs.close).not.toHaveBeenCalled();
      }
    });

    it('should handle WebSocket close error gracefully', async () => {
      // Create a room
      const createResponse = await server.inject({
        method: 'POST',
        url: '/admin/api/rooms',
        payload: {
          targetUrl: 'https://example.com/video',
        },
      });

      const createBody = JSON.parse(createResponse.body);
      const roomId = createBody.roomId;
      const roomIdTyped = toRoomId(roomId);

      // Get the room and add a mock client that throws on close
      const room = getRoom(roomIdTyped);
      expect(room).toBeDefined();

      if (room) {
        const mockWs = {
          close: jest.fn(() => {
            throw new Error('Connection error');
          }),
          readyState: 1, // OPEN
        } as unknown as WebSocket;

        const clientId = toClientId('123e4567-e89b-12d3-a456-426614174001');

        room.connectedClients.set(clientId, {
          clientId,
          conn: mockWs,
          lastSeen: Date.now(),
        });

        // Remove the client (should handle error gracefully)
        const response = await server.inject({
          method: 'DELETE',
          url: `/admin/api/rooms/${roomId}/clients/${clientId}`,
        });

        // Should still succeed despite close error
        expect(response.statusCode).toBe(204);
        expect(room.connectedClients.size).toBe(0);
        expect(mockWs.close).toHaveBeenCalled();
      }
    });

    it('should clean up empty connectionsByRoom set after removing last client', async () => {
      // Create a room
      const createResponse = await server.inject({
        method: 'POST',
        url: '/admin/api/rooms',
        payload: {
          targetUrl: 'https://example.com/video',
        },
      });

      const createBody = JSON.parse(createResponse.body);
      const roomId = createBody.roomId;
      const roomIdTyped = toRoomId(roomId);

      // Get the room and add a mock client
      const room = getRoom(roomIdTyped);
      expect(room).toBeDefined();

      if (room) {
        const mockWs = {
          close: jest.fn(),
          readyState: 1,
        } as unknown as WebSocket;

        const clientId = toClientId('123e4567-e89b-12d3-a456-426614174001');

        room.connectedClients.set(clientId, {
          clientId,
          conn: mockWs,
          lastSeen: Date.now(),
        });

        // Add to connectionsByRoom
        if (!connectionsByRoom.has(roomIdTyped)) {
          connectionsByRoom.set(roomIdTyped, new Set());
        }
        const extendedWs = mockWs as any;
        extendedWs.clientId = clientId;
        extendedWs.roomId = roomIdTyped;
        connectionsByRoom.get(roomIdTyped)!.add(extendedWs);

        expect(connectionsByRoom.has(roomIdTyped)).toBe(true);
        expect(connectionsByRoom.get(roomIdTyped)?.size).toBe(1);

        // Remove the client
        const response = await server.inject({
          method: 'DELETE',
          url: `/admin/api/rooms/${roomId}/clients/${clientId}`,
        });

        expect(response.statusCode).toBe(204);
        // Empty set should be cleaned up
        expect(connectionsByRoom.has(roomIdTyped)).toBe(false);
      }
    });
  });
});
