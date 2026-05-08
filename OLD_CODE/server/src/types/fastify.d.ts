/**
 * TypeScript type extensions for Fastify
 */

import type { Room } from './room';

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * Validated room object (set by roomValidationPreHandler)
     * Available in route handlers after room validation middleware
     */
    room?: Room;
  }
}
