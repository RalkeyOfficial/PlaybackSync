/**
 * WebSocket connection utility functions
 * Helper functions for connection management and content key computation
 */

import { randomUUID, createHash } from 'crypto';
import { logger } from './logger';
import type { RoomId, ClientId } from '../types/ids';
import { toRoomId, isValidUuid } from '../types/ids';
import type { Room } from '../types/room';

/**
 * Maximum number of events to keep in event log (ring buffer size)
 */
export const MAX_EVENT_LOG_SIZE = 100;

/**
 * Generate a new client ID (UUID v4)
 */
export function generateClientId(): ClientId {
  return randomUUID() as ClientId;
}

/**
 * Extract roomId from WebSocket URL path
 * Expected format: /{roomId} or /{roomId}?query=params
 */
export function extractRoomIdFromUrl(url: string | undefined): RoomId | null {
  if (!url) {
    return null;
  }

  // Remove query string and hash if present
  const path = url.split('?')[0].split('#')[0];

  // Extract roomId from path (should be /{roomId})
  const match = path.match(/^\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  if (!match || !match[1]) {
    return null;
  }

  const roomIdString = match[1];
  if (!isValidUuid(roomIdString)) {
    return null;
  }

  return toRoomId(roomIdString);
}

/**
 * Add event to event log (ring buffer)
 */
export function addEventToLog(
  room: Room,
  eventType: string,
  value: number | string | undefined,
  clientId: ClientId
): void {
  const event: Room['eventLog'][0] = {
    type: eventType,
    clientId,
    ts: Date.now(),
    eventId: room.state.eventId,
  };

  if (value !== undefined) {
    event.value = value;
  }

  room.eventLog.push(event);

  // Maintain ring buffer size
  if (room.eventLog.length > MAX_EVENT_LOG_SIZE) {
    room.eventLog.shift(); // Remove oldest event
  }
}

/**
 * Compute derivedContentKey from URL + provider + episode
 * Uses SHA-256 hash of normalized URL path + providerId + episodeId
 */
export function computeDerivedContentKey(
  pageUrl: string,
  providerId: string,
  episodeId: string | number
): string {
  try {
    // Normalize URL (remove query params and hash for consistency)
    const normalizedUrl = new URL(pageUrl).pathname;
    const keyString = `${providerId}:${normalizedUrl}:${episodeId}`;
    return createHash('sha256').update(keyString).digest('hex');
  } catch (error) {
    // If URL parsing fails, use the full URL as-is
    logger.warn({ error, pageUrl }, 'Failed to parse URL for derivedContentKey, using full URL');
    const keyString = `${providerId}:${pageUrl}:${episodeId}`;
    return createHash('sha256').update(keyString).digest('hex');
  }
}
