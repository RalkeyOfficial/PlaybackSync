/**
 * PlaybackSync Server Entry Point
 */

import Fastify from 'fastify';
import { getConfig } from './config';

async function startServer() {
  const config = getConfig();
  const server = Fastify({
    logger: false, // Will be configured in Step 1.2
  });

  // Health check endpoint
  server.get('/healthz', async () => {
    return { status: 'ok' };
  });

  try {
    await server.listen({ port: config.port, host: '0.0.0.0' });
    console.log(`PlaybackSync Server listening on port ${config.port}`);
  } catch (error) {
    console.error('Error starting server:', error);
    process.exit(1);
  }

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`Received ${signal}, shutting down gracefully...`);
    try {
      await server.close();
      console.log('Server closed');
      process.exit(0);
    } catch (error) {
      console.error('Error during shutdown:', error);
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

startServer();
