/**
 * Prometheus metrics setup and collection
 */

import { Registry, Gauge, collectDefaultMetrics } from 'prom-client';

/**
 * Create a new Prometheus registry
 */
const register = new Registry();

/**
 * Collect default Node.js metrics (memory, CPU, event loop, etc.)
 */
collectDefaultMetrics({ register });

/**
 * Process memory usage gauge (in bytes)
 */
export const processMemoryBytes = new Gauge({
  name: 'playbacksync_process_memory_bytes',
  help: 'Process memory usage in bytes',
  labelNames: ['type'] as const,
  registers: [register],
});

/**
 * Process CPU usage gauge (percentage)
 */
export const processCpuPercent = new Gauge({
  name: 'playbacksync_process_cpu_percent',
  help: 'Process CPU usage percentage',
  registers: [register],
});

/**
 * Process uptime gauge (in seconds)
 */
export const processUptimeSeconds = new Gauge({
  name: 'playbacksync_process_uptime_seconds',
  help: 'Process uptime in seconds',
  registers: [register],
});

/**
 * Update basic process metrics
 * Should be called periodically to update gauges
 */
export function updateProcessMetrics(): void {
  const memUsage = process.memoryUsage();

  // Update memory metrics
  processMemoryBytes.set({ type: 'rss' }, memUsage.rss);
  processMemoryBytes.set({ type: 'heapTotal' }, memUsage.heapTotal);
  processMemoryBytes.set({ type: 'heapUsed' }, memUsage.heapUsed);
  processMemoryBytes.set({ type: 'external' }, memUsage.external);

  // CPU usage is tracked by default metrics from prom-client
  // We'll track total CPU time here (user + system in seconds)
  const cpuUsage = process.cpuUsage();
  const totalCpuSeconds = (cpuUsage.user + cpuUsage.system) / 1000000;
  processCpuPercent.set(totalCpuSeconds);

  // Update uptime
  processUptimeSeconds.set(process.uptime());
}

/**
 * Get Prometheus metrics registry
 */
export function getMetricsRegistry(): Registry {
  return register;
}

/**
 * Get metrics in Prometheus text format
 */
export async function getMetricsAsText(): Promise<string> {
  updateProcessMetrics();
  return register.metrics();
}
