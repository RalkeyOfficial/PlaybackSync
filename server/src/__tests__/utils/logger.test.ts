/**
 * Tests for logger utility functions
 */

import { setupTestEnv, cleanupTestEnv } from '../helpers/fixtures';

describe('Logger Utilities', () => {
  beforeEach(() => {
    setupTestEnv();
  });

  afterEach(() => {
    cleanupTestEnv();
    jest.resetModules();
  });

  describe('maskId', () => {
    it('should return full ID when anonymization is disabled', async () => {
      process.env.ANON_LOGGING = 'false';
      jest.resetModules();
      const { maskId } = await import('../../utils/logger');
      const id = '550e8400-e29b-41d4-a716-446655440000';
      expect(maskId(id)).toBe(id);
    });

    it('should mask ID when anonymization is enabled', async () => {
      process.env.ANON_LOGGING = 'true';
      jest.resetModules();
      const { maskId } = await import('../../utils/logger');
      const id = '550e8400-e29b-41d4-a716-446655440000';
      const masked = maskId(id);
      expect(masked).toBe('550e...0000');
    });

    it('should return "***" for IDs shorter than 8 characters', async () => {
      process.env.ANON_LOGGING = 'true';
      jest.resetModules();
      const { maskId } = await import('../../utils/logger');
      expect(maskId('short')).toBe('***');
      expect(maskId('abc')).toBe('***');
    });

    it('should return empty string for empty input', async () => {
      process.env.ANON_LOGGING = 'true';
      jest.resetModules();
      const { maskId } = await import('../../utils/logger');
      expect(maskId('')).toBe('');
    });

    it('should return "***" for IDs exactly 8 characters', async () => {
      process.env.ANON_LOGGING = 'true';
      jest.resetModules();
      const { maskId } = await import('../../utils/logger');
      const id = '12345678';
      const masked = maskId(id);
      expect(masked).toBe('***');
    });
  });

  describe('redactIP', () => {
    it('should return full IP when anonymization is disabled', async () => {
      process.env.ANON_LOGGING = 'false';
      jest.resetModules();
      const { redactIP } = await import('../../utils/logger');
      const ip = '192.168.1.1';
      expect(redactIP(ip)).toBe(ip);
    });

    it('should redact IP when anonymization is enabled', async () => {
      process.env.ANON_LOGGING = 'true';
      jest.resetModules();
      const { redactIP } = await import('../../utils/logger');
      const ip = '192.168.1.1';
      expect(redactIP(ip)).toBe('[REDACTED]');
    });

    it('should return empty string for empty input', async () => {
      process.env.ANON_LOGGING = 'true';
      jest.resetModules();
      const { redactIP } = await import('../../utils/logger');
      expect(redactIP('')).toBe('');
    });

    it('should handle IPv6 addresses', async () => {
      process.env.ANON_LOGGING = 'true';
      jest.resetModules();
      const { redactIP } = await import('../../utils/logger');
      const ipv6 = '2001:0db8:85a3:0000:0000:8a2e:0370:7334';
      expect(redactIP(ipv6)).toBe('[REDACTED]');
    });
  });
});
