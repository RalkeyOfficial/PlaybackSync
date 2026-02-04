/**
 * Unit tests for JSON Schema Validation Setup (Step 3.2)
 *
 * Tests verify:
 * - All message schemas defined and valid
 * - Valid messages pass validation
 * - Invalid messages are rejected with clear errors
 * - Schema validation is fast (< 1ms per message)
 * - Validation errors include helpful messages
 */

import { setupTestEnv, cleanupTestEnv } from '../helpers/fixtures';
import {
  validateMessage,
  getSchema,
  formatValidationError,
  loadSchemas,
  type MessageSchemaType,
} from '../../utils/validation';

describe('JSON Schema Validation Setup (Step 3.2)', () => {
  beforeEach(() => {
    setupTestEnv();
  });

  afterEach(() => {
    cleanupTestEnv();
  });

  describe('Schema Loading and Initialization', () => {
    it('should load all required message schemas', () => {
      // This test verifies that all schemas from Step 3.2 are available:
      // - JOIN schema
      // - EVENT schema
      // - EPISODE_CHANGE_REQUEST schema
      // - TIME_REPORT schema
      // - STATE schema
      // - COMMAND schema
      // - ERROR schema

      const requiredSchemas: MessageSchemaType[] = [
        'JOIN',
        'EVENT',
        'EPISODE_CHANGE_REQUEST',
        'TIME_REPORT',
        'STATE',
        'COMMAND',
        'ERROR',
      ];

      const schemas = loadSchemas();
      requiredSchemas.forEach(schemaName => {
        expect(schemas).toHaveProperty(schemaName);
        expect(schemas[schemaName]).toBeDefined();
        expect(getSchema(schemaName)).toBeDefined();
      });

      expect(requiredSchemas.length).toBe(7);
    });

    it('should initialize ajv validator with proper configuration', () => {
      // Verify ajv is configured correctly for fast validation
      const result = validateMessage({ type: 'JOIN' }, 'JOIN');
      // Should return validation result (even if invalid)
      expect(result).toBeDefined();
      expect(result).toHaveProperty('valid');
      expect(result).toHaveProperty('errors');
    });
  });

  describe('JOIN Message Validation', () => {
    const validJoinMessage = {
      type: 'JOIN',
      roomId: '123e4567-e89b-12d3-a456-426614174000',
      password: 'test-password-123',
      clientId: '123e4567-e89b-12d3-a456-426614174001',
      lastKnownTime: 12.345,
    };

    it('should validate valid JOIN message with all required fields', () => {
      const result = validateMessage(validJoinMessage, 'JOIN');
      expect(result.valid).toBe(true);
      expect(result.errors).toBeNull();
    });

    it('should validate JOIN message with optional lastKnownTime', () => {
      const joinWithoutTime = {
        type: 'JOIN',
        roomId: '123e4567-e89b-12d3-a456-426614174000',
        password: 'test-password',
        clientId: '123e4567-e89b-12d3-a456-426614174001',
      };

      const result = validateMessage(joinWithoutTime, 'JOIN');
      expect(result.valid).toBe(true);
    });

    it('should reject JOIN message missing required field: roomId', () => {
      const invalidJoin = {
        type: 'JOIN',
        password: 'test-password',
        clientId: '123e4567-e89b-12d3-a456-426614174001',
      };

      const result = validateMessage(invalidJoin, 'JOIN');
      expect(result.valid).toBe(false);
      expect(result.errors).toBeDefined();
      expect(result.errors).not.toBeNull();
      if (result.errors) {
        const errorMessages = result.errors.map(e => e.message || '').join(' ');
        expect(errorMessages).toMatch(/roomId/i);
      }
    });

    it('should reject JOIN message missing required field: password', () => {
      const invalidJoin = {
        type: 'JOIN',
        roomId: '123e4567-e89b-12d3-a456-426614174000',
        clientId: '123e4567-e89b-12d3-a456-426614174001',
      };

      const result = validateMessage(invalidJoin, 'JOIN');
      expect(result.valid).toBe(false);
      expect(result.errors).not.toBeNull();
      if (result.errors) {
        const errorMessages = result.errors.map(e => e.message || '').join(' ');
        expect(errorMessages).toMatch(/password/i);
      }
    });

    it('should reject JOIN message with invalid UUID format for roomId', () => {
      const invalidJoin = {
        type: 'JOIN',
        roomId: 'not-a-uuid',
        password: 'test-password',
        clientId: '123e4567-e89b-12d3-a456-426614174001',
      };

      const result = validateMessage(invalidJoin, 'JOIN');
      expect(result.valid).toBe(false);
      expect(result.errors).not.toBeNull();
      if (result.errors) {
        const errorMessages = result.errors.map(e => e.message || '').join(' ');
        expect(errorMessages).toMatch(/roomId|pattern/i);
      }
    });

    it('should reject JOIN message with invalid UUID format for clientId', () => {
      const invalidJoin = {
        type: 'JOIN',
        roomId: '123e4567-e89b-12d3-a456-426614174000',
        password: 'test-password',
        clientId: 'invalid-client-id',
      };

      const result = validateMessage(invalidJoin, 'JOIN');
      expect(result.valid).toBe(false);
      expect(result.errors).not.toBeNull();
      if (result.errors) {
        const errorMessages = result.errors.map(e => e.message || '').join(' ');
        expect(errorMessages).toMatch(/clientId|pattern/i);
      }
    });

    it('should reject JOIN message with invalid type', () => {
      const invalidJoin = {
        type: 'INVALID_TYPE',
        roomId: '123e4567-e89b-12d3-a456-426614174000',
        password: 'test-password',
        clientId: '123e4567-e89b-12d3-a456-426614174001',
      };

      const result = validateMessage(invalidJoin, 'JOIN');
      expect(result.valid).toBe(false);
      expect(result.errors).not.toBeNull();
    });
  });

  describe('EVENT Message Validation', () => {
    const validPlayEvent = {
      type: 'EVENT',
      event: 'play',
      client_ts: 1670000000000,
    };

    const validPauseEvent = {
      type: 'EVENT',
      event: 'pause',
      client_ts: 1670000000000,
    };

    const validSeekEvent = {
      type: 'EVENT',
      event: 'seek',
      value: 123.456,
      client_ts: 1670000000000,
    };

    it('should validate valid play EVENT message', () => {
      const result = validateMessage(validPlayEvent, 'EVENT');
      expect(result.valid).toBe(true);
      expect(result.errors).toBeNull();
    });

    it('should validate valid pause EVENT message', () => {
      const result = validateMessage(validPauseEvent, 'EVENT');
      expect(result.valid).toBe(true);
      expect(result.errors).toBeNull();
    });

    it('should validate valid seek EVENT message with value', () => {
      const result = validateMessage(validSeekEvent, 'EVENT');
      expect(result.valid).toBe(true);
      expect(result.errors).toBeNull();
    });

    it('should reject EVENT message missing required field: event', () => {
      const invalidEvent = {
        type: 'EVENT',
        client_ts: 1670000000000,
      };

      const result = validateMessage(invalidEvent, 'EVENT');
      expect(result.valid).toBe(false);
      expect(result.errors).not.toBeNull();
      if (result.errors) {
        const errorMessages = result.errors.map(e => e.message || '').join(' ');
        expect(errorMessages).toMatch(/event/i);
      }
    });

    it('should reject EVENT message missing required field: client_ts', () => {
      const invalidEvent = {
        type: 'EVENT',
        event: 'play',
      };

      const result = validateMessage(invalidEvent, 'EVENT');
      expect(result.valid).toBe(false);
      expect(result.errors).not.toBeNull();
      if (result.errors) {
        const errorMessages = result.errors.map(e => e.message || '').join(' ');
        expect(errorMessages).toMatch(/client_ts/i);
      }
    });

    it('should reject EVENT message with invalid event type', () => {
      const invalidEvent = {
        type: 'EVENT',
        event: 'invalid-event',
        client_ts: 1670000000000,
      };

      const result = validateMessage(invalidEvent, 'EVENT');
      expect(result.valid).toBe(false);
      expect(result.errors).not.toBeNull();
    });

    it('should reject seek EVENT message missing required value field', () => {
      const invalidSeek = {
        type: 'EVENT',
        event: 'seek',
        client_ts: 1670000000000,
      };

      const result = validateMessage(invalidSeek, 'EVENT');
      expect(result.valid).toBe(false);
      expect(result.errors).not.toBeNull();
      if (result.errors) {
        const errorMessages = result.errors.map(e => e.message || '').join(' ');
        expect(errorMessages).toMatch(/value/i);
      }
    });

    it('should reject EVENT message with non-numeric client_ts', () => {
      const invalidEvent = {
        type: 'EVENT',
        event: 'play',
        client_ts: 'not-a-number',
      };

      const result = validateMessage(invalidEvent, 'EVENT');
      expect(result.valid).toBe(false);
      expect(result.errors).not.toBeNull();
    });
  });

  describe('EPISODE_CHANGE_REQUEST Message Validation', () => {
    const validEpisodeChangeRequest = {
      type: 'EPISODE_CHANGE_REQUEST',
      episodeId: 5,
      providerId: 'test-provider',
      pageUrl: 'https://example.com/video/episode/5',
      clientTime: 1670000000000,
    };

    it('should validate valid EPISODE_CHANGE_REQUEST message', () => {
      const result = validateMessage(validEpisodeChangeRequest, 'EPISODE_CHANGE_REQUEST');
      expect(result.valid).toBe(true);
      expect(result.errors).toBeNull();
    });

    it('should validate EPISODE_CHANGE_REQUEST with string episodeId', () => {
      const requestWithStringEpisode = {
        type: 'EPISODE_CHANGE_REQUEST',
        episodeId: 'episode-5',
        providerId: 'test-provider',
        pageUrl: 'https://example.com/video/episode/5',
        clientTime: 1670000000000,
      };

      const result = validateMessage(requestWithStringEpisode, 'EPISODE_CHANGE_REQUEST');
      expect(result.valid).toBe(true);
      expect(result.errors).toBeNull();
    });

    it('should reject EPISODE_CHANGE_REQUEST missing required field: episodeId', () => {
      const invalidRequest = {
        type: 'EPISODE_CHANGE_REQUEST',
        providerId: 'test-provider',
        pageUrl: 'https://example.com/video/episode/5',
        clientTime: 1670000000000,
      };

      const result = validateMessage(invalidRequest, 'EPISODE_CHANGE_REQUEST');
      expect(result.valid).toBe(false);
      expect(result.errors).not.toBeNull();
      if (result.errors) {
        const errorMessages = result.errors.map(e => e.message || '').join(' ');
        expect(errorMessages).toMatch(/episodeId/i);
      }
    });

    it('should reject EPISODE_CHANGE_REQUEST missing required field: providerId', () => {
      const invalidRequest = {
        type: 'EPISODE_CHANGE_REQUEST',
        episodeId: 5,
        pageUrl: 'https://example.com/video/episode/5',
        clientTime: 1670000000000,
      };

      const result = validateMessage(invalidRequest, 'EPISODE_CHANGE_REQUEST');
      expect(result.valid).toBe(false);
      expect(result.errors).not.toBeNull();
      if (result.errors) {
        const errorMessages = result.errors.map(e => e.message || '').join(' ');
        expect(errorMessages).toMatch(/providerId/i);
      }
    });

    it('should reject EPISODE_CHANGE_REQUEST missing required field: pageUrl', () => {
      const invalidRequest = {
        type: 'EPISODE_CHANGE_REQUEST',
        episodeId: 5,
        providerId: 'test-provider',
        clientTime: 1670000000000,
      };

      const result = validateMessage(invalidRequest, 'EPISODE_CHANGE_REQUEST');
      expect(result.valid).toBe(false);
      expect(result.errors).not.toBeNull();
      if (result.errors) {
        const errorMessages = result.errors.map(e => e.message || '').join(' ');
        expect(errorMessages).toMatch(/pageUrl/i);
      }
    });

    it('should reject EPISODE_CHANGE_REQUEST missing required field: clientTime', () => {
      const invalidRequest = {
        type: 'EPISODE_CHANGE_REQUEST',
        episodeId: 5,
        providerId: 'test-provider',
        pageUrl: 'https://example.com/video/episode/5',
      };

      const result = validateMessage(invalidRequest, 'EPISODE_CHANGE_REQUEST');
      expect(result.valid).toBe(false);
      expect(result.errors).not.toBeNull();
      if (result.errors) {
        const errorMessages = result.errors.map(e => e.message || '').join(' ');
        expect(errorMessages).toMatch(/clientTime/i);
      }
    });
  });

  describe('TIME_REPORT Message Validation', () => {
    const validTimeReport = {
      type: 'TIME_REPORT',
      current_time: 123.456,
      client_ts: 1670000000000,
    };

    it('should validate valid TIME_REPORT message', () => {
      const result = validateMessage(validTimeReport, 'TIME_REPORT');
      expect(result.valid).toBe(true);
      expect(result.errors).toBeNull();
    });

    it('should reject TIME_REPORT missing required field: current_time', () => {
      const invalidReport = {
        type: 'TIME_REPORT',
        client_ts: 1670000000000,
      };

      const result = validateMessage(invalidReport, 'TIME_REPORT');
      expect(result.valid).toBe(false);
      expect(result.errors).not.toBeNull();
      if (result.errors) {
        const errorMessages = result.errors.map(e => e.message || '').join(' ');
        expect(errorMessages).toMatch(/current_time/i);
      }
    });

    it('should reject TIME_REPORT missing required field: client_ts', () => {
      const invalidReport = {
        type: 'TIME_REPORT',
        current_time: 123.456,
      };

      const result = validateMessage(invalidReport, 'TIME_REPORT');
      expect(result.valid).toBe(false);
      expect(result.errors).not.toBeNull();
      if (result.errors) {
        const errorMessages = result.errors.map(e => e.message || '').join(' ');
        expect(errorMessages).toMatch(/client_ts/i);
      }
    });

    it('should reject TIME_REPORT with non-numeric current_time', () => {
      const invalidReport = {
        type: 'TIME_REPORT',
        current_time: 'not-a-number',
        client_ts: 1670000000000,
      };

      const result = validateMessage(invalidReport, 'TIME_REPORT');
      expect(result.valid).toBe(false);
      expect(result.errors).not.toBeNull();
    });
  });

  describe('STATE Message Validation', () => {
    const validStateMessage = {
      type: 'STATE',
      paused: false,
      time: 123.456,
      provider: 'test-provider',
      episode: 5,
      server_ts: 1670000000000,
      eventId: 1,
    };

    it('should validate valid STATE message with all fields', () => {
      const result = validateMessage(validStateMessage, 'STATE');
      expect(result.valid).toBe(true);
      expect(result.errors).toBeNull();
    });

    it('should validate STATE message with optional provider and episode', () => {
      const stateWithoutOptional = {
        type: 'STATE',
        paused: true,
        time: 0,
        server_ts: 1670000000000,
        eventId: 1,
      };

      const result = validateMessage(stateWithoutOptional, 'STATE');
      expect(result.valid).toBe(true);
      expect(result.errors).toBeNull();
    });

    it('should reject STATE message missing required field: paused', () => {
      const invalidState = {
        type: 'STATE',
        time: 123.456,
        server_ts: 1670000000000,
        eventId: 1,
      };

      const result = validateMessage(invalidState, 'STATE');
      expect(result.valid).toBe(false);
      expect(result.errors).not.toBeNull();
      if (result.errors) {
        const errorMessages = result.errors.map(e => e.message || '').join(' ');
        expect(errorMessages).toMatch(/paused/i);
      }
    });

    it('should reject STATE message missing required field: time', () => {
      const invalidState = {
        type: 'STATE',
        paused: false,
        server_ts: 1670000000000,
        eventId: 1,
      };

      const result = validateMessage(invalidState, 'STATE');
      expect(result.valid).toBe(false);
      expect(result.errors).not.toBeNull();
      if (result.errors) {
        const errorMessages = result.errors.map(e => e.message || '').join(' ');
        expect(errorMessages).toMatch(/time/i);
      }
    });

    it('should reject STATE message missing required field: server_ts', () => {
      const invalidState = {
        type: 'STATE',
        paused: false,
        time: 123.456,
        eventId: 1,
      };

      const result = validateMessage(invalidState, 'STATE');
      expect(result.valid).toBe(false);
      expect(result.errors).not.toBeNull();
      if (result.errors) {
        const errorMessages = result.errors.map(e => e.message || '').join(' ');
        expect(errorMessages).toMatch(/server_ts/i);
      }
    });

    it('should reject STATE message missing required field: eventId', () => {
      const invalidState = {
        type: 'STATE',
        paused: false,
        time: 123.456,
        server_ts: 1670000000000,
      };

      const result = validateMessage(invalidState, 'STATE');
      expect(result.valid).toBe(false);
      expect(result.errors).not.toBeNull();
      if (result.errors) {
        const errorMessages = result.errors.map(e => e.message || '').join(' ');
        expect(errorMessages).toMatch(/eventId/i);
      }
    });

    it('should reject STATE message with non-boolean paused', () => {
      const invalidState = {
        type: 'STATE',
        paused: 'not-boolean',
        time: 123.456,
        server_ts: 1670000000000,
        eventId: 1,
      };

      const result = validateMessage(invalidState, 'STATE');
      expect(result.valid).toBe(false);
      expect(result.errors).not.toBeNull();
    });
  });

  describe('COMMAND Message Validation', () => {
    const validSeekCommand = {
      type: 'COMMAND',
      cmd: 'seek',
      value: 123.456,
      server_ts: 1670000000000,
    };

    const validPlayCommand = {
      type: 'COMMAND',
      cmd: 'play',
      server_ts: 1670000000000,
    };

    const validPauseCommand = {
      type: 'COMMAND',
      cmd: 'pause',
      server_ts: 1670000000000,
    };

    it('should validate valid seek COMMAND message with value', () => {
      const result = validateMessage(validSeekCommand, 'COMMAND');
      expect(result.valid).toBe(true);
      expect(result.errors).toBeNull();
    });

    it('should validate valid play COMMAND message without value', () => {
      const result = validateMessage(validPlayCommand, 'COMMAND');
      expect(result.valid).toBe(true);
      expect(result.errors).toBeNull();
    });

    it('should validate valid pause COMMAND message without value', () => {
      const result = validateMessage(validPauseCommand, 'COMMAND');
      expect(result.valid).toBe(true);
      expect(result.errors).toBeNull();
    });

    it('should reject COMMAND message missing required field: cmd', () => {
      const invalidCommand = {
        type: 'COMMAND',
        value: 123.456,
      };

      const result = validateMessage(invalidCommand, 'COMMAND');
      expect(result.valid).toBe(false);
      expect(result.errors).not.toBeNull();
      if (result.errors) {
        const errorMessages = result.errors.map(e => e.message || '').join(' ');
        expect(errorMessages).toMatch(/cmd/i);
      }
    });

    it('should reject COMMAND message with invalid cmd type', () => {
      const invalidCommand = {
        type: 'COMMAND',
        cmd: 'invalid-command',
        server_ts: 1670000000000,
      };

      const result = validateMessage(invalidCommand, 'COMMAND');
      expect(result.valid).toBe(false);
      expect(result.errors).not.toBeNull();
    });

    it('should reject seek COMMAND message missing required value field', () => {
      const invalidSeek = {
        type: 'COMMAND',
        cmd: 'seek',
        server_ts: 1670000000000,
      };

      const result = validateMessage(invalidSeek, 'COMMAND');
      expect(result.valid).toBe(false);
      expect(result.errors).not.toBeNull();
      if (result.errors) {
        const errorMessages = result.errors.map(e => e.message || '').join(' ');
        expect(errorMessages).toMatch(/value/i);
      }
    });
  });

  describe('ERROR Message Validation', () => {
    const validErrorMessage = {
      type: 'ERROR',
      code: 'AUTH_FAILED',
      message: 'Invalid room or password',
      server_ts: 1670000000000,
    };

    it('should validate valid ERROR message with all fields', () => {
      const result = validateMessage(validErrorMessage, 'ERROR');
      expect(result.valid).toBe(true);
      expect(result.errors).toBeNull();
    });

    it('should validate ERROR message without optional server_ts', () => {
      const errorWithoutTs = {
        type: 'ERROR',
        code: 'INVALID_MESSAGE',
        message: 'Message validation failed',
      };

      const result = validateMessage(errorWithoutTs, 'ERROR');
      expect(result.valid).toBe(true);
      expect(result.errors).toBeNull();
    });

    it('should reject ERROR message missing required field: code', () => {
      const invalidError = {
        type: 'ERROR',
        message: 'Error message',
      };

      const result = validateMessage(invalidError, 'ERROR');
      expect(result.valid).toBe(false);
      expect(result.errors).not.toBeNull();
      if (result.errors) {
        const errorMessages = result.errors.map(e => e.message || '').join(' ');
        expect(errorMessages).toMatch(/code/i);
      }
    });

    it('should reject ERROR message missing required field: message', () => {
      const invalidError = {
        type: 'ERROR',
        code: 'AUTH_FAILED',
      };

      const result = validateMessage(invalidError, 'ERROR');
      expect(result.valid).toBe(false);
      expect(result.errors).not.toBeNull();
      if (result.errors) {
        const errorMessages = result.errors.map(e => e.message || '').join(' ');
        expect(errorMessages).toMatch(/message/i);
      }
    });
  });

  describe('Validation Error Formatting', () => {
    it('should format validation errors with helpful messages', () => {
      const invalidMessage = { type: 'JOIN' }; // Missing required fields
      const result = validateMessage(invalidMessage, 'JOIN');
      expect(result.valid).toBe(false);
      expect(result.errors).toBeDefined();
      expect(result.errors).not.toBeNull();
      if (result.errors) {
        expect(result.errors.length).toBeGreaterThan(0);

        const formattedError = formatValidationError(result.errors);
        expect(formattedError).toBeDefined();
        expect(typeof formattedError).toBe('string');
        expect(formattedError).toMatch(/roomId/i); // Should mention missing field
      }
    });

    it('should include field path in error messages', () => {
      const invalidMessage = {
        type: 'EVENT',
        event: 'invalid',
        client_ts: 'not-a-number',
      };
      const result = validateMessage(invalidMessage, 'EVENT');
      expect(result.valid).toBe(false);
      expect(result.errors).not.toBeNull();

      if (result.errors) {
        const formattedError = formatValidationError(result.errors);
        expect(formattedError).toMatch(/event/i); // Should mention event field
        expect(formattedError).toMatch(/client_ts/i); // Should mention client_ts field
      }
    });
  });

  describe('Validation Performance', () => {
    it('should validate messages quickly (< 1ms per message)', () => {
      const validMessage = {
        type: 'JOIN',
        roomId: '123e4567-e89b-12d3-a456-426614174000',
        password: 'test-password',
        clientId: '123e4567-e89b-12d3-a456-426614174001',
      };

      const iterations = 1000;
      const startTime = performance.now();

      for (let i = 0; i < iterations; i++) {
        validateMessage(validMessage, 'JOIN');
      }

      const endTime = performance.now();
      const avgTime = (endTime - startTime) / iterations;
      expect(avgTime).toBeLessThan(1); // Less than 1ms per validation
    });

    it('should handle multiple message types efficiently', () => {
      const messages = [
        {
          type: 'JOIN',
          roomId: '123e4567-e89b-12d3-a456-426614174000',
          password: 'test',
          clientId: '123e4567-e89b-12d3-a456-426614174001',
        },
        { type: 'EVENT', event: 'play', client_ts: 1670000000000 },
        { type: 'TIME_REPORT', current_time: 123.456, client_ts: 1670000000000 },
        { type: 'STATE', paused: false, time: 123.456, server_ts: 1670000000000, eventId: 1 },
      ];

      const startTime = performance.now();
      messages.forEach(msg => {
        validateMessage(msg, msg.type as MessageSchemaType);
      });
      const endTime = performance.now();
      const totalTime = endTime - startTime;
      expect(totalTime).toBeLessThan(5); // Should handle multiple types quickly
    });
  });

  describe('Edge Cases and Invalid Inputs', () => {
    it('should reject null message', () => {
      const result = validateMessage(null, 'JOIN');
      expect(result.valid).toBe(false);
      expect(result.errors).not.toBeNull();
    });

    it('should reject undefined message', () => {
      const result = validateMessage(undefined, 'JOIN');
      expect(result.valid).toBe(false);
      expect(result.errors).not.toBeNull();
    });

    it('should reject non-object message', () => {
      const result = validateMessage('not-an-object', 'JOIN');
      expect(result.valid).toBe(false);
      expect(result.errors).not.toBeNull();
    });

    it('should reject message with extra unexpected fields', () => {
      const messageWithExtraFields = {
        type: 'JOIN',
        roomId: '123e4567-e89b-12d3-a456-426614174000',
        password: 'test-password',
        clientId: '123e4567-e89b-12d3-a456-426614174001',
        unexpectedField: 'should-not-be-here',
      };

      // Schema has additionalProperties: false, so extra fields should be rejected
      const result = validateMessage(messageWithExtraFields, 'JOIN');
      expect(result.valid).toBe(false);
      expect(result.errors).not.toBeNull();
    });

    it('should reject message with wrong schema type', () => {
      const joinMessage = {
        type: 'JOIN',
        roomId: '123e4567-e89b-12d3-a456-426614174000',
        password: 'test-password',
        clientId: '123e4567-e89b-12d3-a456-426614174001',
      };

      const result = validateMessage(joinMessage, 'EVENT'); // Wrong schema
      expect(result.valid).toBe(false);
      expect(result.errors).not.toBeNull();
    });
  });
});
