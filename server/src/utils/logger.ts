/**
 * Structured logging utility module using pino
 */

import pino from 'pino';
import { getConfig } from '../config';

const config = getConfig();

/**
 * Configure pino logger based on environment
 * - Development: Use pino-pretty for human-readable output
 * - Production: Use JSON format for structured logs
 */
const loggerOptions: pino.LoggerOptions = {
  level: config.logLevel,
};

// Use pino-pretty transport in development mode
if (config.nodeEnv === 'development') {
  loggerOptions.transport = {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'HH:MM:ss.l',
      ignore: 'pid,hostname',
    },
  };
}

/**
 * Main logger instance
 */
export const logger = pino(loggerOptions);

/**
 * Mask sensitive ID (e.g., clientId) when anonymization is enabled
 * Shows first 4 and last 4 characters with *** in between
 */
export function maskId(id: string): string {
  if (!config.anonLogging || !id) {
    return id;
  }

  if (id.length <= 8) {
    return '***';
  }

  const first = id.substring(0, 4);
  const last = id.substring(id.length - 4);
  return `${first}...${last}`;
}

/**
 * Redact IP address when anonymization is enabled
 */
export function redactIP(ip: string): string {
  if (!config.anonLogging || !ip) {
    return ip;
  }

  return '[REDACTED]';
}
