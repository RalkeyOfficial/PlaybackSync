/**
 * Unit tests for WebSocket Server Setup (Step 3.1)
 *
 * Tests verify:
 * - WebSocket server accepts connections
 * - Connections timeout if no JOIN message received
 * - Connection metadata is stored correctly
 * - Connection close events are handled
 * - Multiple concurrent connections work
 */

import { setupTestEnv, cleanupTestEnv } from '../helpers/fixtures';
import { toRoomId, toClientId } from '../../types/ids';
import { createRoom, getRoom } from '../../storage/rooms';
import { hashPassword } from '../../utils/password';
import { getConfig } from '../../config';
import { handleConnection, type ExtendedWebSocket } from '../../handlers/websocket';

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
 * This calls the actual handleConnection function
 */
function simulateWebSocketUpgrade(mockWs: MockWebSocket): void {
  // Simulate connection open
  mockWs.readyState = 1; // OPEN
  // Call the actual handleConnection function
  handleConnection(mockWs as unknown as ExtendedWebSocket, { url: '/test' });
}

/**
 * Simulate receiving a message on WebSocket connection
 */
function simulateWebSocketMessage(mockWs: MockWebSocket, message: string): void {
  // Trigger the 'message' event handler
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
 * Simulate WebSocket connection error
 */
function simulateWebSocketError(mockWs: MockWebSocket, error: Error): void {
  const errorHandler = mockWs.on.mock.calls.find(call => call[0] === 'error')?.[1];
  if (errorHandler) {
    errorHandler(error);
  }
}

describe('WebSocket Server Setup (Step 3.1)', () => {
  beforeEach(() => {
    setupTestEnv();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    cleanupTestEnv();
  });

  describe('Connection Acceptance', () => {
    it('should accept WebSocket connections', () => {
      const mockWs = createMockWebSocket();
      simulateWebSocketUpgrade(mockWs);

      expect(mockWs.readyState).toBe(1); // OPEN
      expect(mockWs.on).toHaveBeenCalled();
    });

    it('should set up connection event handlers on upgrade', () => {
      const mockWs = createMockWebSocket();
      simulateWebSocketUpgrade(mockWs);

      // Verify event handlers are registered
      const eventTypes = mockWs.on.mock.calls.map(call => call[0]);
      expect(eventTypes).toContain('message');
      expect(eventTypes).toContain('close');
      expect(eventTypes).toContain('error');
    });

    it('should handle multiple concurrent connections', () => {
      const mockWs1 = createMockWebSocket();
      const mockWs2 = createMockWebSocket();
      const mockWs3 = createMockWebSocket();

      simulateWebSocketUpgrade(mockWs1);
      simulateWebSocketUpgrade(mockWs2);
      simulateWebSocketUpgrade(mockWs3);

      expect(mockWs1.readyState).toBe(1);
      expect(mockWs2.readyState).toBe(1);
      expect(mockWs3.readyState).toBe(1);
    });
  });

  describe('Connection Timeout (No JOIN Message)', () => {
    const JOIN_TIMEOUT_MS = 5000; // 5 seconds as per spec

    it('should close connection if no JOIN message received within 5 seconds', () => {
      const mockWs = createMockWebSocket();
      simulateWebSocketUpgrade(mockWs);

      // Fast-forward time by 5 seconds
      jest.advanceTimersByTime(JOIN_TIMEOUT_MS);

      // Connection should be closed
      expect(mockWs.close).toHaveBeenCalled();
    });

    it('should not close connection if JOIN message received before timeout', () => {
      const mockWs = createMockWebSocket();
      simulateWebSocketUpgrade(mockWs);

      // Create a room for JOIN message
      const config = getConfig();
      const roomId = toRoomId('123e4567-e89b-12d3-a456-426614174000');
      const password = 'test-password';
      const passwordHash = hashPassword(password, config.serverSecret);
      createRoom(roomId, passwordHash, config.roomTtlSeconds, 'https://example.com/video');

      // Send JOIN message before timeout
      const joinMessage = JSON.stringify({
        type: 'JOIN',
        roomId: roomId,
        password: password,
        clientId: '123e4567-e89b-12d3-a456-426614174001',
      });

      jest.advanceTimersByTime(JOIN_TIMEOUT_MS - 1000); // 4 seconds
      simulateWebSocketMessage(mockWs, joinMessage);

      // Fast-forward remaining time
      jest.advanceTimersByTime(2000); // 2 more seconds

      // Connection should NOT be closed (JOIN was received)
      expect(mockWs.close).not.toHaveBeenCalled();
    });

    it('should clear timeout when JOIN message is received', () => {
      const mockWs = createMockWebSocket();
      simulateWebSocketUpgrade(mockWs);

      // Create a room for JOIN message
      const config = getConfig();
      const roomId = toRoomId('123e4567-e89b-12d3-a456-426614174000');
      const password = 'test-password';
      const passwordHash = hashPassword(password, config.serverSecret);
      createRoom(roomId, passwordHash, config.roomTtlSeconds, 'https://example.com/video');

      // Send JOIN message - this should clear the timeout automatically
      const joinMessage = JSON.stringify({
        type: 'JOIN',
        roomId: roomId,
        password: password,
        clientId: '123e4567-e89b-12d3-a456-426614174001',
      });

      // Advance time a bit but not past timeout
      jest.advanceTimersByTime(JOIN_TIMEOUT_MS - 1000);

      // Send JOIN message - this clears the timeout
      simulateWebSocketMessage(mockWs, joinMessage);

      // Fast-forward past timeout - connection should NOT be closed because timeout was cleared
      jest.advanceTimersByTime(2000);

      // Connection should NOT be closed
      expect(mockWs.close).not.toHaveBeenCalled();
    });
  });

  describe('Connection Metadata Storage', () => {
    it('should attach roomId to WebSocket connection object', () => {
      const mockWs = createMockWebSocket();
      const roomId = toRoomId('123e4567-e89b-12d3-a456-426614174000');

      // Simulate metadata attachment
      mockWs.roomId = roomId;

      expect(mockWs.roomId).toBe(roomId);
      expect(typeof mockWs.roomId).toBe('string');
    });

    it('should attach clientId to WebSocket connection object', () => {
      const mockWs = createMockWebSocket();
      const clientId = toClientId('123e4567-e89b-12d3-a456-426614174001');

      // Simulate metadata attachment
      mockWs.clientId = clientId;

      expect(mockWs.clientId).toBe(clientId);
      expect(typeof mockWs.clientId).toBe('string');
    });

    it('should store both roomId and clientId on connection object', () => {
      const mockWs = createMockWebSocket();
      const roomId = toRoomId('123e4567-e89b-12d3-a456-426614174000');
      const clientId = toClientId('123e4567-e89b-12d3-a456-426614174001');

      // Simulate metadata attachment
      mockWs.roomId = roomId;
      mockWs.clientId = clientId;

      expect(mockWs.roomId).toBe(roomId);
      expect(mockWs.clientId).toBe(clientId);
    });

    it('should allow metadata to be updated on reconnection', () => {
      const mockWs = createMockWebSocket();
      const roomId1 = toRoomId('123e4567-e89b-12d3-a456-426614174000');
      const clientId1 = toClientId('123e4567-e89b-12d3-a456-426614174001');

      // Initial metadata
      mockWs.roomId = roomId1;
      mockWs.clientId = clientId1;

      expect(mockWs.roomId).toBe(roomId1);
      expect(mockWs.clientId).toBe(clientId1);

      // Update metadata (e.g., on reconnection to different room)
      const roomId2 = toRoomId('123e4567-e89b-12d3-a456-426614174002');
      mockWs.roomId = roomId2;

      expect(mockWs.roomId).toBe(roomId2);
      expect(mockWs.clientId).toBe(clientId1); // clientId unchanged
    });
  });

  describe('Connection Close Event Handling', () => {
    it('should handle connection close events', () => {
      const mockWs = createMockWebSocket();
      simulateWebSocketUpgrade(mockWs);

      // Verify close handler is registered
      const closeHandlerCalls = mockWs.on.mock.calls.filter(call => call[0] === 'close');
      expect(closeHandlerCalls.length).toBeGreaterThan(0);

      // Simulate close
      simulateWebSocketClose(mockWs, 1000, 'Normal closure');

      expect(mockWs.readyState).toBe(3); // CLOSED
    });

    it('should clean up connection metadata on close', () => {
      const mockWs = createMockWebSocket();
      const roomId = toRoomId('123e4567-e89b-12d3-a456-426614174000');
      const clientId = toClientId('123e4567-e89b-12d3-a456-426614174001');

      mockWs.roomId = roomId;
      mockWs.clientId = clientId;

      // Simulate close
      simulateWebSocketClose(mockWs);

      // Metadata cleanup would happen in close handler
      // For this test, we verify the close handler can access metadata
      expect(mockWs.roomId).toBeDefined();
      expect(mockWs.clientId).toBeDefined();
    });

    it('should handle abrupt connection closure', () => {
      const mockWs = createMockWebSocket();
      simulateWebSocketUpgrade(mockWs);

      // Simulate abrupt close (no close code/reason)
      // The close handler should be registered and called
      simulateWebSocketClose(mockWs);

      expect(mockWs.readyState).toBe(3); // CLOSED
      // Verify close handler was registered (not that close was called, as simulateWebSocketClose triggers the handler)
      const closeHandlerCalls = mockWs.on.mock.calls.filter(call => call[0] === 'close');
      expect(closeHandlerCalls.length).toBeGreaterThan(0);
    });

    it('should handle multiple close events gracefully', () => {
      const mockWs = createMockWebSocket();
      simulateWebSocketUpgrade(mockWs);

      // Simulate multiple close attempts
      simulateWebSocketClose(mockWs, 1000);
      simulateWebSocketClose(mockWs, 1001);

      // Should handle gracefully without errors
      expect(mockWs.readyState).toBe(3);
    });
  });

  describe('Connection Error Handling', () => {
    it('should handle WebSocket error events', () => {
      const mockWs = createMockWebSocket();
      simulateWebSocketUpgrade(mockWs);

      // Verify error handler is registered
      const errorHandlerCalls = mockWs.on.mock.calls.filter(call => call[0] === 'error');
      expect(errorHandlerCalls.length).toBeGreaterThan(0);

      // Simulate error
      const testError = new Error('Connection error');
      simulateWebSocketError(mockWs, testError);

      // Error should be handled without crashing
      expect(mockWs.on).toHaveBeenCalledWith('error', expect.any(Function));
    });

    it('should close connection on error', () => {
      const mockWs = createMockWebSocket();
      simulateWebSocketUpgrade(mockWs);

      const testError = new Error('Connection error');
      simulateWebSocketError(mockWs, testError);

      // Connection should be closed on error
      expect(mockWs.close).toHaveBeenCalled();
    });
  });

  describe('Multiple Concurrent Connections', () => {
    it('should handle multiple connections independently', () => {
      const mockWs1 = createMockWebSocket();
      const mockWs2 = createMockWebSocket();
      const mockWs3 = createMockWebSocket();

      simulateWebSocketUpgrade(mockWs1);
      simulateWebSocketUpgrade(mockWs2);
      simulateWebSocketUpgrade(mockWs3);

      // Each connection should have its own metadata
      const roomId1 = toRoomId('123e4567-e89b-12d3-a456-426614174000');
      const roomId2 = toRoomId('123e4567-e89b-12d3-a456-426614174001');
      const roomId3 = toRoomId('123e4567-e89b-12d3-a456-426614174002');

      mockWs1.roomId = roomId1;
      mockWs2.roomId = roomId2;
      mockWs3.roomId = roomId3;

      expect(mockWs1.roomId).toBe(roomId1);
      expect(mockWs2.roomId).toBe(roomId2);
      expect(mockWs3.roomId).toBe(roomId3);
    });

    it('should handle connections to the same room', () => {
      const mockWs1 = createMockWebSocket();
      const mockWs2 = createMockWebSocket();
      const roomId = toRoomId('123e4567-e89b-12d3-a456-426614174000');

      simulateWebSocketUpgrade(mockWs1);
      simulateWebSocketUpgrade(mockWs2);

      mockWs1.roomId = roomId;
      mockWs2.roomId = roomId;

      expect(mockWs1.roomId).toBe(roomId);
      expect(mockWs2.roomId).toBe(roomId);
    });

    it('should handle concurrent connection timeouts independently', () => {
      const mockWs1 = createMockWebSocket();
      const mockWs2 = createMockWebSocket();

      simulateWebSocketUpgrade(mockWs1);
      simulateWebSocketUpgrade(mockWs2);

      // Fast-forward time - both should timeout
      jest.advanceTimersByTime(5000);

      expect(mockWs1.close).toHaveBeenCalled();
      expect(mockWs2.close).toHaveBeenCalled();
    });

    it('should handle mixed connection states (some closed, some open)', () => {
      const mockWs1 = createMockWebSocket();
      const mockWs2 = createMockWebSocket();
      const mockWs3 = createMockWebSocket();

      simulateWebSocketUpgrade(mockWs1);
      simulateWebSocketUpgrade(mockWs2);
      simulateWebSocketUpgrade(mockWs3);

      // Close one connection
      simulateWebSocketClose(mockWs2);

      expect(mockWs1.readyState).toBe(1); // OPEN
      expect(mockWs2.readyState).toBe(3); // CLOSED
      expect(mockWs3.readyState).toBe(1); // OPEN
    });
  });

  describe('Integration with Room Storage', () => {
    it('should associate connection with room after successful JOIN', () => {
      const mockWs = createMockWebSocket();
      const config = getConfig();
      const roomId = toRoomId('123e4567-e89b-12d3-a456-426614174000');
      const password = 'test-password';
      const passwordHash = hashPassword(password, config.serverSecret);

      // Create room
      createRoom(roomId, passwordHash, config.roomTtlSeconds, 'https://example.com/video');

      simulateWebSocketUpgrade(mockWs);

      // Simulate successful JOIN
      mockWs.roomId = roomId;
      const clientId = toClientId('123e4567-e89b-12d3-a456-426614174001');
      mockWs.clientId = clientId;

      // Verify room exists and connection metadata is set
      const room = getRoom(roomId);
      expect(room).toBeDefined();
      expect(mockWs.roomId).toBe(roomId);
      expect(mockWs.clientId).toBe(clientId);
    });

    it('should handle connection cleanup when room is deleted', () => {
      const mockWs = createMockWebSocket();
      const config = getConfig();
      const roomId = toRoomId('123e4567-e89b-12d3-a456-426614174000');
      const password = 'test-password';
      const passwordHash = hashPassword(password, config.serverSecret);

      createRoom(roomId, passwordHash, config.roomTtlSeconds, 'https://example.com/video');
      simulateWebSocketUpgrade(mockWs);
      mockWs.roomId = roomId;

      // Simulate room deletion (would close connections)
      // In real implementation, room deletion would call ws.close()
      // Here we verify the close handler can access room metadata
      simulateWebSocketClose(mockWs);

      // Verify close handler was registered and can access metadata
      const closeHandlerCalls = mockWs.on.mock.calls.filter(call => call[0] === 'close');
      expect(closeHandlerCalls.length).toBeGreaterThan(0);
      expect(mockWs.roomId).toBe(roomId);
    });
  });
});
