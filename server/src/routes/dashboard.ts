/**
 * Admin Dashboard plugin
 * Serves the admin dashboard HTML interface at /admin/dashboard
 */

import { FastifyPluginAsync } from 'fastify';
import fastifyStatic from '@fastify/static';
import path from 'path';
import { readFileSync } from 'fs';

/**
 * Dashboard plugin
 * Registers static file serving and serves dashboard.html at /admin/dashboard
 */
const dashboardPlugin: FastifyPluginAsync = async fastify => {
  // Register @fastify/static to serve files from the public directory
  // Using path.resolve to get absolute path relative to this file
  const publicDir = path.join(__dirname, '../../public');

  await fastify.register(fastifyStatic, {
    root: publicDir,
    prefix: '/admin/static/',
    decorateReply: false,
  });

  // Read dashboard HTML file once at startup
  const dashboardHtmlPath = path.join(publicDir, 'dashboard.html');
  const dashboardHtml = readFileSync(dashboardHtmlPath, 'utf-8');

  /**
   * GET /admin/dashboard - Serve the admin dashboard HTML page
   */
  fastify.get('/admin/dashboard', async (_request, reply) => {
    return reply.type('text/html').send(dashboardHtml);
  });
};

export default dashboardPlugin;
