/**
 * Branded types for UUID identifiers to prevent mixing roomId and clientId
 */

/**
 * Branded type for room ID (UUID v4 string)
 */
export type RoomId = string & { readonly __brand: 'RoomId' };

/**
 * Branded type for client ID (UUID v4 string)
 */
export type ClientId = string & { readonly __brand: 'ClientId' };

/**
 * Type guard to check if a string is a valid UUID format
 */
export function isValidUuid(value: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return uuidRegex.test(value);
}

/**
 * Create a RoomId from a string (with validation)
 */
export function toRoomId(value: string): RoomId {
  if (!isValidUuid(value)) {
    throw new Error(`Invalid UUID format for roomId: ${value}`);
  }
  return value as RoomId;
}

/**
 * Create a ClientId from a string (with validation)
 */
export function toClientId(value: string): ClientId {
  if (!isValidUuid(value)) {
    throw new Error(`Invalid UUID format for clientId: ${value}`);
  }
  return value as ClientId;
}
