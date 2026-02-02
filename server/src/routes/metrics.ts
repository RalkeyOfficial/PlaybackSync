/**
 * Prometheus metrics endpoint plugin
 */

import { FastifyPluginAsync } from 'fastify';
import { getMetricsAsText } from '../utils/metrics';

/**
 * Metrics route plugin
 */
const metricsPlugin: FastifyPluginAsync = async fastify => {
  fastify.get('/metrics', async (request, reply) => {
    try {
      const metrics = await getMetricsAsText();
      reply.type('text/plain; version=0.0.4; charset=utf-8');
      return metrics;
    } catch (error) {
      fastify.log.error({ error }, 'Error generating metrics');
      reply.code(500);
      return { error: 'Failed to generate metrics' };
    }
  });
};

export default metricsPlugin;
