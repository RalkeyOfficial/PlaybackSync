/**
 * Configuration module for environment variables
 */

export type LogLevel = 'error' | 'warn' | 'info' | 'debug' | 'silent';
export type NodeEnv = 'development' | 'production';

export interface Config {
  /** HTTP server port number (default: 8080) */
  port: number;
  /** Logging level: 'error', 'warn', 'info', 'debug' (default: 'info') */
  logLevel: LogLevel;
  /** Node.js environment: 'development' or 'production' (default: 'development') */
  nodeEnv: NodeEnv;
  /** Whether to anonymize sensitive data in logs (IPs, clientIds) (default: true) */
  anonLogging: boolean;
  /** Room expiration time in seconds - rooms are deleted after this duration (default: 86400 = 24h) */
  roomTtlSeconds: number;
  /** Maximum acceptable time drift in milliseconds before triggering correction (default: 500 = 0.5s) */
  driftThresholdMs: number;
  /** Threshold in milliseconds under which nudge-rate correction is preferred (default: 200 = 0.2s) */
  nudgeThresholdMs: number;
  /** Threshold in milliseconds above which seek correction is preferred (default: 500 = 0.5s) */
  seekThresholdMs: number;
  /** Cooldown window in milliseconds after explicit events - reconciliation is suspended during this period (default: 3000 = 3s) */
  cooldownWindowMs: number;
  /** Tombstone duration in milliseconds - allows clients to reconnect with same clientId within this window (default: 30000 = 30s) */
  clientTombstoneMs: number;
  /** Maximum number of explicit events (play/pause/seek) allowed per second per connection (default: 10) */
  rateLimitEventsPerSec: number;
  /** Connection timeout in milliseconds - connections must send JOIN within this time (default: 5000 = 5s) */
  joinTimeoutMs: number;
  /** Maximum WebSocket message size in bytes to prevent memory exhaustion (default: 65536 = 64KB) */
  maxMessageSizeBytes: number;
  /** Maximum number of connections allowed per room (default: 50) */
  maxConnectionsPerRoom: number;
  /** Maximum broadcast rate per room in messages per second (default: 20) */
  maxBroadcastRatePerSec: number;
  /** Hostname for share links (used in room creation responses) - optional */
  shareHostname?: string;
  /** WebSocket hostname (used for client connection parameters) - optional */
  syncHostname?: string;
  /** Server secret key used for HMAC password hashing - required for security */
  serverSecret: string;
}

/**
 * Get configuration from environment variables with defaults
 */
export function getConfig(): Config {
  const serverSecret = process.env.SERVER_SECRET;
  if (!serverSecret) {
    throw new Error('SERVER_SECRET environment variable is required');
  }

  return {
    port: parseInt(process.env.PORT || '8080', 10),
    logLevel: (process.env.LOG_LEVEL as LogLevel) || 'info',
    nodeEnv: (process.env.NODE_ENV as NodeEnv) || 'development',
    anonLogging: process.env.ANON_LOGGING !== 'false',
    roomTtlSeconds: parseInt(process.env.ROOM_TTL_SECONDS || '86400', 10),
    driftThresholdMs: parseInt(process.env.DRIFT_THRESHOLD_MS || '500', 10),
    nudgeThresholdMs: parseInt(process.env.NUDGE_THRESHOLD_MS || '200', 10),
    seekThresholdMs: parseInt(process.env.SEEK_THRESHOLD_MS || '500', 10),
    cooldownWindowMs: parseInt(process.env.COOLDOWN_WINDOW_MS || '3000', 10),
    clientTombstoneMs: parseInt(process.env.CLIENT_TOMBSTONE_MS || '30000', 10),
    rateLimitEventsPerSec: parseInt(process.env.RATE_LIMIT_EVENTS_PER_SEC || '10', 10),
    joinTimeoutMs: parseInt(process.env.JOIN_TIMEOUT_MS || '5000', 10),
    maxMessageSizeBytes: parseInt(process.env.MAX_MESSAGE_SIZE_BYTES || '65536', 10),
    maxConnectionsPerRoom: parseInt(process.env.MAX_CONNECTIONS_PER_ROOM || '50', 10),
    maxBroadcastRatePerSec: parseInt(process.env.MAX_BROADCAST_RATE_PER_SEC || '20', 10),
    shareHostname: process.env.SHARE_HOSTNAME,
    syncHostname: process.env.SYNC_HOSTNAME,
    serverSecret,
  };
}
