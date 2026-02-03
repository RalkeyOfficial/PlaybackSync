/**
 * Tests for password hashing utility
 */

import { hashPassword, verifyPassword } from '../../utils/password';

describe('Password Hashing Utility', () => {
  const testSecret = 'test-secret-key-for-testing-only';
  const testPassword = 'test-password-123';

  describe('hashPassword', () => {
    it('should hash password using HMAC-SHA256', () => {
      const hash = hashPassword(testPassword, testSecret);

      expect(hash).toBeDefined();
      expect(typeof hash).toBe('string');
      expect(hash.length).toBeGreaterThan(0);
      // HMAC-SHA256 produces 64-character hex string
      expect(hash.length).toBe(64);
      // Should be valid hex string
      expect(/^[0-9a-f]{64}$/i.test(hash)).toBe(true);
    });

    it('should produce same hash for same password and secret', () => {
      const hash1 = hashPassword(testPassword, testSecret);
      const hash2 = hashPassword(testPassword, testSecret);

      expect(hash1).toBe(hash2);
    });

    it('should produce different hashes for different secrets', () => {
      const secret1 = 'secret-1';
      const secret2 = 'secret-2';

      const hash1 = hashPassword(testPassword, secret1);
      const hash2 = hashPassword(testPassword, secret2);

      expect(hash1).not.toBe(hash2);
    });

    it('should produce different hashes for different passwords', () => {
      const password1 = 'password-1';
      const password2 = 'password-2';

      const hash1 = hashPassword(password1, testSecret);
      const hash2 = hashPassword(password2, testSecret);

      expect(hash1).not.toBe(hash2);
    });

    it('should handle empty password', () => {
      const hash = hashPassword('', testSecret);

      expect(hash).toBeDefined();
      expect(typeof hash).toBe('string');
      expect(hash.length).toBe(64);
    });

    it('should handle empty secret', () => {
      const hash = hashPassword(testPassword, '');

      expect(hash).toBeDefined();
      expect(typeof hash).toBe('string');
      expect(hash.length).toBe(64);
    });
  });

  describe('verifyPassword', () => {
    it('should return true for correct password', () => {
      const hash = hashPassword(testPassword, testSecret);
      const isValid = verifyPassword(testPassword, hash, testSecret);

      expect(isValid).toBe(true);
    });

    it('should return false for incorrect password', () => {
      const hash = hashPassword(testPassword, testSecret);
      const isValid = verifyPassword('wrong-password', hash, testSecret);

      expect(isValid).toBe(false);
    });

    it('should return false for incorrect secret', () => {
      const hash = hashPassword(testPassword, testSecret);
      const isValid = verifyPassword(testPassword, hash, 'wrong-secret');

      expect(isValid).toBe(false);
    });

    it('should return false for incorrect hash', () => {
      const isValid = verifyPassword(testPassword, 'invalid-hash', testSecret);

      expect(isValid).toBe(false);
    });

    it('should handle empty password verification', () => {
      const hash = hashPassword('', testSecret);
      const isValid = verifyPassword('', hash, testSecret);

      expect(isValid).toBe(true);
    });

    it('should return false when empty password verified against non-empty hash', () => {
      const hash = hashPassword('non-empty', testSecret);
      const isValid = verifyPassword('', hash, testSecret);

      expect(isValid).toBe(false);
    });
  });
});
