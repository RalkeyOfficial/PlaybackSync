/**
 * Health check endpoint plugin
 */

import { FastifyPluginAsync } from 'fastify';

/**
 * Health check response schema
 */
const healthResponseSchema = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['ok'] },
    timestamp: { type: 'number' },
    uptime: { type: 'number' },
  },
  required: ['status', 'timestamp', 'uptime'],
} as const;

/**
 * Health check route plugin
 */
const healthzPlugin: FastifyPluginAsync = async fastify => {
  fastify.get(
    '/healthz',
    {
      schema: {
        response: {
          200: healthResponseSchema,
        },
      },
    },
    async () => {
      return {
        status: 'ok',
        timestamp: Date.now(),
        uptime: process.uptime(),
      };
    }
  );
};

export default healthzPlugin;
