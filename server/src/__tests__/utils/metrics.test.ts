/**
 * Tests for metrics utility functions
 */

import { getMetricsRegistry, updateProcessMetrics } from '../../utils/metrics';
import { Registry } from 'prom-client';

describe('Metrics Utilities', () => {
  describe('getMetricsRegistry', () => {
    it('should return a Prometheus Registry instance', () => {
      const registry = getMetricsRegistry();
      expect(registry).toBeInstanceOf(Registry);
    });

    it('should return the same registry instance on multiple calls', () => {
      const registry1 = getMetricsRegistry();
      const registry2 = getMetricsRegistry();
      expect(registry1).toBe(registry2);
    });
  });

  describe('updateProcessMetrics', () => {
    it('should update process metrics without throwing', () => {
      expect(() => updateProcessMetrics()).not.toThrow();
    });

    it('should update memory metrics', async () => {
      updateProcessMetrics();
      const registry = getMetricsRegistry();
      const metrics = await registry.metrics();
      expect(metrics).toContain('playbacksync_process_memory_bytes');
    });

    it('should update uptime metrics', async () => {
      updateProcessMetrics();
      const registry = getMetricsRegistry();
      const metrics = await registry.metrics();
      expect(metrics).toContain('playbacksync_process_uptime_seconds');
    });
  });
});
