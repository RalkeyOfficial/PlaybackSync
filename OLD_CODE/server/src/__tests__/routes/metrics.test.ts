/**
 * Tests for the /metrics endpoint
 */

import { createTestServer } from '../helpers/test-server';
import { setupTestEnv, cleanupTestEnv } from '../helpers/fixtures';
import * as metricsUtils from '../../utils/metrics';

describe('Metrics Endpoint', () => {
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

  describe('GET /metrics', () => {
    it('should return 200 status code', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/metrics',
      });

      expect(response.statusCode).toBe(200);
    });

    it('should return Prometheus text format', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/metrics',
      });

      expect(response.headers['content-type']).toContain('text/plain');
      expect(response.headers['content-type']).toContain('version=0.0.4');
    });

    it('should return valid Prometheus metrics', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/metrics',
      });

      const body = response.body;
      expect(typeof body).toBe('string');
      expect(body.length).toBeGreaterThan(0);
    });

    it('should include process metrics', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/metrics',
      });

      const body = response.body;
      // Check for common Prometheus metrics
      expect(body).toContain('process_');
      expect(body).toContain('nodejs_');
    });

    it('should include playbacksync custom metrics', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/metrics',
      });

      const body = response.body;
      // Check for our custom metrics
      expect(body).toContain('playbacksync_process_memory_bytes');
      expect(body).toContain('playbacksync_process_uptime_seconds');
    });

    it('should return metrics in Prometheus format', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/metrics',
      });

      const body = response.body;
      // Prometheus format: metric_name{labels} value
      // Check for at least one metric line format
      const metricLinePattern = /^[a-zA-Z_:][a-zA-Z0-9_:]*(\{[^}]*\})?\s+[\d.]+/m;
      expect(body).toMatch(metricLinePattern);
    });

    it('should handle multiple requests correctly', async () => {
      const response1 = await server.inject({
        method: 'GET',
        url: '/metrics',
      });

      // Small delay to ensure uptime changes
      await new Promise(resolve => setTimeout(resolve, 10));

      const response2 = await server.inject({
        method: 'GET',
        url: '/metrics',
      });

      expect(response1.statusCode).toBe(200);
      expect(response2.statusCode).toBe(200);
      expect(response1.body).toBeTruthy();
      expect(response2.body).toBeTruthy();
    });

    it('should handle errors when generating metrics', async () => {
      // Mock getMetricsAsText to throw an error
      jest
        .spyOn(metricsUtils, 'getMetricsAsText')
        .mockRejectedValueOnce(new Error('Metrics generation failed'));

      const response = await server.inject({
        method: 'GET',
        url: '/metrics',
      });

      expect(response.statusCode).toBe(500);
      const body = JSON.parse(response.body);
      expect(body).toHaveProperty('error');
      expect(body.error).toBe('Failed to generate metrics');

      // Restore original function
      jest.restoreAllMocks();
    });
  });
});
