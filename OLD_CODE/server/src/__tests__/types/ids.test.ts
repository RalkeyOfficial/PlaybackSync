/**
 * Tests for UUID identifier utilities
 */

import { isValidUuid, toRoomId, toClientId } from '../../types/ids';

describe('UUID Identifier Utilities', () => {
  const validUuid = '550e8400-e29b-41d4-a716-446655440000';
  const invalidUuid = 'not-a-uuid';
  const invalidFormatUuid = '550e8400e29b41d4a716446655440000'; // missing dashes

  describe('isValidUuid', () => {
    it('should return true for valid UUID v4 format', () => {
      expect(isValidUuid(validUuid)).toBe(true);
    });

    it('should return false for invalid UUID format', () => {
      expect(isValidUuid(invalidUuid)).toBe(false);
    });

    it('should return false for UUID without dashes', () => {
      expect(isValidUuid(invalidFormatUuid)).toBe(false);
    });

    it('should return false for empty string', () => {
      expect(isValidUuid('')).toBe(false);
    });

    it('should be case-insensitive', () => {
      expect(isValidUuid(validUuid.toUpperCase())).toBe(true);
      expect(isValidUuid(validUuid.toLowerCase())).toBe(true);
    });
  });

  describe('toRoomId', () => {
    it('should return RoomId for valid UUID', () => {
      const roomId = toRoomId(validUuid);
      expect(roomId).toBe(validUuid);
    });

    it('should throw error for invalid UUID format', () => {
      expect(() => toRoomId(invalidUuid)).toThrow('Invalid UUID format for roomId');
    });

    it('should throw error for UUID without dashes', () => {
      expect(() => toRoomId(invalidFormatUuid)).toThrow('Invalid UUID format for roomId');
    });
  });

  describe('toClientId', () => {
    it('should return ClientId for valid UUID', () => {
      const clientId = toClientId(validUuid);
      expect(clientId).toBe(validUuid);
    });

    it('should throw error for invalid UUID format', () => {
      expect(() => toClientId(invalidUuid)).toThrow('Invalid UUID format for clientId');
    });

    it('should throw error for UUID without dashes', () => {
      expect(() => toClientId(invalidFormatUuid)).toThrow('Invalid UUID format for clientId');
    });
  });
});
