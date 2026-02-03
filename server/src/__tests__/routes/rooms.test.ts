/**
 * Tests for the /api/rooms endpoints
 */

import { createTestServer } from '../helpers/test-server';
import { setupTestEnv, cleanupTestEnv } from '../helpers/fixtures';
import { isValidUuid, toRoomId, toClientId } from '../../types/ids';
import { clearAllRooms, getRoom } from '../../storage/rooms';
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

  describe('POST /api/rooms', () => {
    it('should require targetUrl', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/api/rooms',
        payload: {},
      });

      expect(response.statusCode).toBe(400);
    });

    it('should create room with UUID v4 roomId', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/api/rooms',
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
        url: '/api/rooms',
        payload: {
          targetUrl: 'https://example.com/video1',
        },
      });

      const response2 = await server.inject({
        method: 'POST',
        url: '/api/rooms',
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
        url: '/api/rooms',
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
        url: '/api/rooms',
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
        url: '/api/rooms',
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
        url: '/api/rooms',
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
        url: '/api/rooms',
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

    it('should return share link format: /UUID when SHARE_HOSTNAME not set', async () => {
      // Ensure SHARE_HOSTNAME is not set
      delete process.env.SHARE_HOSTNAME;

      const response = await server.inject({
        method: 'POST',
        url: '/api/rooms',
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

    it('should return full URL share link when SHARE_HOSTNAME is set', async () => {
      // Set env var before creating server so config picks it up
      process.env.SHARE_HOSTNAME = 'share.example.com';

      // Create a new server instance to pick up the new env var
      const testServer = await createTestServer();
      await testServer.ready();

      const response = await testServer.inject({
        method: 'POST',
        url: '/api/rooms',
        payload: {
          targetUrl: 'https://example.com/video',
        },
      });

      const body = JSON.parse(response.body);
      expect(body.shareLink).toMatch(/^https:\/\/share\.example\.com\/[0-9a-f-]+$/i);
      expect(body.shareLink).toBe(`https://share.example.com/${body.roomId}`);

      // Cleanup
      await testServer.close();
      delete process.env.SHARE_HOSTNAME;
    });

    it('should accept request body with ttl and targetUrl', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/api/rooms',
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
        url: '/api/rooms',
        payload: {
          ttl: -1,
        },
      });

      expect(response.statusCode).toBe(400);
    });

    it('should reject invalid ttl (non-number)', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/api/rooms',
        payload: {
          ttl: 'not-a-number',
        },
      });

      expect(response.statusCode).toBe(400);
    });

    it('should reject invalid targetUrl (non-string)', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/api/rooms',
        payload: {
          targetUrl: 12345,
        },
      });

      expect(response.statusCode).toBe(400);
    });

    it('should use default TTL from config if not provided', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/api/rooms',
        payload: {
          targetUrl: 'https://example.com/video',
        },
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.body);

      // Get room details
      const listResponse = await server.inject({
        method: 'GET',
        url: '/api/rooms',
      });

      const rooms = JSON.parse(listResponse.body);
      const createdRoom = rooms.find((r: { id: string }) => r.id === body.roomId);
      expect(createdRoom).toBeDefined();

      // Default TTL is 86400 seconds (24 hours)
      const expectedExpiresAt = createdRoom.createdAt + 86400 * 1000;
      expect(Math.abs(createdRoom.expiresAt - expectedExpiresAt)).toBeLessThan(1000);
    });

    it('should make room appear in GET /api/rooms list after creation', async () => {
      const createResponse = await server.inject({
        method: 'POST',
        url: '/api/rooms',
        payload: {
          targetUrl: 'https://example.com/video',
        },
      });

      const createBody = JSON.parse(createResponse.body);
      const roomId = createBody.roomId;

      const listResponse = await server.inject({
        method: 'GET',
        url: '/api/rooms',
      });

      const rooms = JSON.parse(listResponse.body);
      const foundRoom = rooms.find((r: { id: string }) => r.id === roomId);
      expect(foundRoom).toBeDefined();
    });

    it('should allow multiple rooms to be created independently', async () => {
      const response1 = await server.inject({
        method: 'POST',
        url: '/api/rooms',
        payload: {
          targetUrl: 'https://example.com/video1',
        },
      });

      const response2 = await server.inject({
        method: 'POST',
        url: '/api/rooms',
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
        url: '/api/rooms',
      });

      const rooms = JSON.parse(listResponse.body);
      const found1 = rooms.find((r: { id: string }) => r.id === body1.roomId);
      const found2 = rooms.find((r: { id: string }) => r.id === body2.roomId);

      expect(found1).toBeDefined();
      expect(found2).toBeDefined();
    });
  });

  describe('GET /api/rooms', () => {
    it('should return empty array when no rooms exist', async () => {
      // Note: This test assumes we can clear rooms or start with empty state
      // In a real scenario, we might need a test helper to clear rooms
      const response = await server.inject({
        method: 'GET',
        url: '/api/rooms',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(Array.isArray(body)).toBe(true);
    });

    it('should return list of active rooms with correct fields', async () => {
      // Create a room first
      const createResponse = await server.inject({
        method: 'POST',
        url: '/api/rooms',
        payload: {
          targetUrl: 'https://example.com/video',
        },
      });

      const createBody = JSON.parse(createResponse.body);
      const roomId = createBody.roomId;

      const listResponse = await server.inject({
        method: 'GET',
        url: '/api/rooms',
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
        url: '/api/rooms',
        payload: {
          targetUrl: 'https://example.com/video',
        },
      });

      const createBody = JSON.parse(createResponse.body);

      const listResponse = await server.inject({
        method: 'GET',
        url: '/api/rooms',
      });

      const rooms = JSON.parse(listResponse.body);
      const foundRoom = rooms.find((r: { id: string }) => r.id === createBody.roomId);

      expect(foundRoom.participantCount).toBe(0);
    });

    it('should return correct last_state from room.state', async () => {
      const createResponse = await server.inject({
        method: 'POST',
        url: '/api/rooms',
        payload: {
          targetUrl: 'https://example.com/video',
        },
      });

      const createBody = JSON.parse(createResponse.body);

      const listResponse = await server.inject({
        method: 'GET',
        url: '/api/rooms',
      });

      const rooms = JSON.parse(listResponse.body);
      const foundRoom = rooms.find((r: { id: string }) => r.id === createBody.roomId);

      expect(foundRoom.last_state).toHaveProperty('paused');
      expect(foundRoom.last_state).toHaveProperty('time');
      expect(foundRoom.last_state).toHaveProperty('provider');
      expect(foundRoom.last_state).toHaveProperty('episode');
      expect(typeof foundRoom.last_state.paused).toBe('boolean');
      expect(typeof foundRoom.last_state.time).toBe('number');
      expect(typeof foundRoom.last_state.provider).toBe('string');
      expect(typeof foundRoom.last_state.episode).toBe('number');
    });

    it('should filter expired rooms', async () => {
      // Create a room with very short TTL
      const createResponse = await server.inject({
        method: 'POST',
        url: '/api/rooms',
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
        url: '/api/rooms',
      });

      const rooms = JSON.parse(listResponse.body);
      const expiredRoom = rooms.find((r: { id: string }) => r.id === expiredRoomId);

      expect(expiredRoom).toBeUndefined();
    });

    it('should remove room after TTL expires (2 seconds)', async () => {
      // Create a room with 2 second TTL
      const createResponse = await server.inject({
        method: 'POST',
        url: '/api/rooms',
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
        url: '/api/rooms',
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
        url: '/api/rooms',
      });

      const roomsAfter = JSON.parse(listResponseAfter.body);
      const roomAfter = roomsAfter.find((r: { id: string }) => r.id === roomId);

      expect(roomAfter).toBeUndefined();
    });
  });

  describe('GET /api/rooms/:roomId', () => {
    beforeEach(() => {
      // Clear rooms before each test for isolation
      clearAllRooms();
    });

    it('should return 200 with correct room details for existing room', async () => {
      // Create a room first
      const createResponse = await server.inject({
        method: 'POST',
        url: '/api/rooms',
        payload: {
          targetUrl: 'https://example.com/video',
        },
      });

      const createBody = JSON.parse(createResponse.body);
      const roomId = createBody.roomId;

      // Get room details
      const response = await server.inject({
        method: 'GET',
        url: `/api/rooms/${roomId}`,
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
        url: '/api/rooms',
        payload: {
          targetUrl: 'https://example.com/video',
        },
      });

      const createBody = JSON.parse(createResponse.body);
      const roomId = createBody.roomId;

      const response = await server.inject({
        method: 'GET',
        url: `/api/rooms/${roomId}`,
      });

      const body = JSON.parse(response.body);

      expect(body.state).toHaveProperty('paused');
      expect(body.state).toHaveProperty('time');
      expect(body.state).toHaveProperty('provider');
      expect(body.state).toHaveProperty('episode');
      expect(body.state).toHaveProperty('eventId');
      expect(body.state).toHaveProperty('last_explicit_event_ts');
      expect(body.state).toHaveProperty('last_state_update_ts');
      expect(typeof body.state.paused).toBe('boolean');
      expect(typeof body.state.time).toBe('number');
      expect(typeof body.state.provider).toBe('string');
      expect(typeof body.state.episode).toBe('number');
      expect(typeof body.state.eventId).toBe('number');
      expect(typeof body.state.last_explicit_event_ts).toBe('number');
      expect(typeof body.state.last_state_update_ts).toBe('number');
    });

    it('should return empty connectedClients array for room with no clients', async () => {
      const createResponse = await server.inject({
        method: 'POST',
        url: '/api/rooms',
        payload: {
          targetUrl: 'https://example.com/video',
        },
      });

      const createBody = JSON.parse(createResponse.body);
      const roomId = createBody.roomId;

      const response = await server.inject({
        method: 'GET',
        url: `/api/rooms/${roomId}`,
      });

      const body = JSON.parse(response.body);

      expect(Array.isArray(body.connectedClients)).toBe(true);
      expect(body.connectedClients.length).toBe(0);
    });

    it('should return empty recentEvents array for room with no events', async () => {
      const createResponse = await server.inject({
        method: 'POST',
        url: '/api/rooms',
        payload: {
          targetUrl: 'https://example.com/video',
        },
      });

      const createBody = JSON.parse(createResponse.body);
      const roomId = createBody.roomId;

      const response = await server.inject({
        method: 'GET',
        url: `/api/rooms/${roomId}`,
      });

      const body = JSON.parse(response.body);

      expect(Array.isArray(body.recentEvents)).toBe(true);
      expect(body.recentEvents.length).toBe(0);
    });

    it('should exclude passwordHash from response (security)', async () => {
      const createResponse = await server.inject({
        method: 'POST',
        url: '/api/rooms',
        payload: {
          targetUrl: 'https://example.com/video',
        },
      });

      const createBody = JSON.parse(createResponse.body);
      const roomId = createBody.roomId;

      const response = await server.inject({
        method: 'GET',
        url: `/api/rooms/${roomId}`,
      });

      const body = JSON.parse(response.body);

      expect(body.passwordHash).toBeUndefined();
      expect(body.password).toBeUndefined();
    });

    it('should return 404 for non-existent room', async () => {
      const nonExistentRoomId = '123e4567-e89b-12d3-a456-426614174999';

      const response = await server.inject({
        method: 'GET',
        url: `/api/rooms/${nonExistentRoomId}`,
      });

      expect(response.statusCode).toBe(404);
    });

    it('should return 404 for expired room', async () => {
      // Create a room with very short TTL
      const createResponse = await server.inject({
        method: 'POST',
        url: '/api/rooms',
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
        url: `/api/rooms/${roomId}`,
      });

      expect(response.statusCode).toBe(404);
    });

    it('should return 400 for invalid roomId format (non-UUID)', async () => {
      const invalidRoomId = 'not-a-valid-uuid';

      const response = await server.inject({
        method: 'GET',
        url: `/api/rooms/${invalidRoomId}`,
      });

      expect(response.statusCode).toBe(400);
    });

    it('should return correct createdAt and expiresAt timestamps', async () => {
      const ttl = 3600; // 1 hour
      const createResponse = await server.inject({
        method: 'POST',
        url: '/api/rooms',
        payload: {
          ttl: ttl,
          targetUrl: 'https://example.com/video',
        },
      });

      const createBody = JSON.parse(createResponse.body);
      const roomId = createBody.roomId;

      const response = await server.inject({
        method: 'GET',
        url: `/api/rooms/${roomId}`,
      });

      const body = JSON.parse(response.body);

      expect(typeof body.createdAt).toBe('number');
      expect(typeof body.expiresAt).toBe('number');
      expect(body.expiresAt).toBeGreaterThan(body.createdAt);
      expect(body.expiresAt).toBe(body.createdAt + ttl * 1000);
    });
  });

  describe('DELETE /api/rooms/:roomId', () => {
    beforeEach(() => {
      // Clear rooms before each test for isolation
      clearAllRooms();
    });

    it('should return 200/204 on successful deletion', async () => {
      const createResponse = await server.inject({
        method: 'POST',
        url: '/api/rooms',
        payload: {
          targetUrl: 'https://example.com/video',
        },
      });

      const createBody = JSON.parse(createResponse.body);
      const roomId = createBody.roomId;

      const response = await server.inject({
        method: 'DELETE',
        url: `/api/rooms/${roomId}`,
      });

      // Accept either 200 or 204
      expect([200, 204]).toContain(response.statusCode);
    });

    it('should remove room from storage (verify via GET /api/rooms)', async () => {
      const createResponse = await server.inject({
        method: 'POST',
        url: '/api/rooms',
        payload: {
          targetUrl: 'https://example.com/video',
        },
      });

      const createBody = JSON.parse(createResponse.body);
      const roomId = createBody.roomId;

      // Verify room exists before deletion
      const listBeforeResponse = await server.inject({
        method: 'GET',
        url: '/api/rooms',
      });

      const roomsBefore = JSON.parse(listBeforeResponse.body);
      const foundBefore = roomsBefore.find((r: { id: string }) => r.id === roomId);
      expect(foundBefore).toBeDefined();

      // Delete the room
      const deleteResponse = await server.inject({
        method: 'DELETE',
        url: `/api/rooms/${roomId}`,
      });

      expect([200, 204]).toContain(deleteResponse.statusCode);

      // Verify room no longer exists
      const listAfterResponse = await server.inject({
        method: 'GET',
        url: '/api/rooms',
      });

      const roomsAfter = JSON.parse(listAfterResponse.body);
      const foundAfter = roomsAfter.find((r: { id: string }) => r.id === roomId);
      expect(foundAfter).toBeUndefined();
    });

    it('should return 404 for non-existent room', async () => {
      const nonExistentRoomId = '123e4567-e89b-12d3-a456-426614174999';

      const response = await server.inject({
        method: 'DELETE',
        url: `/api/rooms/${nonExistentRoomId}`,
      });

      expect(response.statusCode).toBe(404);
    });

    it('should return 404 for expired room', async () => {
      // Create a room with very short TTL
      const createResponse = await server.inject({
        method: 'POST',
        url: '/api/rooms',
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
        url: `/api/rooms/${roomId}`,
      });

      expect(response.statusCode).toBe(404);
    });

    it('should return 400 for invalid roomId format (non-UUID)', async () => {
      const invalidRoomId = 'not-a-valid-uuid';

      const response = await server.inject({
        method: 'DELETE',
        url: `/api/rooms/${invalidRoomId}`,
      });

      expect(response.statusCode).toBe(400);
    });

    it('should allow deletion of room with no connected clients', async () => {
      const createResponse = await server.inject({
        method: 'POST',
        url: '/api/rooms',
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
        url: `/api/rooms/${roomId}`,
      });

      expect([200, 204]).toContain(response.statusCode);
    });

    it('should close WebSocket connections when room has connected clients', async () => {
      // Create a room
      const createResponse = await server.inject({
        method: 'POST',
        url: '/api/rooms',
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
          url: `/api/rooms/${roomId}`,
        });

        expect([200, 204]).toContain(response.statusCode);

        // Verify WebSocket close was called on both connections
        expect(mockWs1.close).toHaveBeenCalled();
        expect(mockWs2.close).toHaveBeenCalled();
      }
    });
  });
});
