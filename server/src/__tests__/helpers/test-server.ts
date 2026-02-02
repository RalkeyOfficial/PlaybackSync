/**
 * Test utilities for creating Fastify test server instances
 */

import Fastify from 'fastify';
import pino from 'pino';
import healthzPlugin from '../../routes/healthz';
import metricsPlugin from '../../routes/metrics';

/**
 * Create a mock logger that captures log calls for testing
 */
export function createMockLogger() {
  const logs: Array<{ level: string; msg: string; [key: string]: unknown }> = [];

  const logger = pino(
    {
      level: 'silent', // Suppress log output during tests
    },
    {
      write: (msg: string) => {
        try {
          const logEntry = JSON.parse(msg);
          logs.push(logEntry);
        } catch {
          // Ignore non-JSON log entries
        }
      },
    }
  );

  return {
    logger,
    logs,
    clear: () => {
      logs.length = 0;
    },
  };
}

/**
 * Create a test Fastify server instance with all routes registered
 * Useful for testing HTTP endpoints
 */
export async function createTestServer() {
  const server = Fastify({
    logger: false, // Disable logging in tests unless needed
    ajv: {
      customOptions: {
        removeAdditional: 'all',
        coerceTypes: true,
        useDefaults: true,
      },
    },
  });

  // Register route plugins
  await server.register(healthzPlugin);
  await server.register(metricsPlugin);

  return server;
}

/**
 * Create a test server with a custom logger (e.g., mock logger)
 */
export async function createTestServerWithLogger(logger: pino.Logger) {
  const server = Fastify({
    logger,
    ajv: {
      customOptions: {
        removeAdditional: 'all',
        coerceTypes: true,
        useDefaults: true,
      },
    },
  });

  // Register route plugins
  await server.register(healthzPlugin);
  await server.register(metricsPlugin);

  return server;
}
