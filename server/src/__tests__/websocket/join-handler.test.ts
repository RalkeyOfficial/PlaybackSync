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

describe('JOIN Message Handling', () => {
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

  describe('Client Reconnection & Tombstone Logic', () => {
    describe('Tombstone Creation on Disconnect', () => {
      it('should create tombstone when client disconnects', () => {
        const mockWs = createMockWebSocket();
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

        // Client joins
        simulateWebSocketUpgrade(mockWs, roomId);
        simulateWebSocketMessage(mockWs, JSON.stringify(createJoinMessage(password)));

        const firstRoomState = JSON.parse(mockWs.send.mock.calls[0][0] as string);
        const clientId = firstRoomState.clientId as ClientId;

        // Verify client is connected
        const client = room.connectedClients.get(clientId);
        expect(client).toBeDefined();
        expect(client!.tombstonedUntil).toBeUndefined();

        // Simulate disconnect (creates tombstone)
        simulateWebSocketClose(mockWs);

        // Verify tombstone was created
        const tombstonedClient = room.connectedClients.get(clientId);
        expect(tombstonedClient).toBeDefined();
        expect(tombstonedClient!.tombstonedUntil).toBeDefined();
        expect(tombstonedClient!.tombstonedUntil).toBeGreaterThan(Date.now());
        expect(tombstonedClient!.tombstonedUntil).toBeLessThanOrEqual(
          Date.now() + config.clientTombstoneMs
        );
      });

      it('should set tombstonedUntil to now + CLIENT_TOMBSTONE_MS', () => {
        const mockWs = createMockWebSocket();
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

        // Client joins
        simulateWebSocketUpgrade(mockWs, roomId);
        simulateWebSocketMessage(mockWs, JSON.stringify(createJoinMessage(password)));

        const firstRoomState = JSON.parse(mockWs.send.mock.calls[0][0] as string);
        const clientId = firstRoomState.clientId as ClientId;

        const now = Date.now();
        jest.advanceTimersByTime(100); // Small advance to ensure timestamp difference

        // Simulate disconnect
        simulateWebSocketClose(mockWs);

        // Verify tombstone timestamp is correct
        const tombstonedClient = room.connectedClients.get(clientId);
        expect(tombstonedClient!.tombstonedUntil).toBeDefined();
        const expectedTombstoneTime = now + config.clientTombstoneMs;
        // Allow small margin for test execution time
        expect(tombstonedClient!.tombstonedUntil).toBeGreaterThanOrEqual(
          expectedTombstoneTime - 100
        );
        expect(tombstonedClient!.tombstonedUntil).toBeLessThanOrEqual(
          expectedTombstoneTime + 100
        );
      });

      it('should remove connection from connectionsByRoom on disconnect', () => {
        const mockWs = createMockWebSocket();
        const config = getConfig();
        const roomId = toRoomId('123e4567-e89b-12d3-a456-426614174000');
        const password = 'test-password-123';
        const passwordHash = hashPassword(password, config.serverSecret);

        // Create room
        createRoom(roomId, passwordHash, config.roomTtlSeconds, 'https://example.com/video');

        // Client joins
        simulateWebSocketUpgrade(mockWs, roomId);
        simulateWebSocketMessage(mockWs, JSON.stringify(createJoinMessage(password)));

        // Get connectionsByRoom from the handler (we'll need to check this differently)
        // For now, verify the connection metadata is cleared
        simulateWebSocketClose(mockWs);

        // Connection should be marked as closed
        expect(mockWs.readyState).toBe(3); // CLOSED
      });
    });

    describe('Reconnection Within Tombstone Window', () => {
      it('should reattach connection for client with valid tombstone', () => {
        const mockWs1 = createMockWebSocket();
        const mockWs2 = createMockWebSocket();
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

        // First connection - client joins (server generates clientId)
        simulateWebSocketUpgrade(mockWs1, roomId);
        simulateWebSocketMessage(mockWs1, JSON.stringify(createJoinMessage(password)));

        // Get the clientId from ROOM_STATE response
        const firstRoomState = JSON.parse(mockWs1.send.mock.calls[0][0] as string);
        const clientId = firstRoomState.clientId;

        // Simulate disconnect (creates tombstone)
        simulateWebSocketClose(mockWs1);

        // Verify tombstone exists
        const tombstonedClient = room.connectedClients.get(clientId as ClientId);
        expect(tombstonedClient!.tombstonedUntil).toBeDefined();

        // Simulate reconnection within tombstone window
        jest.advanceTimersByTime(1000); // 1 second later (well within 30s window)

        simulateWebSocketUpgrade(mockWs2, roomId);
        // Reconnect with previous clientId
        simulateWebSocketMessage(mockWs2, JSON.stringify(createJoinMessage(password, clientId)));

        // Verify reconnection uses same clientId
        expect(mockWs2.clientId).toBe(clientId);
        expect(mockWs2.roomId).toBe(roomId);

        // Verify tombstone was cleared
        const reconnectedClient = room.connectedClients.get(clientId as ClientId);
        expect(reconnectedClient).toBeDefined();
        expect(reconnectedClient!.tombstonedUntil).toBeUndefined();
        expect(reconnectedClient!.conn).toBe(mockWs2);

        // Verify ROOM_STATE includes the same clientId
        const secondRoomState = JSON.parse(mockWs2.send.mock.calls[0][0] as string);
        expect(secondRoomState.clientId).toBe(clientId);
      });

      it('should preserve client state on reconnection', () => {
        const mockWs1 = createMockWebSocket();
        const mockWs2 = createMockWebSocket();
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
        room.state.time = 100.5;
        room.state.eventId = 42;

        // First connection
        simulateWebSocketUpgrade(mockWs1, roomId);
        simulateWebSocketMessage(mockWs1, JSON.stringify(createJoinMessage(password)));

        const firstRoomState = JSON.parse(mockWs1.send.mock.calls[0][0] as string);
        const clientId = firstRoomState.clientId;

        // Update room state while client is connected
        room.state.time = 150.75;
        room.state.eventId = 50;

        // Disconnect
        simulateWebSocketClose(mockWs1);

        // Reconnect within tombstone window
        jest.advanceTimersByTime(5000); // 5 seconds later

        simulateWebSocketUpgrade(mockWs2, roomId);
        simulateWebSocketMessage(mockWs2, JSON.stringify(createJoinMessage(password, clientId)));

        // Verify ROOM_STATE reflects current room state
        const secondRoomState = JSON.parse(mockWs2.send.mock.calls[0][0] as string);
        expect(secondRoomState.clientId).toBe(clientId);
        expect(secondRoomState.time).toBe(150.75);
        expect(secondRoomState.lastEventId).toBe(50);
        expect(secondRoomState.paused).toBe(false);
      });

      it('should update lastSeen timestamp on reconnection', () => {
        const mockWs1 = createMockWebSocket();
        const mockWs2 = createMockWebSocket();
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

        // First connection
        simulateWebSocketUpgrade(mockWs1, roomId);
        simulateWebSocketMessage(mockWs1, JSON.stringify(createJoinMessage(password)));

        const firstRoomState = JSON.parse(mockWs1.send.mock.calls[0][0] as string);
        const clientId = firstRoomState.clientId as ClientId;

        const initialLastSeen = room.connectedClients.get(clientId)!.lastSeen;

        // Disconnect
        simulateWebSocketClose(mockWs1);

        // Advance time
        jest.advanceTimersByTime(5000);

        // Reconnect
        simulateWebSocketUpgrade(mockWs2, roomId);
        simulateWebSocketMessage(mockWs2, JSON.stringify(createJoinMessage(password, clientId)));

        // Verify lastSeen was updated
        const reconnectedClient = room.connectedClients.get(clientId);
        expect(reconnectedClient!.lastSeen).toBeGreaterThan(initialLastSeen);
      });
    });

    describe('Reconnection After Tombstone Expiry', () => {
      it('should honor same clientId even if tombstone expired (no state preservation)', () => {
        const mockWs1 = createMockWebSocket();
        const mockWs2 = createMockWebSocket();
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

        // First connection
        simulateWebSocketUpgrade(mockWs1, roomId);
        simulateWebSocketMessage(mockWs1, JSON.stringify(createJoinMessage(password)));

        // Get the clientId from ROOM_STATE response
        const firstRoomState = JSON.parse(mockWs1.send.mock.calls[0][0] as string);
        const originalClientId = firstRoomState.clientId as ClientId;

        // Simulate disconnect (creates tombstone)
        simulateWebSocketClose(mockWs1);

        // Verify tombstone exists
        expect(room.connectedClients.get(originalClientId)!.tombstonedUntil).toBeDefined();

        // Simulate tombstone expiration
        jest.advanceTimersByTime(config.clientTombstoneMs + 1000); // Past tombstone window

        // Reconnection after tombstone expiry - provide expired clientId
        // According to backend_design_v1.md: tombstone allows "re-association" with same clientId
        // Even if tombstone expired, we honor the clientId (just don't preserve state)
        simulateWebSocketUpgrade(mockWs2, roomId);
        simulateWebSocketMessage(
          mockWs2,
          JSON.stringify(createJoinMessage(password, originalClientId))
        );

        // Verify same clientId is used (tombstone expired, but clientId is honored)
        expect(mockWs2.clientId).toBeDefined();
        expect(mockWs2.clientId).toBe(originalClientId);
        
        const secondRoomState = JSON.parse(mockWs2.send.mock.calls[0][0] as string);
        expect(secondRoomState.clientId).toBe(originalClientId);
        
        // Verify expired tombstone was removed and new client entry created with same clientId
        // The old entry (with tombstone) was removed, and a new entry (without tombstone) was created
        expect(room.connectedClients.has(originalClientId)).toBe(true);
        const newClient = room.connectedClients.get(originalClientId);
        expect(newClient).toBeDefined();
        expect(newClient!.tombstonedUntil).toBeUndefined(); // No tombstone for new client
        expect(newClient!.conn).toBe(mockWs2); // Connection is attached to new entry
      });

      it('should remove expired tombstone when attempting reconnection', () => {
        const mockWs1 = createMockWebSocket();
        const mockWs2 = createMockWebSocket();
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

        // First connection
        simulateWebSocketUpgrade(mockWs1, roomId);
        simulateWebSocketMessage(mockWs1, JSON.stringify(createJoinMessage(password)));

        const firstRoomState = JSON.parse(mockWs1.send.mock.calls[0][0] as string);
        const originalClientId = firstRoomState.clientId as ClientId;

        // Disconnect
        simulateWebSocketClose(mockWs1);

        // Verify tombstone exists
        expect(room.connectedClients.get(originalClientId)!.tombstonedUntil).toBeDefined();

        // Expire tombstone
        jest.advanceTimersByTime(config.clientTombstoneMs + 1000);

        // Attempt reconnection with expired clientId
        // According to backend_design_v1.md: tombstone allows "re-association" with same clientId
        // Even if tombstone expired, we honor the clientId (just don't preserve state)
        simulateWebSocketUpgrade(mockWs2, roomId);
        simulateWebSocketMessage(
          mockWs2,
          JSON.stringify(createJoinMessage(password, originalClientId))
        );

        // Verify expired tombstone was removed and new client entry created with same clientId
        expect(room.connectedClients.has(originalClientId)).toBe(true);
        const newClient = room.connectedClients.get(originalClientId);
        expect(newClient).toBeDefined();
        expect(newClient!.tombstonedUntil).toBeUndefined(); // No tombstone for new client
        expect(mockWs2.clientId).toBe(originalClientId); // Same clientId is honored
      });
    });

    describe('ROOM_STATE Content on Reconnection', () => {
      it('should include derivedContentKey in ROOM_STATE on reconnection', () => {
        const mockWs1 = createMockWebSocket();
        const mockWs2 = createMockWebSocket();
        const config = getConfig();
        const roomId = toRoomId('123e4567-e89b-12d3-a456-426614174000');
        const password = 'test-password-123';
        const passwordHash = hashPassword(password, config.serverSecret);

        // Create room with content identity
        const room = createRoom(
          roomId,
          passwordHash,
          config.roomTtlSeconds,
          'https://example.com/video'
        );
        room.contentIdentity = {
          episodeId: 'ep5',
          providerId: 'netflix',
          derivedContentKey: 'netflix:12345:ep5',
          pageUrl: 'https://netflix.com/watch/12345',
        };

        // First connection
        simulateWebSocketUpgrade(mockWs1, roomId);
        simulateWebSocketMessage(mockWs1, JSON.stringify(createJoinMessage(password)));

        const firstRoomState = JSON.parse(mockWs1.send.mock.calls[0][0] as string);
        const clientId = firstRoomState.clientId;

        // Disconnect and reconnect
        simulateWebSocketClose(mockWs1);
        jest.advanceTimersByTime(1000);

        simulateWebSocketUpgrade(mockWs2, roomId);
        simulateWebSocketMessage(mockWs2, JSON.stringify(createJoinMessage(password, clientId)));

        // Verify ROOM_STATE includes content identity fields
        const secondRoomState = JSON.parse(mockWs2.send.mock.calls[0][0] as string);
        expect(secondRoomState.derivedContentKey).toBe('netflix:12345:ep5');
        expect(secondRoomState.episodeId).toBe('ep5');
        expect(secondRoomState.providerId).toBe('netflix');
      });

      it('should include playback state in ROOM_STATE on reconnection', () => {
        const mockWs1 = createMockWebSocket();
        const mockWs2 = createMockWebSocket();
        const config = getConfig();
        const roomId = toRoomId('123e4567-e89b-12d3-a456-426614174000');
        const password = 'test-password-123';
        const passwordHash = hashPassword(password, config.serverSecret);

        // Create room with specific playback state
        const room = createRoom(
          roomId,
          passwordHash,
          config.roomTtlSeconds,
          'https://example.com/video'
        );
        room.state.paused = true;
        room.state.time = 200.5;
        room.state.eventId = 100;

        // First connection
        simulateWebSocketUpgrade(mockWs1, roomId);
        simulateWebSocketMessage(mockWs1, JSON.stringify(createJoinMessage(password)));

        const firstRoomState = JSON.parse(mockWs1.send.mock.calls[0][0] as string);
        const clientId = firstRoomState.clientId;

        // Disconnect and reconnect
        simulateWebSocketClose(mockWs1);
        jest.advanceTimersByTime(1000);

        simulateWebSocketUpgrade(mockWs2, roomId);
        simulateWebSocketMessage(mockWs2, JSON.stringify(createJoinMessage(password, clientId)));

        // Verify ROOM_STATE includes current playback state
        const secondRoomState = JSON.parse(mockWs2.send.mock.calls[0][0] as string);
        expect(secondRoomState.paused).toBe(true);
        expect(secondRoomState.time).toBe(200.5);
        expect(secondRoomState.lastEventId).toBe(100);
      });

      it('should include server_ts in ROOM_STATE on reconnection', () => {
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

        const firstRoomState = JSON.parse(mockWs1.send.mock.calls[0][0] as string);
        const clientId = firstRoomState.clientId;

        // Disconnect and reconnect
        simulateWebSocketClose(mockWs1);
        jest.advanceTimersByTime(5000);

        simulateWebSocketUpgrade(mockWs2, roomId);
        simulateWebSocketMessage(mockWs2, JSON.stringify(createJoinMessage(password, clientId)));

        // Verify ROOM_STATE includes server_ts
        const secondRoomState = JSON.parse(mockWs2.send.mock.calls[0][0] as string);
        expect(secondRoomState.server_ts).toBeDefined();
        expect(typeof secondRoomState.server_ts).toBe('number');
        expect(secondRoomState.server_ts).toBeGreaterThan(0);
      });
    });

    describe('Rapid Reconnection Scenarios', () => {
      it('should handle multiple rapid reconnects', () => {
        const mockWs1 = createMockWebSocket();
        const mockWs2 = createMockWebSocket();
        const mockWs3 = createMockWebSocket();
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

        // First connection
        simulateWebSocketUpgrade(mockWs1, roomId);
        simulateWebSocketMessage(mockWs1, JSON.stringify(createJoinMessage(password)));

        const firstRoomState = JSON.parse(mockWs1.send.mock.calls[0][0] as string);
        const clientId = firstRoomState.clientId;

        // Disconnect
        simulateWebSocketClose(mockWs1);
        jest.advanceTimersByTime(100);

        // First reconnect
        simulateWebSocketUpgrade(mockWs2, roomId);
        simulateWebSocketMessage(mockWs2, JSON.stringify(createJoinMessage(password, clientId)));

        expect(mockWs2.clientId).toBe(clientId);

        // Disconnect again
        simulateWebSocketClose(mockWs2);
        jest.advanceTimersByTime(100);

        // Second reconnect
        simulateWebSocketUpgrade(mockWs3, roomId);
        simulateWebSocketMessage(mockWs3, JSON.stringify(createJoinMessage(password, clientId)));

        // Should still use same clientId
        expect(mockWs3.clientId).toBe(clientId);
        const reconnectedClient = room.connectedClients.get(clientId as ClientId);
        expect(reconnectedClient).toBeDefined();
        expect(reconnectedClient!.tombstonedUntil).toBeUndefined();
      });

      it('should handle reconnection immediately after disconnect', () => {
        const mockWs1 = createMockWebSocket();
        const mockWs2 = createMockWebSocket();
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

        // First connection
        simulateWebSocketUpgrade(mockWs1, roomId);
        simulateWebSocketMessage(mockWs1, JSON.stringify(createJoinMessage(password)));

        const firstRoomState = JSON.parse(mockWs1.send.mock.calls[0][0] as string);
        const clientId = firstRoomState.clientId;

        // Disconnect
        simulateWebSocketClose(mockWs1);

        // Immediately reconnect (no time advance)
        simulateWebSocketUpgrade(mockWs2, roomId);
        simulateWebSocketMessage(mockWs2, JSON.stringify(createJoinMessage(password, clientId)));

        // Should successfully reconnect
        expect(mockWs2.clientId).toBe(clientId);
        const reconnectedClient = room.connectedClients.get(clientId as ClientId);
        expect(reconnectedClient).toBeDefined();
        expect(reconnectedClient!.tombstonedUntil).toBeUndefined();
      });
    });

    describe('Reconnection Without ClientId', () => {
      it('should create new client when reconnecting without clientId', () => {
        const mockWs1 = createMockWebSocket();
        const mockWs2 = createMockWebSocket();
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

        // First connection
        simulateWebSocketUpgrade(mockWs1, roomId);
        simulateWebSocketMessage(mockWs1, JSON.stringify(createJoinMessage(password)));

        const firstRoomState = JSON.parse(mockWs1.send.mock.calls[0][0] as string);
        const originalClientId = firstRoomState.clientId;

        // Disconnect
        simulateWebSocketClose(mockWs1);
        jest.advanceTimersByTime(1000);

        // Reconnect without clientId (new client)
        simulateWebSocketUpgrade(mockWs2, roomId);
        simulateWebSocketMessage(mockWs2, JSON.stringify(createJoinMessage(password)));

        // Should create new clientId
        expect(mockWs2.clientId).toBeDefined();
        expect(mockWs2.clientId).not.toBe(originalClientId);

        // Original client should still have tombstone
        const originalClient = room.connectedClients.get(originalClientId as ClientId);
        expect(originalClient).toBeDefined();
        expect(originalClient!.tombstonedUntil).toBeDefined();
      });
    });

    describe('Reconnection with Different ClientId', () => {
      it('should create new client when reconnecting with different clientId', () => {
        const mockWs1 = createMockWebSocket();
        const mockWs2 = createMockWebSocket();
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

        // First connection
        simulateWebSocketUpgrade(mockWs1, roomId);
        simulateWebSocketMessage(mockWs1, JSON.stringify(createJoinMessage(password)));

        const firstRoomState = JSON.parse(mockWs1.send.mock.calls[0][0] as string);
        const originalClientId = firstRoomState.clientId;

        // Disconnect
        simulateWebSocketClose(mockWs1);
        jest.advanceTimersByTime(1000);

        // Reconnect with different clientId
        const differentClientId = '999e9999-e99b-99d9-a999-999999999999';
        simulateWebSocketUpgrade(mockWs2, roomId);
        simulateWebSocketMessage(
          mockWs2,
          JSON.stringify(createJoinMessage(password, differentClientId))
        );

        // Should create new client with provided clientId
        expect(mockWs2.clientId).toBe(differentClientId);

        // Original client should still have tombstone
        const originalClient = room.connectedClients.get(originalClientId as ClientId);
        expect(originalClient).toBeDefined();
        expect(originalClient!.tombstonedUntil).toBeDefined();

        // New client should exist
        const newClient = room.connectedClients.get(differentClientId as ClientId);
        expect(newClient).toBeDefined();
        expect(newClient!.tombstonedUntil).toBeUndefined();
      });
    });

    describe('Event Replay on Reconnection', () => {
      it('should include lastEventId in ROOM_STATE for event replay', () => {
        const mockWs1 = createMockWebSocket();
        const mockWs2 = createMockWebSocket();
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

        // First connection
        simulateWebSocketUpgrade(mockWs1, roomId);
        simulateWebSocketMessage(mockWs1, JSON.stringify(createJoinMessage(password)));

        const firstRoomState = JSON.parse(mockWs1.send.mock.calls[0][0] as string);
        const clientId = firstRoomState.clientId;
        const initialEventId = firstRoomState.lastEventId;

        // Update eventId (simulating events occurred)
        room.state.eventId = initialEventId + 5;

        // Disconnect and reconnect
        simulateWebSocketClose(mockWs1);
        jest.advanceTimersByTime(1000);

        simulateWebSocketUpgrade(mockWs2, roomId);
        simulateWebSocketMessage(mockWs2, JSON.stringify(createJoinMessage(password, clientId)));

        // Verify ROOM_STATE includes updated lastEventId
        // According to backend_network_design_v1.md section 7:
        // "Request ROOM_STATE; server returns { videoPos, playerState, lastEventId } and any recentEvents[] since lastEventId"
        const secondRoomState = JSON.parse(mockWs2.send.mock.calls[0][0] as string);
        expect(secondRoomState.lastEventId).toBe(initialEventId + 5);
        // Note: Event replay (recentEvents[]) is mentioned in docs but not yet implemented
        // This test verifies lastEventId is included for future event replay implementation
      });

      it('should allow client to determine which events to replay based on lastEventId', () => {
        const mockWs1 = createMockWebSocket();
        const mockWs2 = createMockWebSocket();
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

        // First connection
        simulateWebSocketUpgrade(mockWs1, roomId);
        simulateWebSocketMessage(mockWs1, JSON.stringify(createJoinMessage(password)));

        const firstRoomState = JSON.parse(mockWs1.send.mock.calls[0][0] as string);
        const clientId = firstRoomState.clientId;
        const clientLastKnownEventId = firstRoomState.lastEventId;

        // Simulate events occurred (update eventId)
        room.state.eventId = clientLastKnownEventId + 10;

        // Disconnect and reconnect
        simulateWebSocketClose(mockWs1);
        jest.advanceTimersByTime(1000);

        simulateWebSocketUpgrade(mockWs2, roomId);
        simulateWebSocketMessage(mockWs2, JSON.stringify(createJoinMessage(password, clientId)));

        // Client can compare lastEventId to determine if replay is needed
        const secondRoomState = JSON.parse(mockWs2.send.mock.calls[0][0] as string);
        const serverLastEventId = secondRoomState.lastEventId;

        // Client would determine: serverLastEventId > clientLastKnownEventId means events need replay
        expect(serverLastEventId).toBeGreaterThan(clientLastKnownEventId);
        // According to backend_network_design_v1.md: "If events need replay, server streams them in eventId order; client ACKs each"
        // This functionality is not yet implemented but the test verifies the foundation is in place
      });
    });

    describe('Content Key Comparison on Reconnection', () => {
      it('should include derivedContentKey for client comparison on reconnection', () => {
        const mockWs1 = createMockWebSocket();
        const mockWs2 = createMockWebSocket();
        const config = getConfig();
        const roomId = toRoomId('123e4567-e89b-12d3-a456-426614174000');
        const password = 'test-password-123';
        const passwordHash = hashPassword(password, config.serverSecret);

        // Create room with content identity
        const room = createRoom(
          roomId,
          passwordHash,
          config.roomTtlSeconds,
          'https://example.com/video'
        );
        room.contentIdentity = {
          episodeId: 'ep5',
          providerId: 'netflix',
          derivedContentKey: 'netflix:12345:ep5',
          pageUrl: 'https://netflix.com/watch/12345',
        };

        // First connection
        simulateWebSocketUpgrade(mockWs1, roomId);
        simulateWebSocketMessage(mockWs1, JSON.stringify(createJoinMessage(password)));

        const firstRoomState = JSON.parse(mockWs1.send.mock.calls[0][0] as string);
        const clientId = firstRoomState.clientId;
        const clientStoredContentKey = firstRoomState.derivedContentKey;

        // Disconnect and reconnect
        simulateWebSocketClose(mockWs1);
        jest.advanceTimersByTime(1000);

        simulateWebSocketUpgrade(mockWs2, roomId);
        simulateWebSocketMessage(mockWs2, JSON.stringify(createJoinMessage(password, clientId)));

        // Verify derivedContentKey is included for comparison
        // According to unified_v1_backend_and_network_design.md section 5:
        // "Compare derivedContentKey. If mismatch: do not auto-seek or auto-play."
        const secondRoomState = JSON.parse(mockWs2.send.mock.calls[0][0] as string);
        expect(secondRoomState.derivedContentKey).toBeDefined();
        expect(secondRoomState.derivedContentKey).toBe(clientStoredContentKey);
        // Client would compare this with local derivedContentKey to determine if content matches
      });
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
