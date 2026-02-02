/**
 * Tests for the /healthz endpoint
 */

import { createTestServer } from '../helpers/test-server';
import { setupTestEnv, cleanupTestEnv } from '../helpers/fixtures';

describe('Healthz Endpoint', () => {
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

  describe('GET /healthz', () => {
    it('should return 200 status code', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/healthz',
      });

      expect(response.statusCode).toBe(200);
    });

    it('should return correct response schema', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/healthz',
      });

      const body = JSON.parse(response.body);
      expect(body).toHaveProperty('status');
      expect(body).toHaveProperty('timestamp');
      expect(body).toHaveProperty('uptime');
      expect(typeof body.status).toBe('string');
      expect(typeof body.timestamp).toBe('number');
      expect(typeof body.uptime).toBe('number');
    });

    it('should return status "ok"', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/healthz',
      });

      const body = JSON.parse(response.body);
      expect(body.status).toBe('ok');
    });

    it('should return a valid timestamp', async () => {
      const beforeRequest = Date.now();
      const response = await server.inject({
        method: 'GET',
        url: '/healthz',
      });
      const afterRequest = Date.now();

      const body = JSON.parse(response.body);
      expect(body.timestamp).toBeGreaterThanOrEqual(beforeRequest);
      expect(body.timestamp).toBeLessThanOrEqual(afterRequest);
    });

    it('should return a valid uptime value', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/healthz',
      });

      const body = JSON.parse(response.body);
      expect(body.uptime).toBeGreaterThanOrEqual(0);
      expect(typeof body.uptime).toBe('number');
    });

    it('should have correct content-type header', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/healthz',
      });

      expect(response.headers['content-type']).toContain('application/json');
    });
  });
});
