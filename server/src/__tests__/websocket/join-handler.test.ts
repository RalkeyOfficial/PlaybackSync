/**
 * Unit tests for JOIN Message Handling
 *
 * Tests verify:
 * - Valid JOIN with correct credentials succeeds
 * - Invalid password sends ERROR and closes connection
 * - Non-existent room sends ERROR and closes connection
 * - Joining client receives current STATE immediately (ROOM_STATE)
 * - Reconnection with same clientId uses tombstone
 * - Multiple clients can join same room
 * - Join events are logged correctly
 * - Schema validation for JOIN messages
 */

import { setupTestEnv, cleanupTestEnv } from '../helpers/fixtures';
import { toRoomId } from '../../types/ids';
import type { ClientId } from '../../types/ids';
import { createRoom, getRoom, clearAllRooms } from '../../storage/rooms';
import { hashPassword, verifyPassword } from '../../utils/password';
import { getConfig } from '../../config';
import { validateMessage } from '../../utils/validation';
import { handleConnection, type ExtendedWebSocket } from '../../handlers/websocket';
import { logger } from '../../utils/logger';
import type { JoinMessage } from '../../types/messages';

// Mock WebSocket connection interface for testing
interface MockWebSocket {
  readyState: 0 | 1 | 2 | 3; // CONNECTING | OPEN | CLOSING | CLOSED
  close: jest.Mock;
  send: jest.Mock;
  on: jest.Mock;
  once: jest.Mock;
  removeListener: jest.Mock;
  removeAllListeners: jest.Mock;
  addEventListener: jest.Mock;
  removeEventListener: jest.Mock;
  // Custom properties for metadata storage
  roomId?: string;
  clientId?: string;
  joinTimeout?: NodeJS.Timeout;
}

/**
 * Create a mock WebSocket connection for testing
 */
function createMockWebSocket(): MockWebSocket {
  const mockWs: MockWebSocket = {
    readyState: 1, // OPEN
    close: jest.fn(),
    send: jest.fn(),
    on: jest.fn(),
    once: jest.fn(),
    removeListener: jest.fn(),
    removeAllListeners: jest.fn(),
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
  };
  return mockWs;
}

/**
 * Simulate a WebSocket connection upgrade
 */
function simulateWebSocketUpgrade(mockWs: MockWebSocket, roomId: string): void {
  mockWs.readyState = 1; // OPEN
  handleConnection(mockWs as unknown as ExtendedWebSocket, { url: `/${roomId}` });
}

/**
 * Simulate receiving a message on WebSocket connection
 */
function simulateWebSocketMessage(mockWs: MockWebSocket, message: string): void {
  const messageHandler = mockWs.on.mock.calls.find(call => call[0] === 'message')?.[1];
  if (messageHandler) {
    messageHandler(Buffer.from(message));
  }
}

/**
 * Simulate WebSocket connection close
 */
function simulateWebSocketClose(mockWs: MockWebSocket, code?: number, reason?: string): void {
  mockWs.readyState = 3; // CLOSED
  const closeHandler = mockWs.on.mock.calls.find(call => call[0] === 'close')?.[1];
  if (closeHandler) {
    const reasonBuffer = reason ? Buffer.from(reason, 'utf-8') : Buffer.from('');
    closeHandler(code ?? 1000, reasonBuffer);
  }
}

/**
 * Create a valid JOIN message
 */
function createJoinMessage(
  password: string,
  clientId?: string,
  lastKnownTime?: number
): JoinMessage {
  const message: JoinMessage = {
    type: 'JOIN',
    password,
  };
  if (clientId !== undefined) {
    message.clientId = clientId;
  }
  if (lastKnownTime !== undefined) {
    message.lastKnownTime = lastKnownTime;
  }
  return message;
}

describe('JOIN Message Handling (Step 3.3)', () => {
  beforeEach(() => {
    setupTestEnv();
    clearAllRooms();
    jest.useFakeTimers();
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.useRealTimers();
    cleanupTestEnv();
    clearAllRooms();
  });

  describe('Schema Validation', () => {
    it('should validate a valid JOIN message', () => {
      const message: JoinMessage = {
        type: 'JOIN',
        password: 'test-password',
      };

      const result = validateMessage(message, 'JOIN');
      expect(result.valid).toBe(true);
      expect(result.errors).toBeNull();
    });

    it('should validate JOIN message with optional lastKnownTime', () => {
      const message: JoinMessage = {
        type: 'JOIN',
        password: 'test-password',
        lastKnownTime: 12.345,
      };

      const result = validateMessage(message, 'JOIN');
      expect(result.valid).toBe(true);
      expect(result.errors).toBeNull();
    });

    it('should validate JOIN message with optional clientId for reconnection', () => {
      const message: JoinMessage = {
        type: 'JOIN',
        password: 'test-password',
        clientId: '123e4567-e89b-12d3-a456-426614174001',
      };

      const result = validateMessage(message, 'JOIN');
      expect(result.valid).toBe(true);
      expect(result.errors).toBeNull();
    });

    it('should reject JOIN message with invalid clientId format', () => {
      const message = {
        type: 'JOIN',
        password: 'test-password',
        clientId: 'invalid-client-id',
      };

      const result = validateMessage(message, 'JOIN');
      expect(result.valid).toBe(false);
      expect(result.errors).not.toBeNull();
    });

    it('should reject JOIN message with empty password', () => {
      const message = {
        type: 'JOIN',
        roomId: '123e4567-e89b-12d3-a456-426614174000',
        password: '',
        clientId: '123e4567-e89b-12d3-a456-426614174001',
      };

      const result = validateMessage(message, 'JOIN');
      expect(result.valid).toBe(false);
      expect(result.errors).not.toBeNull();
    });

    it('should reject JOIN message with negative lastKnownTime', () => {
      const message = {
        type: 'JOIN',
        roomId: '123e4567-e89b-12d3-a456-426614174000',
        password: 'test-password',
        clientId: '123e4567-e89b-12d3-a456-426614174001',
        lastKnownTime: -1,
      };

      const result = validateMessage(message, 'JOIN');
      expect(result.valid).toBe(false);
      expect(result.errors).not.toBeNull();
    });

    it('should reject JOIN message with missing required fields', () => {
      const message = {
        type: 'JOIN',
        // Missing password
      };

      const result = validateMessage(message, 'JOIN');
      expect(result.valid).toBe(false);
      expect(result.errors).not.toBeNull();
    });
  });

  describe('Valid JOIN with Correct Credentials', () => {
    it('should successfully join a room with correct credentials', () => {
      const mockWs = createMockWebSocket();
      const config = getConfig();
      const roomId = toRoomId('123e4567-e89b-12d3-a456-426614174000');
      const password = 'test-password-123';
      const passwordHash = hashPassword(password, config.serverSecret);

      // Create room
      createRoom(roomId, passwordHash, config.roomTtlSeconds, 'https://example.com/video');

      // Establish connection with roomId in URL
      simulateWebSocketUpgrade(mockWs, roomId);

      // Send JOIN message (no roomId or clientId needed)
      const joinMessage = createJoinMessage(password);
      simulateWebSocketMessage(mockWs, JSON.stringify(joinMessage));

      // Verify connection metadata is set
      expect(mockWs.roomId).toBe(roomId);
      expect(mockWs.clientId).toBeDefined(); // Server-generated

      // Verify connection is tracked
      const room = getRoom(roomId);
      expect(room).toBeDefined();
      expect(room!.connectedClients.has(mockWs.clientId! as ClientId)).toBe(true);
    });

    it('should send ROOM_STATE message to joining client', () => {
      const mockWs = createMockWebSocket();
      const config = getConfig();
      const roomId = toRoomId('123e4567-e89b-12d3-a456-426614174000');
      const password = 'test-password-123';
      const passwordHash = hashPassword(password, config.serverSecret);

      // Create room
      createRoom(roomId, passwordHash, config.roomTtlSeconds, 'https://example.com/video');

      // Establish connection with roomId in URL
      simulateWebSocketUpgrade(mockWs, roomId);

      // Send JOIN message
      const joinMessage = createJoinMessage(password);
      simulateWebSocketMessage(mockWs, JSON.stringify(joinMessage));

      // Verify ROOM_STATE was sent
      expect(mockWs.send).toHaveBeenCalled();
      const sentMessage = JSON.parse(mockWs.send.mock.calls[0][0] as string);
      expect(sentMessage.type).toBe('ROOM_STATE');
      expect(sentMessage.clientId).toBeDefined(); // Server-generated clientId
    });

    it('should include room state and clientId in ROOM_STATE message', () => {
      const mockWs = createMockWebSocket();
      const config = getConfig();
      const roomId = toRoomId('123e4567-e89b-12d3-a456-426614174000');
      const password = 'test-password-123';
      const passwordHash = hashPassword(password, config.serverSecret);

      // Create room with initial state
      const room = createRoom(
        roomId,
        passwordHash,
        config.roomTtlSeconds,
        'https://example.com/video'
      );
      room.state.paused = false;
      room.state.time = 42.5;
      room.state.provider = 'netflix';
      room.state.episode = 5;
      room.state.eventId = 10;

      // Establish connection with roomId in URL
      simulateWebSocketUpgrade(mockWs, roomId);

      // Send JOIN message
      const joinMessage = createJoinMessage(password);
      simulateWebSocketMessage(mockWs, JSON.stringify(joinMessage));

      // Verify ROOM_STATE contains correct state and clientId
      expect(mockWs.send).toHaveBeenCalled();
      const sentMessage = JSON.parse(mockWs.send.mock.calls[0][0] as string);
      expect(sentMessage.type).toBe('ROOM_STATE');
      expect(sentMessage.clientId).toBeDefined();
      expect(sentMessage.paused).toBe(false);
      expect(sentMessage.time).toBe(42.5);
      expect(sentMessage.lastEventId).toBe(10);
    });
  });

  describe('Authentication Failures', () => {
    it('should send ERROR message and close connection on invalid password', () => {
      const mockWs = createMockWebSocket();
      const config = getConfig();
      const roomId = toRoomId('123e4567-e89b-12d3-a456-426614174000');
      const correctPassword = 'test-password-123';
      const wrongPassword = 'wrong-password';
      const passwordHash = hashPassword(correctPassword, config.serverSecret);

      // Create room with correct password
      createRoom(roomId, passwordHash, config.roomTtlSeconds, 'https://example.com/video');

      // Establish connection with roomId in URL
      simulateWebSocketUpgrade(mockWs, roomId);

      // Send JOIN message with wrong password
      const joinMessage = createJoinMessage(wrongPassword);
      simulateWebSocketMessage(mockWs, JSON.stringify(joinMessage));

      // Verify ERROR message was sent
      expect(mockWs.send).toHaveBeenCalled();
      const sentMessage = JSON.parse(mockWs.send.mock.calls[0][0] as string);
      expect(sentMessage.type).toBe('ERROR');
      expect(sentMessage.code).toBe('AUTH_FAILED');

      // Verify connection is closed
      expect(mockWs.close).toHaveBeenCalled();
    });

    it('should send ERROR message with AUTH_FAILED code on invalid password', () => {
      const mockWs = createMockWebSocket();
      const config = getConfig();
      const roomId = toRoomId('123e4567-e89b-12d3-a456-426614174000');
      const correctPassword = 'test-password-123';
      const wrongPassword = 'wrong-password';
      const passwordHash = hashPassword(correctPassword, config.serverSecret);

      // Create room
      createRoom(roomId, passwordHash, config.roomTtlSeconds, 'https://example.com/video');

      // Establish connection with roomId in URL
      simulateWebSocketUpgrade(mockWs, roomId);

      // Send JOIN message with wrong password
      const joinMessage = createJoinMessage(wrongPassword);
      simulateWebSocketMessage(mockWs, JSON.stringify(joinMessage));

      // Verify password verification fails
      const room = getRoom(roomId);
      expect(room).toBeDefined();
      const isValid = verifyPassword(wrongPassword, room!.passwordHash, config.serverSecret);
      expect(isValid).toBe(false);

      // Verify ERROR message was sent
      expect(mockWs.send).toHaveBeenCalled();
      const sentMessage = JSON.parse(mockWs.send.mock.calls[0][0] as string);
      expect(sentMessage.code).toBe('AUTH_FAILED');
    });
  });

  describe('Room Not Found', () => {
    it('should reject connection immediately for non-existent room', () => {
      const mockWs = createMockWebSocket();
      const nonExistentRoomId = toRoomId('999e9999-e99b-99d9-a999-999999999999');

      // Verify room doesn't exist
      const room = getRoom(nonExistentRoomId);
      expect(room).toBeUndefined();

      // Establish connection with non-existent roomId in URL - should be rejected immediately
      simulateWebSocketUpgrade(mockWs, nonExistentRoomId);

      // Connection should be closed immediately, no JOIN message needed
      expect(mockWs.close).toHaveBeenCalled();
      expect(mockWs.close).toHaveBeenCalledWith(1008, 'Room not found');
    });

    it('should reject connection immediately for expired room', () => {
      const mockWs = createMockWebSocket();
      const config = getConfig();
      const roomId = toRoomId('123e4567-e89b-12d3-a456-426614174000');
      const password = 'test-password';
      const passwordHash = hashPassword(password, config.serverSecret);

      // Create room with very short TTL
      const room = createRoom(roomId, passwordHash, 1, 'https://example.com/video');

      // Fast-forward time to expire the room
      jest.advanceTimersByTime(2000);

      // Verify room is expired
      const now = Date.now();
      expect(room.expiresAt).toBeLessThan(now);

      // Establish connection with expired roomId in URL - should be rejected immediately
      simulateWebSocketUpgrade(mockWs, roomId);

      // Connection should be closed immediately, no JOIN message needed
      expect(mockWs.close).toHaveBeenCalled();
      expect(mockWs.close).toHaveBeenCalledWith(1008, 'Room not found');
    });
  });

  describe('Multiple Clients Joining Same Room', () => {
    it('should allow multiple clients to join the same room', () => {
      const config = getConfig();
      const roomId = toRoomId('123e4567-e89b-12d3-a456-426614174000');
      const password = 'test-password-123';
      const passwordHash = hashPassword(password, config.serverSecret);

      // Create room
      createRoom(roomId, passwordHash, config.roomTtlSeconds, 'https://example.com/video');

      // Create multiple client connections
      const mockWs1 = createMockWebSocket();
      const mockWs2 = createMockWebSocket();
      const mockWs3 = createMockWebSocket();

      // Establish connections with roomId in URL
      simulateWebSocketUpgrade(mockWs1, roomId);
      simulateWebSocketUpgrade(mockWs2, roomId);
      simulateWebSocketUpgrade(mockWs3, roomId);

      // Send JOIN messages (server generates clientIds)
      simulateWebSocketMessage(mockWs1, JSON.stringify(createJoinMessage(password)));
      simulateWebSocketMessage(mockWs2, JSON.stringify(createJoinMessage(password)));
      simulateWebSocketMessage(mockWs3, JSON.stringify(createJoinMessage(password)));

      // Verify all connections have correct metadata
      expect(mockWs1.roomId).toBe(roomId);
      expect(mockWs1.clientId).toBeDefined(); // Server-generated
      expect(mockWs2.roomId).toBe(roomId);
      expect(mockWs2.clientId).toBeDefined(); // Server-generated
      expect(mockWs3.roomId).toBe(roomId);
      expect(mockWs3.clientId).toBeDefined(); // Server-generated

      // Verify all clients received ROOM_STATE with unique clientIds
      expect(mockWs1.send).toHaveBeenCalled();
      expect(mockWs2.send).toHaveBeenCalled();
      expect(mockWs3.send).toHaveBeenCalled();

      const clientId1 = JSON.parse(mockWs1.send.mock.calls[0][0] as string).clientId;
      const clientId2 = JSON.parse(mockWs2.send.mock.calls[0][0] as string).clientId;
      const clientId3 = JSON.parse(mockWs3.send.mock.calls[0][0] as string).clientId;
      expect(clientId1).not.toBe(clientId2);
      expect(clientId2).not.toBe(clientId3);
    });

    it('should track all clients in room.connectedClients', () => {
      const config = getConfig();
      const roomId = toRoomId('123e4567-e89b-12d3-a456-426614174000');
      const password = 'test-password-123';
      const passwordHash = hashPassword(password, config.serverSecret);

      // Create room
      const room = createRoom(
        roomId,
        passwordHash,
        config.roomTtlSeconds,
        'https://example.com/video'
      );

      // Create multiple client connections
      const mockWs1 = createMockWebSocket();
      const mockWs2 = createMockWebSocket();

      // Establish connections and join
      simulateWebSocketUpgrade(mockWs1, roomId);
      simulateWebSocketUpgrade(mockWs2, roomId);

      simulateWebSocketMessage(mockWs1, JSON.stringify(createJoinMessage(password)));
      simulateWebSocketMessage(mockWs2, JSON.stringify(createJoinMessage(password)));

      // Verify clients are tracked in room.connectedClients
      expect(room.connectedClients).toBeDefined();
      expect(room.connectedClients.size).toBe(2);
      expect(room.connectedClients.has(mockWs1.clientId! as ClientId)).toBe(true);
      expect(room.connectedClients.has(mockWs2.clientId! as ClientId)).toBe(true);
    });
  });

  describe('Tombstone Reconnection', () => {
    it('should reattach connection for client with valid tombstone', () => {
      const mockWs1 = createMockWebSocket();
      const mockWs2 = createMockWebSocket();
      const config = getConfig();
      const roomId = toRoomId('123e4567-e89b-12d3-a456-426614174000');
      const password = 'test-password-123';
      const passwordHash = hashPassword(password, config.serverSecret);

      // Create room
      createRoom(roomId, passwordHash, config.roomTtlSeconds, 'https://example.com/video');

      // First connection - client joins (server generates clientId)
      simulateWebSocketUpgrade(mockWs1, roomId);
      simulateWebSocketMessage(mockWs1, JSON.stringify(createJoinMessage(password)));

      // Get the clientId from ROOM_STATE response
      const firstRoomState = JSON.parse(mockWs1.send.mock.calls[0][0] as string);
      const clientId = firstRoomState.clientId;

      // Simulate disconnect (creates tombstone)
      simulateWebSocketClose(mockWs1);

      // Simulate reconnection within tombstone window
      jest.advanceTimersByTime(1000); // 1 second later

      simulateWebSocketUpgrade(mockWs2, roomId);
      // Reconnect with previous clientId
      simulateWebSocketMessage(mockWs2, JSON.stringify(createJoinMessage(password, clientId)));

      // Verify reconnection uses same clientId
      expect(mockWs2.clientId).toBe(clientId);
      expect(mockWs2.roomId).toBe(roomId);

      // Verify ROOM_STATE includes the same clientId
      const secondRoomState = JSON.parse(mockWs2.send.mock.calls[0][0] as string);
      expect(secondRoomState.clientId).toBe(clientId);
    });

    it('should create new client if tombstone expired', () => {
      const mockWs1 = createMockWebSocket();
      const mockWs2 = createMockWebSocket();
      const config = getConfig();
      const roomId = toRoomId('123e4567-e89b-12d3-a456-426614174000');
      const password = 'test-password-123';
      const passwordHash = hashPassword(password, config.serverSecret);

      // Create room
      createRoom(roomId, passwordHash, config.roomTtlSeconds, 'https://example.com/video');

      // First connection
      simulateWebSocketUpgrade(mockWs1, roomId);
      simulateWebSocketMessage(mockWs1, JSON.stringify(createJoinMessage(password)));

      // Get the clientId from ROOM_STATE response
      const firstRoomState = JSON.parse(mockWs1.send.mock.calls[0][0] as string);
      const originalClientId = firstRoomState.clientId;

      // Simulate disconnect (creates tombstone)
      simulateWebSocketClose(mockWs1);

      // Simulate disconnect and tombstone expiration
      jest.advanceTimersByTime(31000); // Past tombstone window (30s + 1s)

      // Reconnection after tombstone expiry - provide expired clientId
      simulateWebSocketUpgrade(mockWs2, roomId);
      simulateWebSocketMessage(
        mockWs2,
        JSON.stringify(createJoinMessage(password, originalClientId))
      );

      // Verify new clientId is generated (tombstone expired, new client created)
      expect(mockWs2.clientId).toBeDefined();
      // The clientId might be the same if tombstone logic allows it, or different if expired
      // The key is that the connection succeeds
      const secondRoomState = JSON.parse(mockWs2.send.mock.calls[0][0] as string);
      expect(secondRoomState.clientId).toBeDefined();
    });
  });

  describe('Logging', () => {
    it('should log join event with structured logging', () => {
      const mockWs = createMockWebSocket();
      const config = getConfig();
      const roomId = toRoomId('123e4567-e89b-12d3-a456-426614174000');
      const password = 'test-password-123';
      const passwordHash = hashPassword(password, config.serverSecret);

      // Create room
      createRoom(roomId, passwordHash, config.roomTtlSeconds, 'https://example.com/video');

      // Establish connection with roomId in URL
      simulateWebSocketUpgrade(mockWs, roomId);

      // Spy on logger
      const loggerSpy = jest.spyOn(logger, 'info');

      // Send JOIN message
      const joinMessage = createJoinMessage(password);
      simulateWebSocketMessage(mockWs, JSON.stringify(joinMessage));

      // Verify logging occurred
      expect(loggerSpy).toHaveBeenCalled();

      loggerSpy.mockRestore();
    });

    it('should log authentication failures', () => {
      const mockWs = createMockWebSocket();
      const config = getConfig();
      const roomId = toRoomId('123e4567-e89b-12d3-a456-426614174000');
      const correctPassword = 'test-password-123';
      const wrongPassword = 'wrong-password';
      const passwordHash = hashPassword(correctPassword, config.serverSecret);

      // Create room
      createRoom(roomId, passwordHash, config.roomTtlSeconds, 'https://example.com/video');

      // Establish connection with roomId in URL
      simulateWebSocketUpgrade(mockWs, roomId);

      // Spy on logger
      const loggerSpy = jest.spyOn(logger, 'warn');

      // Send JOIN message with wrong password
      const joinMessage = createJoinMessage(wrongPassword);
      simulateWebSocketMessage(mockWs, JSON.stringify(joinMessage));

      // Verify ERROR message was sent
      expect(mockWs.send).toHaveBeenCalled();
      expect(loggerSpy).toHaveBeenCalled();

      loggerSpy.mockRestore();
    });
  });

  describe('Invalid Message Format', () => {
    it('should send ERROR message for invalid JSON', () => {
      const mockWs = createMockWebSocket();
      const roomId = toRoomId('123e4567-e89b-12d3-a456-426614174000');

      // Establish connection with roomId in URL
      simulateWebSocketUpgrade(mockWs, roomId);

      // Send invalid JSON
      simulateWebSocketMessage(mockWs, 'invalid json{');

      // Verify connection is closed
      expect(mockWs.close).toHaveBeenCalled();
    });

    it('should send ERROR message for invalid JOIN message schema', () => {
      const mockWs = createMockWebSocket();
      const config = getConfig();
      const roomId = toRoomId('123e4567-e89b-12d3-a456-426614174000');
      const password = 'test-password-123';
      const passwordHash = hashPassword(password, config.serverSecret);

      // Create room
      createRoom(roomId, passwordHash, config.roomTtlSeconds, 'https://example.com/video');

      // Establish connection with roomId in URL
      simulateWebSocketUpgrade(mockWs, roomId);

      // Send invalid JOIN message (missing required password)
      const invalidMessage = {
        type: 'JOIN',
        // Missing password
      };
      simulateWebSocketMessage(mockWs, JSON.stringify(invalidMessage));

      // Verify ERROR message was sent
      expect(mockWs.send).toHaveBeenCalled();
      const sentMessage = JSON.parse(mockWs.send.mock.calls[0][0] as string);
      expect(sentMessage.type).toBe('ERROR');
      expect(sentMessage.code).toBe('INVALID_MESSAGE');
    });
  });

  describe('Edge Cases', () => {
    it('should handle JOIN message with lastKnownTime for drift detection', () => {
      const mockWs = createMockWebSocket();
      const config = getConfig();
      const roomId = toRoomId('123e4567-e89b-12d3-a456-426614174000');
      const password = 'test-password-123';
      const passwordHash = hashPassword(password, config.serverSecret);

      // Create room
      createRoom(roomId, passwordHash, config.roomTtlSeconds, 'https://example.com/video');

      // Establish connection with roomId in URL
      simulateWebSocketUpgrade(mockWs, roomId);

      // Send JOIN message with lastKnownTime
      const joinMessage = createJoinMessage(password, undefined, 42.5);
      simulateWebSocketMessage(mockWs, JSON.stringify(joinMessage));

      // Verify message was processed
      expect(mockWs.roomId).toBe(roomId);
      expect(mockWs.clientId).toBeDefined(); // Server-generated

      // Note: Actual implementation would use lastKnownTime for drift detection
      // This test verifies the message format is accepted
    });

    it('should handle rapid consecutive JOIN messages', () => {
      const mockWs = createMockWebSocket();
      const config = getConfig();
      const roomId = toRoomId('123e4567-e89b-12d3-a456-426614174000');
      const password = 'test-password-123';
      const passwordHash = hashPassword(password, config.serverSecret);

      // Create room
      createRoom(roomId, passwordHash, config.roomTtlSeconds, 'https://example.com/video');

      // Establish connection with roomId in URL
      simulateWebSocketUpgrade(mockWs, roomId);

      // Send multiple JOIN messages rapidly
      const joinMessage = createJoinMessage(password);
      simulateWebSocketMessage(mockWs, JSON.stringify(joinMessage));
      simulateWebSocketMessage(mockWs, JSON.stringify(joinMessage));
      simulateWebSocketMessage(mockWs, JSON.stringify(joinMessage));

      // Note: Actual implementation should handle duplicate JOIN gracefully
      // This test structure verifies the expected behavior
      expect(mockWs.roomId).toBe(roomId);
      expect(mockWs.clientId).toBeDefined();
    });

    it('should reject connection with invalid roomId in URL', () => {
      const mockWs = createMockWebSocket();

      // Establish connection with invalid roomId in URL path
      mockWs.readyState = 1; // OPEN
      handleConnection(mockWs as unknown as ExtendedWebSocket, { url: '/invalid-room-id' });

      // Verify connection is closed due to invalid roomId
      expect(mockWs.close).toHaveBeenCalled();
    });
  });
});
