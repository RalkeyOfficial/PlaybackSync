/**
 * Tests for the public share endpoint GET /:roomId
 * Uses HTTP Basic Authentication - browser shows login prompt automatically
 */

import { createTestServer } from '../helpers/test-server';
import { setupTestEnv, cleanupTestEnv } from '../helpers/fixtures';
import { isValidUuid, toRoomId } from '../../types/ids';
import { clearAllRooms, createRoom } from '../../storage/rooms';
import { hashPassword } from '../../utils/password';
import { getConfig } from '../../config';

describe('Public Share Endpoint', () => {
  let server: Awaited<ReturnType<typeof createTestServer>>;
  const config = getConfig();

  beforeAll(async () => {
    setupTestEnv();
    server = await createTestServer();
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
    cleanupTestEnv();
  });

  beforeEach(() => {
    // Clear rooms before each test for isolation
    clearAllRooms();
  });

  describe('GET /:roomId', () => {
    it('should validate roomId format (UUID v4)', async () => {
      const invalidRoomId = 'not-a-valid-uuid';

      const response = await server.inject({
        method: 'GET',
        url: `/${invalidRoomId}`,
      });

      expect(response.statusCode).toBe(400);
    });

    it('should return 404 for non-existent room', async () => {
      const nonExistentRoomId = '123e4567-e89b-12d3-a456-426614174999';

      const response = await server.inject({
        method: 'GET',
        url: `/${nonExistentRoomId}`,
      });

      expect(response.statusCode).toBe(404);
    });

    it('should return 404 for expired room', async () => {
      // Create a room with very short TTL
      const roomId = toRoomId('123e4567-e89b-12d3-a456-426614174001');
      const password = 'testPassword123';
      const passwordHash = hashPassword(password, config.serverSecret);

      createRoom(roomId, passwordHash, 1, 'https://example.com/video'); // 1 second TTL

      // Wait for expiration
      await new Promise(resolve => setTimeout(resolve, 1100));

      const response = await server.inject({
        method: 'GET',
        url: `/${roomId}`,
      });

      expect(response.statusCode).toBe(404);
    });

    it('should return 401 with WWW-Authenticate header when no Authorization header provided', async () => {
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

      const response = await server.inject({
        method: 'GET',
        url: `/${roomId}`,
      });

      expect(response.statusCode).toBe(401);
      expect(response.headers['www-authenticate']).toBeDefined();
      expect(response.headers['www-authenticate']).toMatch(/^Basic/i);
    });

    it('should return 401 with WWW-Authenticate header for existing room (triggers browser prompt)', async () => {
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

      const response = await server.inject({
        method: 'GET',
        url: `/${roomId}`,
      });

      expect(response.statusCode).toBe(401);
      expect(response.headers['www-authenticate']).toBeDefined();
      // Browser will show login prompt based on this header
    });

    it('should validate password via Authorization header and redirect on success', async () => {
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
      const password = createBody.password;

      // Create Basic Auth header (username can be ignored, password is used)
      // Format: "username:password" encoded in base64
      // Since username is ignored, we use empty username: ":password"
      const authString = Buffer.from(`:${password}`).toString('base64');

      const response = await server.inject({
        method: 'GET',
        url: `/${roomId}`,
        headers: {
          Authorization: `Basic ${authString}`,
        },
      });

      // Should redirect on successful authentication
      expect([301, 302]).toContain(response.statusCode);
      expect(response.headers.location).toBeDefined();
    });

    it('should return 401/403 for invalid password in Authorization header', async () => {
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

      // Create Basic Auth header with wrong password
      const authString = Buffer.from(`:wrongPassword`).toString('base64');

      const response = await server.inject({
        method: 'GET',
        url: `/${roomId}`,
        headers: {
          Authorization: `Basic ${authString}`,
        },
      });

      expect([401, 403]).toContain(response.statusCode);
    });

    it('should handle Basic Auth with empty username (username field ignored)', async () => {
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
      const password = createBody.password;

      // Create Basic Auth header with empty username (username field ignored per spec)
      const authString = Buffer.from(`:${password}`).toString('base64');

      const response = await server.inject({
        method: 'GET',
        url: `/${roomId}`,
        headers: {
          Authorization: `Basic ${authString}`,
        },
      });

      // Should accept Basic Auth with empty username and redirect
      expect([301, 302]).toContain(response.statusCode);
    });

    it('should redirect to targetUrl with sync parameters on successful authentication', async () => {
      // Set SYNC_HOSTNAME for WebSocket URL construction
      const originalSyncHostname = process.env.SYNC_HOSTNAME;
      process.env.SYNC_HOSTNAME = 'sync.example.com';

      // Create a new server instance to pick up the new env var
      const testServer = await createTestServer();
      await testServer.ready();

      try {
        // Create a room first
        const createResponse = await testServer.inject({
          method: 'POST',
          url: '/api/rooms',
          payload: {
            targetUrl: 'https://example.com/video',
          },
        });

        const createBody = JSON.parse(createResponse.body);
        const roomId = createBody.roomId;
        const password = createBody.password;

        // Create Basic Auth header
        const authString = Buffer.from(`:${password}`).toString('base64');

        const response = await testServer.inject({
          method: 'GET',
          url: `/${roomId}`,
          headers: {
            Authorization: `Basic ${authString}`,
          },
        });

        // Should redirect with sync parameters
        expect([301, 302]).toContain(response.statusCode);
        const location = response.headers.location;
        expect(location).toBeDefined();
        expect(location).toContain('https://example.com/video');
        expect(location).toContain('sync_url=');
        expect(location).toContain('sync_password=');
        // URL is encoded in query parameters, so decode it for checking
        if (location) {
          const decodedLocation = decodeURIComponent(location);
          expect(decodedLocation).toContain(`wss://sync.example.com/${roomId}`);
        }
      } finally {
        await testServer.close();
        if (originalSyncHostname) {
          process.env.SYNC_HOSTNAME = originalSyncHostname;
        } else {
          delete process.env.SYNC_HOSTNAME;
        }
      }
    });

    it('should format sync_url correctly with SYNC_HOSTNAME', async () => {
      // Set SYNC_HOSTNAME
      const originalSyncHostname = process.env.SYNC_HOSTNAME;
      process.env.SYNC_HOSTNAME = 'wss.example.com';

      // Create a new server instance to pick up the new env var
      const testServer = await createTestServer();
      await testServer.ready();

      try {
        // Create a room first
        const createResponse = await testServer.inject({
          method: 'POST',
          url: '/api/rooms',
          payload: {
            targetUrl: 'https://netflix.com/watch/12345',
          },
        });

        const createBody = JSON.parse(createResponse.body);
        const roomId = createBody.roomId;
        const password = createBody.password;

        // Create Basic Auth header
        const authString = Buffer.from(`:${password}`).toString('base64');

        const response = await testServer.inject({
          method: 'GET',
          url: `/${roomId}`,
          headers: {
            Authorization: `Basic ${authString}`,
          },
        });

        // Extract redirect URL
        expect([301, 302]).toContain(response.statusCode);
        const location = response.headers.location;
        expect(location).toBeDefined();
        if (!location) throw new Error('Location header missing');

        const url = new URL(location);
        const syncUrl = url.searchParams.get('sync_url');
        expect(syncUrl).toBe(`wss://wss.example.com/${roomId}`);
      } finally {
        await testServer.close();
        if (originalSyncHostname) {
          process.env.SYNC_HOSTNAME = originalSyncHostname;
        } else {
          delete process.env.SYNC_HOSTNAME;
        }
      }
    });

    it('should include sync_password parameter in redirect URL', async () => {
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
      const password = createBody.password;

      // Create Basic Auth header
      const authString = Buffer.from(`:${password}`).toString('base64');

      const response = await server.inject({
        method: 'GET',
        url: `/${roomId}`,
        headers: {
          Authorization: `Basic ${authString}`,
        },
      });

      // Extract redirect URL
      expect([301, 302]).toContain(response.statusCode);
      const location = response.headers.location;
      expect(location).toBeDefined();
      if (!location) throw new Error('Location header missing');

      const url = new URL(location);
      const syncPassword = url.searchParams.get('sync_password');
      expect(syncPassword).toBe(password);
    });

    it('should construct sync_url using SYNC_HOSTNAME environment variable', async () => {
      // Set SYNC_HOSTNAME
      const originalSyncHostname = process.env.SYNC_HOSTNAME;
      process.env.SYNC_HOSTNAME = 'websocket.example.com';

      // Create a new server instance to pick up the new env var
      const testServer = await createTestServer();
      await testServer.ready();

      try {
        // Create a room first
        const createResponse = await testServer.inject({
          method: 'POST',
          url: '/api/rooms',
          payload: {
            targetUrl: 'https://example.com/video',
          },
        });

        const createBody = JSON.parse(createResponse.body);
        const roomId = createBody.roomId;
        const password = createBody.password;

        // Create Basic Auth header
        const authString = Buffer.from(`:${password}`).toString('base64');

        const response = await testServer.inject({
          method: 'GET',
          url: `/${roomId}`,
          headers: {
            Authorization: `Basic ${authString}`,
          },
        });

        // Extract redirect URL
        expect([301, 302]).toContain(response.statusCode);
        const location = response.headers.location;
        expect(location).toBeDefined();
        if (!location) throw new Error('Location header missing');

        const url = new URL(location);
        const syncUrl = url.searchParams.get('sync_url');
        // Should use SYNC_HOSTNAME from environment
        expect(syncUrl).toContain('websocket.example.com');
        expect(syncUrl).toMatch(/^wss:\/\//);
      } finally {
        await testServer.close();
        if (originalSyncHostname) {
          process.env.SYNC_HOSTNAME = originalSyncHostname;
        } else {
          delete process.env.SYNC_HOSTNAME;
        }
      }
    });

    it('should preserve targetUrl query parameters in redirect', async () => {
      // Create a room with targetUrl that has query parameters
      const createResponse = await server.inject({
        method: 'POST',
        url: '/api/rooms',
        payload: {
          targetUrl: 'https://example.com/video?episode=5&season=2',
        },
      });

      const createBody = JSON.parse(createResponse.body);
      const roomId = createBody.roomId;
      const password = createBody.password;

      // Create Basic Auth header
      const authString = Buffer.from(`:${password}`).toString('base64');

      const response = await server.inject({
        method: 'GET',
        url: `/${roomId}`,
        headers: {
          Authorization: `Basic ${authString}`,
        },
      });

      // Extract redirect URL
      expect([301, 302]).toContain(response.statusCode);
      const location = response.headers.location;
      expect(location).toBeDefined();
      if (!location) throw new Error('Location header missing');

      const url = new URL(location);
      // Should preserve original query parameters
      expect(url.searchParams.get('episode')).toBe('5');
      expect(url.searchParams.get('season')).toBe('2');
      // Should add sync parameters
      expect(url.searchParams.get('sync_url')).toBeDefined();
      expect(url.searchParams.get('sync_password')).toBeDefined();
    });

    it('should handle multiple authentication attempts correctly', async () => {
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
      const correctPassword = createBody.password;

      // First attempt with wrong password
      const wrongAuthString = Buffer.from(`:wrongPassword`).toString('base64');
      const wrongResponse = await server.inject({
        method: 'GET',
        url: `/${roomId}`,
        headers: {
          Authorization: `Basic ${wrongAuthString}`,
        },
      });

      expect([401, 403]).toContain(wrongResponse.statusCode);

      // Second attempt with correct password
      const correctAuthString = Buffer.from(`:${correctPassword}`).toString('base64');
      const correctResponse = await server.inject({
        method: 'GET',
        url: `/${roomId}`,
        headers: {
          Authorization: `Basic ${correctAuthString}`,
        },
      });

      // Should succeed on second attempt
      expect([301, 302]).toContain(correctResponse.statusCode);
    });

    it('should handle roomId with valid UUID format', async () => {
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

      // Verify it's a valid UUID
      expect(isValidUuid(roomId)).toBe(true);

      // Without auth, should return 401
      const response = await server.inject({
        method: 'GET',
        url: `/${roomId}`,
      });

      // Should return 401 (Basic Auth challenge)
      expect(response.statusCode).toBe(401);
    });
  });

  describe('Share endpoint integration with room creation', () => {
    it('should have shareLink pointing to GET /:roomId endpoint', async () => {
      // Create a room
      const createResponse = await server.inject({
        method: 'POST',
        url: '/api/rooms',
        payload: {
          targetUrl: 'https://example.com/video',
        },
      });

      const createBody = JSON.parse(createResponse.body);
      const roomId = createBody.roomId;
      const shareLink = createBody.shareLink;

      // Share link should point to /:roomId (without /api prefix)
      expect(shareLink).toContain(`/${roomId}`);
      expect(shareLink).not.toContain('/api/');

      // Verify the share endpoint exists and returns Basic Auth challenge
      const shareResponse = await server.inject({
        method: 'GET',
        url: `/${roomId}`,
      });

      // Should return 401 with WWW-Authenticate header (triggers browser prompt)
      expect(shareResponse.statusCode).toBe(401);
      expect(shareResponse.headers['www-authenticate']).toBeDefined();
    });

    it('should be separate from admin endpoint GET /api/rooms/:roomId', async () => {
      // Create a room
      const createResponse = await server.inject({
        method: 'POST',
        url: '/api/rooms',
        payload: {
          targetUrl: 'https://example.com/video',
        },
      });

      const createBody = JSON.parse(createResponse.body);
      const roomId = createBody.roomId;

      // Public share endpoint (GET /:roomId) - returns Basic Auth challenge
      const shareResponse = await server.inject({
        method: 'GET',
        url: `/${roomId}`,
      });

      // Admin endpoint (GET /api/rooms/:roomId) - returns JSON
      const adminResponse = await server.inject({
        method: 'GET',
        url: `/api/rooms/${roomId}`,
      });

      // Share endpoint should return 401 (Basic Auth challenge)
      expect(shareResponse.statusCode).toBe(401);
      expect(shareResponse.headers['www-authenticate']).toBeDefined();

      // Admin endpoint should return JSON
      expect(adminResponse.statusCode).toBe(200);
      expect(adminResponse.headers['content-type']).toContain('application/json');
    });
  });
});
