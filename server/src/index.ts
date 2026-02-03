/**
 * PlaybackSync Server Entry Point
 */

import Fastify from 'fastify';
import { getConfig } from './config';
import { logger } from './utils/logger';
import healthzPlugin from './routes/healthz';
import metricsPlugin from './routes/metrics';
import roomsPlugin from './routes/rooms';
import sharePlugin from './routes/share';
import { runCleanupTask } from './utils/room-cleanup';

async function startServer() {
  const config = getConfig();
  const server = Fastify({
    logger,
    // Enable JSON schema validation
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
  await server.register(roomsPlugin);
  await server.register(sharePlugin);

  try {
    await server.listen({ port: config.port, host: '0.0.0.0' });
  } catch (error) {
    logger.error({ error }, 'Error starting server');
    process.exit(1);
  }

  // Start background cleanup task (runs every 60 seconds)
  const cleanupInterval = setInterval(runCleanupTask, 60000);
  logger.info('Background room cleanup task started (interval: 60s)');

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down gracefully');
    try {
      // Clear cleanup interval
      clearInterval(cleanupInterval);
      logger.info('Cleanup interval cleared');

      // Run final cleanup before shutdown
      runCleanupTask();

      await server.close();
      logger.info('Server closed');
      process.exit(0);
    } catch (error) {
      logger.error({ error }, 'Error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

startServer();
