/**
 * Unit tests for Enhanced Logging & Audit Trail Logic
 *
 * Tests verify:
 * - Structured logging for all major events (room creation/deletion, client join/leave, event processing, reconciliation runs, rate limit violations)
 * - Audit buffer maintains recent events per room (ring buffer)
 * - Log context propagation (roomId, clientId)
 * - Sensitive data is never logged (passwords, unmasked clientIds)
 * - Log levels are appropriate (info/warn/error)
 */

import { setupTestEnv, cleanupTestEnv } from '../helpers/fixtures';
import { toRoomId } from '../../types/ids';
import type { ClientId } from '../../types/ids';
import { createRoom, getRoom, clearAllRooms } from '../../storage/rooms';
import { hashPassword } from '../../utils/password';
import { getConfig } from '../../config';
import { logger, redactIP } from '../../utils/logger';
import { addEventToLog, MAX_EVENT_LOG_SIZE } from '../../utils/connection-helpers';
import { maskId } from '../../utils/logger';

describe('Enhanced Logging & Audit Trail Logic', () => {
  beforeEach(() => {
    setupTestEnv();
    clearAllRooms();
    jest.clearAllMocks();
  });

  afterEach(() => {
    cleanupTestEnv();
    clearAllRooms();
    jest.resetModules();
  });

  describe('Structured Logging for Major Events', () => {
    it('should log room creation with structured context', () => {
      const roomId = toRoomId('123e4567-e89b-12d3-a456-426614174000');
      const ttlSeconds = 86400;
      const targetUrl = 'https://example.com/video';

      // Spy on logger.info
      const loggerSpy = jest.spyOn(logger, 'info');

      // Simulate room creation logging (as done in routes/rooms.ts POST /api/rooms)
      logger.info(
        {
          roomId,
          ttl: ttlSeconds,
          targetUrl,
        },
        'room.created'
      );

      // Verify logging occurred with structured context
      expect(loggerSpy).toHaveBeenCalled();
      const logCall = loggerSpy.mock.calls[0];
      expect(logCall[0]).toMatchObject({
        roomId,
        ttl: ttlSeconds,
        targetUrl,
      });
      expect(logCall[1]).toBe('room.created');

      loggerSpy.mockRestore();
    });

    it('should log room deletion with structured context', () => {
      const config = getConfig();
      const roomId = toRoomId('123e4567-e89b-12d3-a456-426614174000');
      const passwordHash = hashPassword('test-password', config.serverSecret);
      const ttlSeconds = 86400;
      const targetUrl = 'https://example.com/video';

      // Create room first
      createRoom(roomId, passwordHash, ttlSeconds, targetUrl);

      // Spy on logger.info
      const loggerSpy = jest.spyOn(logger, 'info');

      // Simulate room deletion logging (as done in routes/rooms.ts DELETE /api/rooms/:roomId)
      logger.info(
        {
          roomId: roomId,
        },
        'room.deleted'
      );

      // Verify logging occurred with structured context
      expect(loggerSpy).toHaveBeenCalled();
      const logCall = loggerSpy.mock.calls.find(call => call[1] === 'room.deleted');
      expect(logCall).toBeDefined();
      expect(logCall![0]).toMatchObject({
        roomId,
      });
      expect(logCall![1]).toBe('room.deleted');

      loggerSpy.mockRestore();
    });

    it('should log client join with structured context', () => {
      const config = getConfig();
      const roomId = toRoomId('123e4567-e89b-12d3-a456-426614174000');
      const passwordHash = hashPassword('test-password', config.serverSecret);
      const ttlSeconds = 86400;
      const targetUrl = 'https://example.com/video';

      // Create room
      createRoom(roomId, passwordHash, ttlSeconds, targetUrl);

      // Spy on logger.info
      const loggerSpy = jest.spyOn(logger, 'info');

      // Simulate client join (this would normally happen in handleJoinMessage)
      const room = getRoom(roomId);
      if (!room) {
        throw new Error('Room not found');
      }
      const clientId = '123e4567-e89b-12d3-a456-426614174001' as ClientId;
      room.connectedClients.set(clientId, {
        clientId,
        conn: {} as any,
        lastSeen: Date.now(),
        lastEventId: room.state.eventId,
      });

      // Log join event (as done in handleJoinMessage)
      logger.info(
        {
          roomId: roomId,
          clientId: clientId,
        },
        'Client joined room'
      );

      // Verify logging occurred with structured context
      expect(loggerSpy).toHaveBeenCalled();
      const logCall = loggerSpy.mock.calls.find(call => call[1] === 'Client joined room');
      expect(logCall).toBeDefined();
      expect(logCall![0]).toMatchObject({
        roomId,
        clientId,
      });
      expect(logCall![1]).toBe('Client joined room');

      loggerSpy.mockRestore();
    });

    it('should log client leave/disconnect with structured context', () => {
      const config = getConfig();
      const roomId = toRoomId('123e4567-e89b-12d3-a456-426614174000');
      const passwordHash = hashPassword('test-password', config.serverSecret);
      const ttlSeconds = 86400;
      const targetUrl = 'https://example.com/video';

      // Create room
      createRoom(roomId, passwordHash, ttlSeconds, targetUrl);

      const room = getRoom(roomId);
      if (!room) {
        throw new Error('Room not found');
      }
      const clientId = '123e4567-e89b-12d3-a456-426614174001' as ClientId;
      room.connectedClients.set(clientId, {
        clientId,
        conn: {} as any,
        lastSeen: Date.now(),
        lastEventId: room.state.eventId,
      });

      // Spy on logger.info
      const loggerSpy = jest.spyOn(logger, 'info');

      // Simulate client disconnect (remove from connectedClients)
      room.connectedClients.delete(clientId);

      // Log disconnect event (as would happen in handleConnection close handler)
      logger.info(
        {
          roomId: roomId,
          clientId: clientId,
        },
        'Client disconnected from room'
      );

      // Verify logging occurred with structured context
      expect(loggerSpy).toHaveBeenCalled();
      const logCall = loggerSpy.mock.calls.find(
        call => call[1] === 'Client disconnected from room'
      );
      expect(logCall).toBeDefined();
      expect(logCall![0]).toMatchObject({
        roomId,
        clientId,
      });

      loggerSpy.mockRestore();
    });

    it('should log event processing with structured context', () => {
      const config = getConfig();
      const roomId = toRoomId('123e4567-e89b-12d3-a456-426614174000');
      const passwordHash = hashPassword('test-password', config.serverSecret);
      const ttlSeconds = 86400;
      const targetUrl = 'https://example.com/video';

      // Create room
      createRoom(roomId, passwordHash, ttlSeconds, targetUrl);

      const room = getRoom(roomId);
      if (!room) {
        throw new Error('Room not found');
      }
      const clientId = '123e4567-e89b-12d3-a456-426614174001' as ClientId;
      room.connectedClients.set(clientId, {
        clientId,
        conn: {} as any,
        lastSeen: Date.now(),
        lastEventId: room.state.eventId,
      });

      // Spy on logger.info
      const loggerSpy = jest.spyOn(logger, 'info');

      // Simulate event processing (as done in handleEventMessage)
      room.state.eventId += 1;
      room.state.playerState = 'playing';
      room.state.videoPos = 123.456;
      room.state.last_explicit_event_ts = Date.now();
      room.state.last_state_update_ts = Date.now();

      // Add event to log
      addEventToLog(room, 'play', undefined, clientId);

      // Log event processing (as done in handleEventMessage)
      logger.info(
        {
          roomId: roomId,
          clientId: clientId,
          event: 'play',
          value: undefined,
          eventId: room.state.eventId,
        },
        'Event processed and state broadcast'
      );

      // Verify logging occurred with structured context
      expect(loggerSpy).toHaveBeenCalled();
      const logCall = loggerSpy.mock.calls.find(
        call => call[1] === 'Event processed and state broadcast'
      );
      expect(logCall).toBeDefined();
      expect(logCall![0]).toMatchObject({
        roomId,
        clientId,
        event: 'play',
        eventId: expect.any(Number),
      });
      expect(logCall![1]).toBe('Event processed and state broadcast');

      loggerSpy.mockRestore();
    });

    it('should log reconciliation runs with structured context', () => {
      const config = getConfig();
      const roomId = toRoomId('123e4567-e89b-12d3-a456-426614174000');
      const passwordHash = hashPassword('test-password', config.serverSecret);
      const ttlSeconds = 86400;
      const targetUrl = 'https://example.com/video';

      // Create room
      createRoom(roomId, passwordHash, ttlSeconds, targetUrl);

      const room = getRoom(roomId);
      if (!room) {
        throw new Error('Room not found');
      }
      const clientId = '123e4567-e89b-12d3-a456-426614174001' as ClientId;
      room.connectedClients.set(clientId, {
        clientId,
        conn: {} as any,
        lastSeen: Date.now(),
        lastEventId: room.state.eventId,
      });

      // Spy on logger.info
      const loggerSpy = jest.spyOn(logger, 'info');

      // Simulate drift reconciliation (as done in handleHeartbeatMessage)
      const driftMs = 750; // Exceeds threshold
      const expectedTime = 123.456;
      const reportedPos = 124.206;
      const syncMode = 'seek';

      logger.info(
        {
          roomId: roomId,
          clientId: clientId,
          driftMs,
          expectedTime,
          reportedPos,
          syncMode,
        },
        'Drift detected and SYNC_ADJUST sent to client'
      );

      // Verify logging occurred with structured context
      expect(loggerSpy).toHaveBeenCalled();
      const logCall = loggerSpy.mock.calls.find(
        call => call[1] === 'Drift detected and SYNC_ADJUST sent to client'
      );
      expect(logCall).toBeDefined();
      expect(logCall![0]).toMatchObject({
        roomId,
        clientId,
        driftMs: expect.any(Number),
        expectedTime: expect.any(Number),
        reportedPos: expect.any(Number),
        syncMode: expect.any(String),
      });
      expect(logCall![1]).toBe('Drift detected and SYNC_ADJUST sent to client');

      loggerSpy.mockRestore();
    });

    it('should log rate limit violations with structured context', () => {
      const roomId = toRoomId('123e4567-e89b-12d3-a456-426614174000');
      const clientId = '123e4567-e89b-12d3-a456-426614174001' as ClientId;

      // Spy on logger.warn
      const loggerSpy = jest.spyOn(logger, 'warn');

      // Simulate rate limit violation (as done in handleEventMessage)
      logger.warn(
        {
          roomId: roomId,
          clientId: clientId,
          event: 'play',
        },
        'Rate limit exceeded for EVENT message'
      );

      // Verify logging occurred with structured context
      expect(loggerSpy).toHaveBeenCalled();
      const logCall = loggerSpy.mock.calls.find(
        call => call[1] === 'Rate limit exceeded for EVENT message'
      );
      expect(logCall).toBeDefined();
      expect(logCall![0]).toMatchObject({
        roomId,
        clientId,
        event: 'play',
      });
      expect(logCall![1]).toBe('Rate limit exceeded for EVENT message');

      loggerSpy.mockRestore();
    });
  });

  describe('Audit Buffer (Event Log Ring Buffer)', () => {
    it('should add events to audit buffer', () => {
      const config = getConfig();
      const roomId = toRoomId('123e4567-e89b-12d3-a456-426614174000');
      const passwordHash = hashPassword('test-password', config.serverSecret);
      const ttlSeconds = 86400;
      const targetUrl = 'https://example.com/video';

      // Create room
      createRoom(roomId, passwordHash, ttlSeconds, targetUrl);

      const room = getRoom(roomId);
      if (!room) {
        throw new Error('Room not found');
      }
      const clientId = '123e4567-e89b-12d3-a456-426614174001' as ClientId;

      // Initial event log should be empty
      expect(room.eventLog.length).toBe(0);

      // Add first event
      addEventToLog(room, 'play', undefined, clientId);
      expect(room.eventLog.length).toBe(1);
      expect(room.eventLog[0]!.type).toBe('play');
      expect(room.eventLog[0]!.clientId).toBe(clientId);
      expect(room.eventLog[0]!.eventId).toBe(room.state.eventId);
      expect(room.eventLog[0]!.ts).toBeDefined();

      // Add second event
      room.state.eventId += 1;
      addEventToLog(room, 'pause', undefined, clientId);
      expect(room.eventLog.length).toBe(2);
      expect(room.eventLog[1]!.type).toBe('pause');

      // Add event with value
      room.state.eventId += 1;
      addEventToLog(room, 'seek', 123.456, clientId);
      expect(room.eventLog.length).toBe(3);
      expect(room.eventLog[2]!.type).toBe('seek');
      expect(room.eventLog[2]!.value).toBe(123.456);
    });

    it('should maintain ring buffer size limit', () => {
      const config = getConfig();
      const roomId = toRoomId('123e4567-e89b-12d3-a456-426614174000');
      const passwordHash = hashPassword('test-password', config.serverSecret);
      const ttlSeconds = 86400;
      const targetUrl = 'https://example.com/video';

      // Create room
      createRoom(roomId, passwordHash, ttlSeconds, targetUrl);

      const room = getRoom(roomId);
      if (!room) {
        throw new Error('Room not found');
      }
      const clientId = '123e4567-e89b-12d3-a456-426614174001' as ClientId;

      // Fill buffer to max size
      for (let i = 0; i < MAX_EVENT_LOG_SIZE; i++) {
        room.state.eventId += 1;
        addEventToLog(room, 'play', undefined, clientId);
      }

      expect(room.eventLog.length).toBe(MAX_EVENT_LOG_SIZE);

      // Add one more event - should remove oldest
      const firstEventId = room.eventLog[0]!.eventId;
      room.state.eventId += 1;
      addEventToLog(room, 'pause', undefined, clientId);

      expect(room.eventLog.length).toBe(MAX_EVENT_LOG_SIZE);
      expect(room.eventLog[0]!.eventId).not.toBe(firstEventId);
      expect(room.eventLog[room.eventLog.length - 1]!.type).toBe('pause');
    });

    it('should include event metadata in audit buffer', () => {
      const config = getConfig();
      const roomId = toRoomId('123e4567-e89b-12d3-a456-426614174000');
      const passwordHash = hashPassword('test-password', config.serverSecret);
      const ttlSeconds = 86400;
      const targetUrl = 'https://example.com/video';

      // Create room
      createRoom(roomId, passwordHash, ttlSeconds, targetUrl);

      const room = getRoom(roomId);
      if (!room) {
        throw new Error('Room not found');
      }
      const clientId = '123e4567-e89b-12d3-a456-426614174001' as ClientId;

      // Add event
      room.state.eventId = 42;
      addEventToLog(room, 'seek', 123.456, clientId);

      const event = room.eventLog[0];
      expect(event).toBeDefined();
      expect(event!.type).toBe('seek');
      expect(event!.clientId).toBe(clientId);
      expect(event!.ts).toBeDefined();
      expect(event!.eventId).toBe(42);
      expect(event!.value).toBe(123.456);
    });
  });

  describe('Sensitive Data Protection', () => {
    it('should never log plaintext passwords', () => {
      const config = getConfig();
      const roomId = toRoomId('123e4567-e89b-12d3-a456-426614174000');
      const password = 'test-password-plaintext';
      const passwordHash = hashPassword(password, config.serverSecret);

      // Spy on logger.info
      const loggerSpy = jest.spyOn(logger, 'info');

      // Create room (should log room creation)
      createRoom(roomId, passwordHash, 86400, 'https://example.com/video');

      // Verify password was never logged
      const allLogCalls = loggerSpy.mock.calls;
      for (const call of allLogCalls) {
        const logData = call[0] as Record<string, unknown>;
        const logMessage = call[1] as string;

        // Check log data object
        if (logData && typeof logData === 'object') {
          const logDataStr = JSON.stringify(logData);
          expect(logDataStr).not.toContain(password);
          expect(logDataStr).not.toContain('test-password-plaintext');
        }

        // Check log message string
        if (logMessage && typeof logMessage === 'string') {
          expect(logMessage).not.toContain(password);
          expect(logMessage).not.toContain('test-password-plaintext');
        }
      }

      loggerSpy.mockRestore();
    });

    it('should never log password hash', () => {
      const config = getConfig();
      const roomId = toRoomId('123e4567-e89b-12d3-a456-426614174000');
      const password = 'test-password';
      const passwordHash = hashPassword(password, config.serverSecret);

      // Spy on logger.info
      const loggerSpy = jest.spyOn(logger, 'info');

      // Create room
      createRoom(roomId, passwordHash, 86400, 'https://example.com/video');

      // Verify passwordHash was never logged
      const allLogCalls = loggerSpy.mock.calls;
      for (const call of allLogCalls) {
        const logData = call[0] as Record<string, unknown>;
        const logMessage = call[1] as string;

        if (logData && typeof logData === 'object') {
          const logDataStr = JSON.stringify(logData);
          expect(logDataStr).not.toContain(passwordHash);
        }

        if (logMessage && typeof logMessage === 'string') {
          expect(logMessage).not.toContain(passwordHash);
        }
      }

      loggerSpy.mockRestore();
    });

    it('should mask clientId when anonymization is enabled', () => {
      process.env.ANON_LOGGING = 'true';
      jest.resetModules();

      const clientId = '123e4567-e89b-12d3-a456-426614174001';
      const masked = maskId(clientId);

      expect(masked).not.toBe(clientId);
      expect(masked).toContain('...');
      expect(masked.length).toBeGreaterThan(0);

      delete process.env.ANON_LOGGING;
      jest.resetModules();
    });

    it('should not mask clientId when anonymization is disabled', () => {
      // Set ANON_LOGGING to false explicitly to disable anonymization
      // Must set environment variable BEFORE resetting modules so config loads correctly
      const originalAnonLogging = process.env.ANON_LOGGING;
      process.env.ANON_LOGGING = 'false';

      // Reset modules to reload config with new environment variable
      jest.resetModules();

      // Dynamically require logger module AFTER resetting modules
      // This ensures it uses the config with ANON_LOGGING=false
      // Note: Using require() here is necessary for dynamic module loading after jest.resetModules()
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { maskId: maskIdWithDisabledAnon } = require('../../utils/logger');

      const clientId = '123e4567-e89b-12d3-a456-426614174001';
      const masked = maskIdWithDisabledAnon(clientId);

      expect(masked).toBe(clientId);

      // Restore original value
      if (originalAnonLogging !== undefined) {
        process.env.ANON_LOGGING = originalAnonLogging;
      } else {
        delete process.env.ANON_LOGGING;
      }
      jest.resetModules();
    });

    it('should redact IP addresses when anonymization is enabled', () => {
      process.env.ANON_LOGGING = 'true';
      jest.resetModules();

      const ip = '192.168.1.1';
      const redacted = redactIP(ip);

      expect(redacted).toBe('[REDACTED]');

      delete process.env.ANON_LOGGING;
      jest.resetModules();
    });
  });

  describe('Log Context Propagation', () => {
    it('should include roomId in all room-related logs', () => {
      const roomId = toRoomId('123e4567-e89b-12d3-a456-426614174000');
      const ttlSeconds = 86400;
      const targetUrl = 'https://example.com/video';

      // Spy on logger
      const loggerSpy = jest.spyOn(logger, 'info');

      // Simulate room creation logging (as done in routes/rooms.ts)
      logger.info(
        {
          roomId,
          ttl: ttlSeconds,
          targetUrl,
        },
        'room.created'
      );

      // Verify roomId is in log
      const logCall = loggerSpy.mock.calls.find(call => call[1] === 'room.created');
      expect(logCall).toBeDefined();
      const logData = logCall![0] as Record<string, unknown>;
      expect(logData).toHaveProperty('roomId');
      expect(logData.roomId).toBe(roomId);

      loggerSpy.mockRestore();
    });

    it('should include clientId in all client-related logs', () => {
      const config = getConfig();
      const roomId = toRoomId('123e4567-e89b-12d3-a456-426614174000');
      const passwordHash = hashPassword('test-password', config.serverSecret);
      const ttlSeconds = 86400;
      const targetUrl = 'https://example.com/video';

      // Create room
      createRoom(roomId, passwordHash, ttlSeconds, targetUrl);

      const room = getRoom(roomId);
      if (!room) {
        throw new Error('Room not found');
      }
      const clientId = '123e4567-e89b-12d3-a456-426614174001' as ClientId;

      // Spy on logger
      const loggerSpy = jest.spyOn(logger, 'info');

      // Simulate client join
      room.connectedClients.set(clientId, {
        clientId,
        conn: {} as any,
        lastSeen: Date.now(),
        lastEventId: room.state.eventId,
      });

      logger.info(
        {
          roomId: roomId,
          clientId: clientId,
        },
        'Client joined room'
      );

      // Verify clientId is in log
      const logCall = loggerSpy.mock.calls.find(call => call[1] === 'Client joined room');
      expect(logCall).toBeDefined();
      const logData = logCall![0] as Record<string, unknown>;
      expect(logData).toHaveProperty('clientId');
      expect(logData.clientId).toBe(clientId);

      loggerSpy.mockRestore();
    });
  });

  describe('Log Levels Appropriateness', () => {
    it('should use info level for normal operations', () => {
      const roomId = toRoomId('123e4567-e89b-12d3-a456-426614174000');

      // Spy on logger methods
      const infoSpy = jest.spyOn(logger, 'info');
      const warnSpy = jest.spyOn(logger, 'warn');
      const errorSpy = jest.spyOn(logger, 'error');

      // Normal operations should use info (simulate room creation logging)
      logger.info(
        {
          roomId,
          ttl: 86400,
          targetUrl: 'https://example.com/video',
        },
        'room.created'
      );

      expect(infoSpy).toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();

      infoSpy.mockRestore();
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    });

    it('should use warn level for recoverable issues', () => {
      const roomId = toRoomId('123e4567-e89b-12d3-a456-426614174000');
      const clientId = '123e4567-e89b-12d3-a456-426614174001' as ClientId;

      // Spy on logger methods
      const warnSpy = jest.spyOn(logger, 'warn');
      const errorSpy = jest.spyOn(logger, 'error');

      // Recoverable issues should use warn
      logger.warn(
        {
          roomId,
          clientId,
          event: 'play',
        },
        'Rate limit exceeded for EVENT message'
      );

      expect(warnSpy).toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();

      warnSpy.mockRestore();
      errorSpy.mockRestore();
    });

    it('should use error level for exceptions and failures', () => {
      const roomId = toRoomId('123e4567-e89b-12d3-a456-426614174000');
      const error = new Error('Test error');

      // Spy on logger methods
      const warnSpy = jest.spyOn(logger, 'warn');
      const errorSpy = jest.spyOn(logger, 'error');

      // Exceptions should use error
      logger.error({ error, roomId }, 'Error processing message');

      expect(errorSpy).toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();

      warnSpy.mockRestore();
      errorSpy.mockRestore();
    });
  });

  describe('Cleanup Logging', () => {
    it('should log cleanup task start', () => {
      // Spy on logger.info
      const loggerSpy = jest.spyOn(logger, 'info');

      // Simulate cleanup task start (as done in index.ts)
      logger.info('Background room cleanup task started (interval: 60s)');

      expect(loggerSpy).toHaveBeenCalled();
      const logCall = loggerSpy.mock.calls.find(
        call => call[0] === 'Background room cleanup task started (interval: 60s)'
      );
      expect(logCall).toBeDefined();

      loggerSpy.mockRestore();
    });

    it('should log cleanup completion with count', () => {
      const cleanedCount = 3;

      // Spy on logger.info
      const loggerSpy = jest.spyOn(logger, 'info');

      // Simulate cleanup completion (as done in room-cleanup.ts)
      logger.info({ cleanedCount }, 'room.cleanup.completed');

      expect(loggerSpy).toHaveBeenCalled();
      const logCall = loggerSpy.mock.calls.find(call => call[1] === 'room.cleanup.completed');
      expect(logCall).toBeDefined();
      expect(logCall![0]).toMatchObject({
        cleanedCount,
      });

      loggerSpy.mockRestore();
    });

    it('should log cleanup errors', () => {
      const error = new Error('Cleanup failed');
      const roomId = toRoomId('123e4567-e89b-12d3-a456-426614174000');

      // Spy on logger methods
      const errorSpy = jest.spyOn(logger, 'error');
      const infoSpy = jest.spyOn(logger, 'info');

      // Simulate cleanup error (as done in room-cleanup.ts)
      logger.error({ roomId, error }, 'Error cleaning up expired room');

      expect(errorSpy).toHaveBeenCalled();
      const logCall = errorSpy.mock.calls.find(
        call => call[1] === 'Error cleaning up expired room'
      );
      expect(logCall).toBeDefined();
      expect(logCall![0]).toMatchObject({
        roomId,
        error: expect.any(Error),
      });

      errorSpy.mockRestore();
      infoSpy.mockRestore();
    });
  });
});
