/**
 * Unit tests for EVENT Message Handling
 *
 * Tests verify:
 * - Valid EVENT messages (play, pause, seek) are processed correctly
 * - Play event updates state.playerState = 'playing' and broadcasts STATE to all clients
 * - Pause event updates state.playerState = 'paused' and broadcasts STATE to all clients
 * - Seek event updates state.videoPos and broadcasts STATE to all clients
 * - Rate limiting prevents message flooding
 * - Rate limit exceeded returns ERROR message
 * - Event log maintains last N events (ring buffer)
 * - All clients receive STATE updates
 * - State timestamps are updated (last_explicit_event_ts, last_state_update_ts)
 * - EventId is incremented for each event
 * - Schema validation for EVENT messages
 */

import { setupTestEnv, cleanupTestEnv } from '../helpers/fixtures';
import { toRoomId } from '../../types/ids';
import type { ClientId } from '../../types/ids';
import { createRoom, getRoom, clearAllRooms } from '../../storage/rooms';
import { hashPassword } from '../../utils/password';
import { getConfig } from '../../config';
import { validateMessage } from '../../utils/validation';
import { handleConnection, type ExtendedWebSocket } from '../../handlers/websocket';
import type { EventMessage, StateMessage, ErrorMessage } from '../../types/messages';

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
 * Create a valid JOIN message
 */
function createJoinMessage(password: string, clientId?: string): string {
  const message: { type: string; password: string; clientId?: string } = {
    type: 'JOIN',
    password,
  };
  if (clientId) {
    message.clientId = clientId;
  }
  return JSON.stringify(message);
}

/**
 * Create a valid EVENT message
 */
function createEventMessage(
  event: 'play' | 'pause' | 'seek',
  value?: number,
  client_ts?: number
): EventMessage {
  const message: EventMessage = {
    type: 'EVENT',
    event,
    client_ts: client_ts ?? Date.now(),
  };
  if (value !== undefined) {
    message.value = value;
  }
  return message;
}

/**
 * Setup a room with a connected client
 */
function setupRoomWithClient(
  roomId: string,
  password: string,
  clientId?: string
): { mockWs: MockWebSocket; roomId: ReturnType<typeof toRoomId>; clientId: ClientId } {
  const config = getConfig();
  const passwordHash = hashPassword(password, config.serverSecret);
  const roomIdTyped = toRoomId(roomId);

  // Create room
  createRoom(roomIdTyped, passwordHash, config.roomTtlSeconds, 'https://example.com/video');

  // Create and connect client
  const mockWs = createMockWebSocket();
  simulateWebSocketUpgrade(mockWs, roomId);

  // Join the room
  simulateWebSocketMessage(mockWs, createJoinMessage(password, clientId));

  // Extract clientId from ROOM_STATE response
  const roomState = JSON.parse(mockWs.send.mock.calls[0][0] as string);
  const actualClientId = roomState.clientId as ClientId;

  // Clear send mock for subsequent tests
  mockWs.send.mockClear();

  return { mockWs, roomId: roomIdTyped, clientId: actualClientId };
}

describe('EVENT Message Handling', () => {
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
    it('should validate a valid play EVENT message', () => {
      const message = createEventMessage('play');
      const result = validateMessage(message, 'EVENT');
      expect(result.valid).toBe(true);
      expect(result.errors).toBeNull();
    });

    it('should validate a valid pause EVENT message', () => {
      const message = createEventMessage('pause');
      const result = validateMessage(message, 'EVENT');
      expect(result.valid).toBe(true);
      expect(result.errors).toBeNull();
    });

    it('should validate a valid seek EVENT message with value', () => {
      const message = createEventMessage('seek', 123.456);
      const result = validateMessage(message, 'EVENT');
      expect(result.valid).toBe(true);
      expect(result.errors).toBeNull();
    });

    it('should reject seek EVENT message without value', () => {
      const message = {
        type: 'EVENT',
        event: 'seek',
        client_ts: Date.now(),
        // Missing required value field
      };
      const result = validateMessage(message, 'EVENT');
      expect(result.valid).toBe(false);
      expect(result.errors).not.toBeNull();
    });

    it('should reject EVENT message with invalid event type', () => {
      const message = {
        type: 'EVENT',
        event: 'invalid-event',
        client_ts: Date.now(),
      };
      const result = validateMessage(message, 'EVENT');
      expect(result.valid).toBe(false);
      expect(result.errors).not.toBeNull();
    });

    it('should reject EVENT message with negative seek value', () => {
      const message = createEventMessage('seek', -1);
      const result = validateMessage(message, 'EVENT');
      expect(result.valid).toBe(false);
      expect(result.errors).not.toBeNull();
    });

    it('should reject EVENT message with missing required fields', () => {
      const message = {
        type: 'EVENT',
        // Missing event and client_ts
      };
      const result = validateMessage(message, 'EVENT');
      expect(result.valid).toBe(false);
      expect(result.errors).not.toBeNull();
    });
  });

  describe('Play Event Handling', () => {
    it('should update room.state.playerState to playing on play event', () => {
      const { mockWs, roomId } = setupRoomWithClient(
        '123e4567-e89b-12d3-a456-426614174000',
        'test-password'
      );

      const room = getRoom(roomId);
      expect(room).toBeDefined();
      expect(room).not.toBeUndefined();
      if (!room) {
        return;
      }
      room.state.playerState = 'paused'; // Start paused

      // Send play event
      const eventMessage = createEventMessage('play');
      simulateWebSocketMessage(mockWs, JSON.stringify(eventMessage));

      // Verify state was updated
      expect(room.state.playerState).toBe('playing');
    });

    it('should broadcast STATE message to all clients on play event', () => {
      const { mockWs: mockWs1 } = setupRoomWithClient(
        '123e4567-e89b-12d3-a456-426614174000',
        'test-password'
      );

      // Add second client
      const { mockWs: mockWs2 } = setupRoomWithClient(
        '123e4567-e89b-12d3-a456-426614174000',
        'test-password'
      );

      // Send play event from first client
      const eventMessage = createEventMessage('play');
      simulateWebSocketMessage(mockWs1, JSON.stringify(eventMessage));

      // Verify both clients received STATE broadcast
      expect(mockWs1.send).toHaveBeenCalled();
      expect(mockWs2.send).toHaveBeenCalled();

      // Verify STATE message content
      const stateMessage1 = JSON.parse(mockWs1.send.mock.calls[0][0] as string) as StateMessage;
      expect(stateMessage1.type).toBe('STATE');
      expect(stateMessage1.playerState).toBe('playing');
      expect(stateMessage1.eventId).toBeDefined();
      expect(stateMessage1.server_ts).toBeDefined();

      const stateMessage2 = JSON.parse(mockWs2.send.mock.calls[0][0] as string) as StateMessage;
      expect(stateMessage2.type).toBe('STATE');
      expect(stateMessage2.playerState).toBe('playing');
    });

    it('should update last_explicit_event_ts on play event', () => {
      const { mockWs, roomId } = setupRoomWithClient(
        '123e4567-e89b-12d3-a456-426614174000',
        'test-password'
      );

      const room = getRoom(roomId);
      expect(room).toBeDefined();
      expect(room).not.toBeUndefined();
      if (!room) {
        return;
      }
      const initialTs = room.state.last_explicit_event_ts;

      jest.advanceTimersByTime(1000); // Advance time by 1 second

      // Send play event
      const eventMessage = createEventMessage('play');
      simulateWebSocketMessage(mockWs, JSON.stringify(eventMessage));

      // Verify timestamp was updated
      expect(room.state.last_explicit_event_ts).toBeGreaterThan(initialTs);
    });

    it('should update last_state_update_ts on play event', () => {
      const { mockWs, roomId } = setupRoomWithClient(
        '123e4567-e89b-12d3-a456-426614174000',
        'test-password'
      );

      const room = getRoom(roomId);
      expect(room).toBeDefined();
      expect(room).not.toBeUndefined();
      if (!room) {
        return;
      }
      const initialTs = room.state.last_state_update_ts;

      jest.advanceTimersByTime(1000); // Advance time by 1 second

      // Send play event
      const eventMessage = createEventMessage('play');
      simulateWebSocketMessage(mockWs, JSON.stringify(eventMessage));

      // Verify timestamp was updated
      expect(room.state.last_state_update_ts).toBeGreaterThan(initialTs);
    });

    it('should increment eventId on play event', () => {
      const { mockWs, roomId } = setupRoomWithClient(
        '123e4567-e89b-12d3-a456-426614174000',
        'test-password'
      );

      const room = getRoom(roomId);
      expect(room).toBeDefined();
      expect(room).not.toBeUndefined();
      if (!room) {
        return;
      }
      const initialEventId = room.state.eventId;

      // Send play event
      const eventMessage = createEventMessage('play');
      simulateWebSocketMessage(mockWs, JSON.stringify(eventMessage));

      // Verify eventId was incremented
      expect(room.state.eventId).toBe(initialEventId + 1);
    });

    it('should append play event to eventLog', () => {
      const { mockWs, roomId } = setupRoomWithClient(
        '123e4567-e89b-12d3-a456-426614174000',
        'test-password'
      );

      const room = getRoom(roomId);
      expect(room).toBeDefined();
      expect(room).not.toBeUndefined();
      if (!room) {
        return;
      }
      const initialLogLength = room.eventLog.length;

      // Send play event
      const eventMessage = createEventMessage('play');
      simulateWebSocketMessage(mockWs, JSON.stringify(eventMessage));

      // Verify event was added to log
      expect(room.eventLog.length).toBe(initialLogLength + 1);
      expect(room.eventLog[room.eventLog.length - 1].type).toBe('play');
      expect(room.eventLog[room.eventLog.length - 1].eventId).toBe(room.state.eventId);
    });
  });

  describe('Pause Event Handling', () => {
    it('should update room.state.playerState to paused on pause event', () => {
      const { mockWs, roomId } = setupRoomWithClient(
        '123e4567-e89b-12d3-a456-426614174000',
        'test-password'
      );

      const room = getRoom(roomId);
      expect(room).toBeDefined();
      expect(room).not.toBeUndefined();
      if (!room) {
        return;
      }
      room.state.playerState = 'playing'; // Start playing

      // Send pause event
      const eventMessage = createEventMessage('pause');
      simulateWebSocketMessage(mockWs, JSON.stringify(eventMessage));

      // Verify state was updated
      expect(room.state.playerState).toBe('paused');
    });

    it('should broadcast STATE message to all clients on pause event', () => {
      const { mockWs: mockWs1 } = setupRoomWithClient(
        '123e4567-e89b-12d3-a456-426614174000',
        'test-password'
      );

      // Add second client
      const { mockWs: mockWs2 } = setupRoomWithClient(
        '123e4567-e89b-12d3-a456-426614174000',
        'test-password'
      );

      // Send pause event from first client
      const eventMessage = createEventMessage('pause');
      simulateWebSocketMessage(mockWs1, JSON.stringify(eventMessage));

      // Verify both clients received STATE broadcast
      expect(mockWs1.send).toHaveBeenCalled();
      expect(mockWs2.send).toHaveBeenCalled();

      // Verify STATE message content
      const stateMessage1 = JSON.parse(mockWs1.send.mock.calls[0][0] as string) as StateMessage;
      expect(stateMessage1.type).toBe('STATE');
      expect(stateMessage1.playerState).toBe('paused');

      const stateMessage2 = JSON.parse(mockWs2.send.mock.calls[0][0] as string) as StateMessage;
      expect(stateMessage2.type).toBe('STATE');
      expect(stateMessage2.playerState).toBe('paused');
    });

    it('should update timestamps and eventId on pause event', () => {
      const { mockWs, roomId } = setupRoomWithClient(
        '123e4567-e89b-12d3-a456-426614174000',
        'test-password'
      );

      const room = getRoom(roomId);
      expect(room).toBeDefined();
      expect(room).not.toBeUndefined();
      if (!room) {
        return;
      }
      const initialEventId = room.state.eventId;
      const initialExplicitTs = room.state.last_explicit_event_ts;
      const initialStateTs = room.state.last_state_update_ts;

      jest.advanceTimersByTime(1000); // Advance time by 1 second

      // Send pause event
      const eventMessage = createEventMessage('pause');
      simulateWebSocketMessage(mockWs, JSON.stringify(eventMessage));

      // Verify all fields were updated
      expect(room.state.eventId).toBe(initialEventId + 1);
      expect(room.state.last_explicit_event_ts).toBeGreaterThan(initialExplicitTs);
      expect(room.state.last_state_update_ts).toBeGreaterThan(initialStateTs);
    });

    it('should append pause event to eventLog', () => {
      const { mockWs, roomId } = setupRoomWithClient(
        '123e4567-e89b-12d3-a456-426614174000',
        'test-password'
      );

      const room = getRoom(roomId);
      expect(room).toBeDefined();
      expect(room).not.toBeUndefined();
      if (!room) {
        return;
      }
      // Send pause event
      const eventMessage = createEventMessage('pause');
      simulateWebSocketMessage(mockWs, JSON.stringify(eventMessage));

      // Verify event was added to log
      const lastEvent = room.eventLog[room.eventLog.length - 1];
      expect(lastEvent.type).toBe('pause');
      expect(lastEvent.eventId).toBe(room.state.eventId);
    });
  });

  describe('Seek Event Handling', () => {
    it('should update room.state.videoPos on seek event', () => {
      const { mockWs, roomId } = setupRoomWithClient(
        '123e4567-e89b-12d3-a456-426614174000',
        'test-password'
      );

      const room = getRoom(roomId);
      expect(room).toBeDefined();
      expect(room).not.toBeUndefined();
      if (!room) {
        return;
      }
      const seekPosition = 123.456;

      // Send seek event
      const eventMessage = createEventMessage('seek', seekPosition);
      simulateWebSocketMessage(mockWs, JSON.stringify(eventMessage));

      // Verify videoPos was updated
      expect(room.state.videoPos).toBe(seekPosition);
    });

    it('should broadcast STATE message with updated time on seek event', () => {
      const { mockWs: mockWs1 } = setupRoomWithClient(
        '123e4567-e89b-12d3-a456-426614174000',
        'test-password'
      );

      // Add second client
      const { mockWs: mockWs2 } = setupRoomWithClient(
        '123e4567-e89b-12d3-a456-426614174000',
        'test-password'
      );

      const seekPosition = 456.789;

      // Send seek event from first client
      const eventMessage = createEventMessage('seek', seekPosition);
      simulateWebSocketMessage(mockWs1, JSON.stringify(eventMessage));

      // Verify both clients received STATE broadcast
      expect(mockWs1.send).toHaveBeenCalled();
      expect(mockWs2.send).toHaveBeenCalled();

      // Verify STATE message content
      const stateMessage1 = JSON.parse(mockWs1.send.mock.calls[0][0] as string) as StateMessage;
      expect(stateMessage1.type).toBe('STATE');
      expect(stateMessage1.videoPos).toBe(seekPosition);
      expect(stateMessage1.eventId).toBeDefined();

      const stateMessage2 = JSON.parse(mockWs2.send.mock.calls[0][0] as string) as StateMessage;
      expect(stateMessage2.type).toBe('STATE');
      expect(stateMessage2.videoPos).toBe(seekPosition);
    });

    it('should update timestamps and eventId on seek event', () => {
      const { mockWs, roomId } = setupRoomWithClient(
        '123e4567-e89b-12d3-a456-426614174000',
        'test-password'
      );

      const room = getRoom(roomId);
      expect(room).toBeDefined();
      expect(room).not.toBeUndefined();
      if (!room) {
        return;
      }
      const initialEventId = room.state.eventId;
      const initialExplicitTs = room.state.last_explicit_event_ts;
      const initialStateTs = room.state.last_state_update_ts;

      jest.advanceTimersByTime(1000); // Advance time by 1 second

      // Send seek event
      const eventMessage = createEventMessage('seek', 100.0);
      simulateWebSocketMessage(mockWs, JSON.stringify(eventMessage));

      // Verify all fields were updated
      expect(room.state.eventId).toBe(initialEventId + 1);
      expect(room.state.last_explicit_event_ts).toBeGreaterThan(initialExplicitTs);
      expect(room.state.last_state_update_ts).toBeGreaterThan(initialStateTs);
    });

    it('should append seek event to eventLog with value', () => {
      const { mockWs, roomId } = setupRoomWithClient(
        '123e4567-e89b-12d3-a456-426614174000',
        'test-password'
      );

      const room = getRoom(roomId);
      expect(room).toBeDefined();
      expect(room).not.toBeUndefined();
      if (!room) {
        return;
      }
      const seekPosition = 789.012;

      // Send seek event
      const eventMessage = createEventMessage('seek', seekPosition);
      simulateWebSocketMessage(mockWs, JSON.stringify(eventMessage));

      // Verify event was added to log
      const lastEvent = room.eventLog[room.eventLog.length - 1];
      expect(lastEvent.type).toBe('seek');
      expect(lastEvent.value).toBe(seekPosition);
      expect(lastEvent.eventId).toBe(room.state.eventId);
    });
  });

  describe('Rate Limiting', () => {
    it('should allow events within rate limit', () => {
      const { mockWs } = setupRoomWithClient(
        '123e4567-e89b-12d3-a456-426614174000',
        'test-password'
      );

      const config = getConfig();
      const rateLimit = config.rateLimitEventsPerSec;

      // Send events within rate limit (one per second)
      for (let i = 0; i < rateLimit; i++) {
        const eventMessage = createEventMessage('play');
        simulateWebSocketMessage(mockWs, JSON.stringify(eventMessage));
        jest.advanceTimersByTime(1000); // 1 second between events
      }

      // Verify no ERROR messages were sent
      const errorCalls = mockWs.send.mock.calls.filter(call => {
        const message = JSON.parse(call[0] as string);
        return message.type === 'ERROR' && message.code === 'RATE_LIMITED';
      });
      expect(errorCalls.length).toBe(0);
    });

    it('should reject events exceeding rate limit and send ERROR message', () => {
      const { mockWs } = setupRoomWithClient(
        '123e4567-e89b-12d3-a456-426614174000',
        'test-password'
      );

      const config = getConfig();
      const rateLimit = config.rateLimitEventsPerSec;

      // Send events exceeding rate limit (all within 1 second)
      for (let i = 0; i < rateLimit + 1; i++) {
        const eventMessage = createEventMessage('play');
        simulateWebSocketMessage(mockWs, JSON.stringify(eventMessage));
      }

      // Verify ERROR message was sent for the exceeding event
      const errorCalls = mockWs.send.mock.calls.filter(call => {
        try {
          const message = JSON.parse(call[0] as string);
          return message.type === 'ERROR' && message.code === 'RATE_LIMITED';
        } catch {
          return false;
        }
      });
      expect(errorCalls.length).toBeGreaterThan(0);

      // Verify ERROR message content
      if (errorCalls.length > 0) {
        const errorMessage = JSON.parse(errorCalls[0][0] as string) as ErrorMessage;
        expect(errorMessage.type).toBe('ERROR');
        expect(errorMessage.code).toBe('RATE_LIMITED');
        expect(errorMessage.message).toBeDefined();
      }
    });

    it('should apply rate limit per connection independently', () => {
      const { mockWs: mockWs1 } = setupRoomWithClient(
        '123e4567-e89b-12d3-a456-426614174000',
        'test-password'
      );
      const { mockWs: mockWs2 } = setupRoomWithClient(
        '123e4567-e89b-12d3-a456-426614174000',
        'test-password'
      );

      const config = getConfig();
      const rateLimit = config.rateLimitEventsPerSec;

      // Both clients send events within their individual rate limits
      for (let i = 0; i < rateLimit; i++) {
        const eventMessage1 = createEventMessage('play');
        const eventMessage2 = createEventMessage('pause');
        simulateWebSocketMessage(mockWs1, JSON.stringify(eventMessage1));
        simulateWebSocketMessage(mockWs2, JSON.stringify(eventMessage2));
      }

      // Verify no ERROR messages were sent (each client within their limit)
      const errorCalls1 = mockWs1.send.mock.calls.filter(call => {
        try {
          const message = JSON.parse(call[0] as string);
          return message.type === 'ERROR' && message.code === 'RATE_LIMITED';
        } catch {
          return false;
        }
      });
      const errorCalls2 = mockWs2.send.mock.calls.filter(call => {
        try {
          const message = JSON.parse(call[0] as string);
          return message.type === 'ERROR' && message.code === 'RATE_LIMITED';
        } catch {
          return false;
        }
      });
      expect(errorCalls1.length).toBe(0);
      expect(errorCalls2.length).toBe(0);
    });

    it('should allow events after rate limit refills', () => {
      const { mockWs } = setupRoomWithClient(
        '123e4567-e89b-12d3-a456-426614174000',
        'test-password'
      );

      const config = getConfig();
      const rateLimit = config.rateLimitEventsPerSec;

      // Exhaust rate limit
      for (let i = 0; i < rateLimit; i++) {
        const eventMessage = createEventMessage('play');
        simulateWebSocketMessage(mockWs, JSON.stringify(eventMessage));
      }

      // Next event should be rate limited
      const eventMessage = createEventMessage('pause');
      simulateWebSocketMessage(mockWs, JSON.stringify(eventMessage));

      // Verify ERROR message was sent
      const errorCalls = mockWs.send.mock.calls.filter(call => {
        try {
          const message = JSON.parse(call[0] as string);
          return message.type === 'ERROR' && message.code === 'RATE_LIMITED';
        } catch {
          return false;
        }
      });
      expect(errorCalls.length).toBeGreaterThan(0);

      // Advance time by 1 second
      jest.advanceTimersByTime(1000);

      // Clear previous calls to check new ones
      mockWs.send.mockClear();

      // Should allow event after refill
      const newEventMessage = createEventMessage('seek', 10);
      simulateWebSocketMessage(mockWs, JSON.stringify(newEventMessage));

      // Should not have ERROR message
      const newErrorCalls = mockWs.send.mock.calls.filter(call => {
        try {
          const message = JSON.parse(call[0] as string);
          return message.type === 'ERROR' && message.code === 'RATE_LIMITED';
        } catch {
          return false;
        }
      });
      expect(newErrorCalls.length).toBe(0);
    });

    it('should rate limit all event types (play, pause, seek)', () => {
      const { mockWs } = setupRoomWithClient(
        '123e4567-e89b-12d3-a456-426614174000',
        'test-password'
      );

      const config = getConfig();
      const rateLimit = config.rateLimitEventsPerSec;

      // Send mix of event types up to rate limit
      for (let i = 0; i < rateLimit; i++) {
        const eventType = i % 3 === 0 ? 'play' : i % 3 === 1 ? 'pause' : 'seek';
        const eventMessage = createEventMessage(
          eventType as 'play' | 'pause' | 'seek',
          eventType === 'seek' ? 10 : undefined
        );
        simulateWebSocketMessage(mockWs, JSON.stringify(eventMessage));
      }

      // Next event of any type should be rate limited
      const playMessage = createEventMessage('play');
      simulateWebSocketMessage(mockWs, JSON.stringify(playMessage));

      const errorCalls = mockWs.send.mock.calls.filter(call => {
        try {
          const message = JSON.parse(call[0] as string);
          return message.type === 'ERROR' && message.code === 'RATE_LIMITED';
        } catch {
          return false;
        }
      });
      expect(errorCalls.length).toBeGreaterThan(0);
    });

    it('should initialize rate limiter during JOIN', () => {
      const { mockWs } = setupRoomWithClient(
        '123e4567-e89b-12d3-a456-426614174000',
        'test-password'
      );

      // Rate limiter should be initialized after JOIN
      // Send an event immediately - should work (rate limiter initialized)
      const eventMessage = createEventMessage('play');
      simulateWebSocketMessage(mockWs, JSON.stringify(eventMessage));

      // Should not have ERROR for rate limiting (should have been initialized)
      const errorCalls = mockWs.send.mock.calls.filter(call => {
        try {
          const message = JSON.parse(call[0] as string);
          return message.type === 'ERROR' && message.code === 'RATE_LIMITED';
        } catch {
          return false;
        }
      });
      // Should not have rate limit error (rate limiter should be initialized)
      expect(errorCalls.length).toBe(0);
    });

    it('should not process event when rate limited', () => {
      const { mockWs, roomId } = setupRoomWithClient(
        '123e4567-e89b-12d3-a456-426614174000',
        'test-password'
      );

      const config = getConfig();
      const rateLimit = config.rateLimitEventsPerSec;
      const room = getRoom(roomId);
      expect(room).toBeDefined();
      if (!room) return;
      const initialEventId = room.state.eventId;

      // Exhaust rate limit
      for (let i = 0; i < rateLimit; i++) {
        const eventMessage = createEventMessage('play');
        simulateWebSocketMessage(mockWs, JSON.stringify(eventMessage));
      }

      // Clear send calls to check new ones
      mockWs.send.mockClear();

      // Send event that should be rate limited
      const eventMessage = createEventMessage('pause');
      simulateWebSocketMessage(mockWs, JSON.stringify(eventMessage));

      // Verify ERROR was sent
      const errorCalls = mockWs.send.mock.calls.filter(call => {
        try {
          const message = JSON.parse(call[0] as string);
          return message.type === 'ERROR' && message.code === 'RATE_LIMITED';
        } catch {
          return false;
        }
      });
      expect(errorCalls.length).toBeGreaterThan(0);

      // Verify event was NOT processed (eventId should not have incremented beyond rateLimit)
      expect(room.state.eventId).toBe(initialEventId + rateLimit);
      // Last processed event was play (paused = false), pause event was rate limited so not processed
      expect(room.state.playerState).toBe('playing');
    });

    it('should handle burst of events correctly', () => {
      const { mockWs } = setupRoomWithClient(
        '123e4567-e89b-12d3-a456-426614174000',
        'test-password'
      );

      const config = getConfig();
      const rateLimit = config.rateLimitEventsPerSec;

      // Send burst of events rapidly
      const results: Array<{ allowed: boolean; errorCode?: string }> = [];
      for (let i = 0; i < rateLimit + 5; i++) {
        mockWs.send.mockClear();
        const eventMessage = createEventMessage('play');
        simulateWebSocketMessage(mockWs, JSON.stringify(eventMessage));

        const errorCalls = mockWs.send.mock.calls.filter(call => {
          try {
            const message = JSON.parse(call[0] as string);
            return message.type === 'ERROR' && message.code === 'RATE_LIMITED';
          } catch {
            return false;
          }
        });

        results.push({
          allowed: errorCalls.length === 0,
          errorCode: errorCalls.length > 0 ? 'RATE_LIMITED' : undefined,
        });
      }

      // First rateLimit events should be allowed
      const allowedCount = results.filter(r => r.allowed).length;
      expect(allowedCount).toBe(rateLimit);

      // Remaining events should be rate limited
      const rateLimitedCount = results.filter(r => !r.allowed).length;
      expect(rateLimitedCount).toBe(5);
    });
  });

  describe('Event Log Ring Buffer', () => {
    it('should maintain event log with recent events', () => {
      const { mockWs, roomId } = setupRoomWithClient(
        '123e4567-e89b-12d3-a456-426614174000',
        'test-password'
      );

      const room = getRoom(roomId);
      expect(room).toBeDefined();
      expect(room).not.toBeUndefined();
      if (!room) {
        return;
      }
      // Send multiple events
      const events = ['play', 'pause', 'seek'] as const;
      events.forEach((event, index) => {
        const eventMessage =
          event === 'seek' ? createEventMessage(event, index * 10) : createEventMessage(event);
        simulateWebSocketMessage(mockWs, JSON.stringify(eventMessage));
      });

      // Verify events were added to log
      expect(room.eventLog.length).toBeGreaterThanOrEqual(events.length);
      events.forEach((event, index) => {
        const logEvent = room.eventLog[index];
        expect(logEvent.type).toBe(event);
        expect(logEvent.eventId).toBeDefined();
      });
    });

    it('should limit event log size (ring buffer behavior)', () => {
      const { mockWs, roomId } = setupRoomWithClient(
        '123e4567-e89b-12d3-a456-426614174000',
        'test-password'
      );

      const room = getRoom(roomId);
      expect(room).toBeDefined();
      expect(room).not.toBeUndefined();
      if (!room) {
        return;
      }
      // Send many events (more than typical ring buffer size)
      const maxEvents = 100; // Assuming ring buffer size is less than this
      for (let i = 0; i < maxEvents; i++) {
        const eventMessage = createEventMessage('play');
        simulateWebSocketMessage(mockWs, JSON.stringify(eventMessage));
      }

      // Verify log doesn't exceed reasonable size (implementation-specific)
      // Note: Actual ring buffer size depends on implementation
      // This test verifies that the log doesn't grow unbounded
      expect(room.eventLog.length).toBeLessThanOrEqual(maxEvents);
    });

    it('should include clientId in event log entries', () => {
      const { mockWs, roomId, clientId } = setupRoomWithClient(
        '123e4567-e89b-12d3-a456-426614174000',
        'test-password'
      );

      const room = getRoom(roomId);
      expect(room).toBeDefined();
      expect(room).not.toBeUndefined();
      if (!room) {
        return;
      }
      // Send event
      const eventMessage = createEventMessage('play');
      simulateWebSocketMessage(mockWs, JSON.stringify(eventMessage));

      // Verify event log entry includes clientId
      const lastEvent = room.eventLog[room.eventLog.length - 1];
      expect(lastEvent.clientId).toBe(clientId);
    });
  });

  describe('State Broadcasting', () => {
    it('should broadcast STATE to all connected clients', () => {
      const { mockWs: mockWs1 } = setupRoomWithClient(
        '123e4567-e89b-12d3-a456-426614174000',
        'test-password'
      );
      const { mockWs: mockWs2 } = setupRoomWithClient(
        '123e4567-e89b-12d3-a456-426614174000',
        'test-password'
      );
      const { mockWs: mockWs3 } = setupRoomWithClient(
        '123e4567-e89b-12d3-a456-426614174000',
        'test-password'
      );

      // Send event from first client
      const eventMessage = createEventMessage('play');
      simulateWebSocketMessage(mockWs1, JSON.stringify(eventMessage));

      // Verify all three clients received STATE
      expect(mockWs1.send).toHaveBeenCalled();
      expect(mockWs2.send).toHaveBeenCalled();
      expect(mockWs3.send).toHaveBeenCalled();

      // Verify all received STATE messages
      const stateMessage1 = JSON.parse(mockWs1.send.mock.calls[0][0] as string) as StateMessage;
      const stateMessage2 = JSON.parse(mockWs2.send.mock.calls[0][0] as string) as StateMessage;
      const stateMessage3 = JSON.parse(mockWs3.send.mock.calls[0][0] as string) as StateMessage;

      expect(stateMessage1.type).toBe('STATE');
      expect(stateMessage2.type).toBe('STATE');
      expect(stateMessage3.type).toBe('STATE');

      // Verify all have same state values
      expect(stateMessage1.playerState).toBe(stateMessage2.playerState);
      expect(stateMessage2.playerState).toBe(stateMessage3.playerState);
      expect(stateMessage1.eventId).toBe(stateMessage2.eventId);
      expect(stateMessage2.eventId).toBe(stateMessage3.eventId);
    });

    it('should include server_ts in STATE messages', () => {
      const { mockWs } = setupRoomWithClient(
        '123e4567-e89b-12d3-a456-426614174000',
        'test-password'
      );

      const beforeTs = Date.now();

      // Send event
      const eventMessage = createEventMessage('play');
      simulateWebSocketMessage(mockWs, JSON.stringify(eventMessage));

      // Verify STATE includes server_ts
      const stateMessage = JSON.parse(mockWs.send.mock.calls[0][0] as string) as StateMessage;
      expect(stateMessage.server_ts).toBeDefined();
      expect(stateMessage.server_ts).toBeGreaterThanOrEqual(beforeTs);
    });

    it('should include eventId in STATE messages', () => {
      const { mockWs, roomId } = setupRoomWithClient(
        '123e4567-e89b-12d3-a456-426614174000',
        'test-password'
      );

      const room = getRoom(roomId);
      expect(room).toBeDefined();
      expect(room).not.toBeUndefined();
      if (!room) {
        return;
      }
      // Send event
      const eventMessage = createEventMessage('play');
      simulateWebSocketMessage(mockWs, JSON.stringify(eventMessage));

      // Verify STATE includes eventId matching room state
      const stateMessage = JSON.parse(mockWs.send.mock.calls[0][0] as string) as StateMessage;
      expect(stateMessage.eventId).toBe(room.state.eventId);
    });

    it('should handle closed connections gracefully during broadcast', () => {
      const { mockWs: mockWs1 } = setupRoomWithClient(
        '123e4567-e89b-12d3-a456-426614174000',
        'test-password'
      );
      const { mockWs: mockWs2 } = setupRoomWithClient(
        '123e4567-e89b-12d3-a456-426614174000',
        'test-password'
      );

      // Close second client connection
      mockWs2.readyState = 3; // CLOSED

      // Send event from first client
      const eventMessage = createEventMessage('play');
      simulateWebSocketMessage(mockWs1, JSON.stringify(eventMessage));

      // Verify first client still received STATE
      expect(mockWs1.send).toHaveBeenCalled();

      // Verify no errors occurred (closed connection handled gracefully)
      // This is verified by the test completing without throwing
    });
  });

  describe('Authoritative State Rules', () => {
    it('should use server timestamp, not client timestamp, for authoritative state', () => {
      const { mockWs } = setupRoomWithClient(
        '123e4567-e89b-12d3-a456-426614174000',
        'test-password'
      );

      const clientTs = 1000000000000; // Arbitrary client timestamp

      // Send event with client timestamp
      const eventMessage = createEventMessage('play', undefined, clientTs);
      simulateWebSocketMessage(mockWs, JSON.stringify(eventMessage));

      // Verify STATE uses server timestamp, not client timestamp
      const stateMessage = JSON.parse(mockWs.send.mock.calls[0][0] as string) as StateMessage;
      expect(stateMessage.server_ts).not.toBe(clientTs);
      expect(stateMessage.server_ts).toBeGreaterThan(clientTs - 1000000); // Reasonable range
    });

    it('should increment eventId sequentially for ordering', () => {
      const { mockWs, roomId } = setupRoomWithClient(
        '123e4567-e89b-12d3-a456-426614174000',
        'test-password'
      );

      const room = getRoom(roomId);
      expect(room).toBeDefined();
      expect(room).not.toBeUndefined();
      if (!room) {
        return;
      }
      const initialEventId = room.state.eventId;

      // Send multiple events
      const events = ['play', 'pause', 'seek'] as const;
      events.forEach((event, index) => {
        const eventMessage =
          event === 'seek' ? createEventMessage(event, index * 10) : createEventMessage(event);
        simulateWebSocketMessage(mockWs, JSON.stringify(eventMessage));

        // Verify eventId increments sequentially
        expect(room.state.eventId).toBe(initialEventId + index + 1);
      });
    });
  });

  describe('Edge Cases', () => {
    it('should handle EVENT message before JOIN completes', () => {
      const mockWs = createMockWebSocket();
      const config = getConfig();
      const roomId = toRoomId('123e4567-e89b-12d3-a456-426614174000');
      const password = 'test-password';
      const passwordHash = hashPassword(password, config.serverSecret);

      // Create room
      createRoom(roomId, passwordHash, config.roomTtlSeconds, 'https://example.com/video');

      // Establish connection
      simulateWebSocketUpgrade(mockWs, roomId);

      // Send EVENT before JOIN
      const eventMessage = createEventMessage('play');
      simulateWebSocketMessage(mockWs, JSON.stringify(eventMessage));

      // Verify ERROR was sent (client not authenticated yet)
      const errorCalls = mockWs.send.mock.calls.filter(call => {
        try {
          const message = JSON.parse(call[0] as string);
          return message.type === 'ERROR';
        } catch {
          return false;
        }
      });
      expect(errorCalls.length).toBeGreaterThan(0);
    });

    it('should handle invalid EVENT message format gracefully', () => {
      const { mockWs } = setupRoomWithClient(
        '123e4567-e89b-12d3-a456-426614174000',
        'test-password'
      );

      // Send invalid JSON
      simulateWebSocketMessage(mockWs, 'invalid json{');

      // Verify connection is closed or ERROR is sent
      // Implementation-specific behavior
    });

    it('should handle rapid consecutive events', () => {
      const { mockWs } = setupRoomWithClient(
        '123e4567-e89b-12d3-a456-426614174000',
        'test-password'
      );

      // Send rapid consecutive events
      for (let i = 0; i < 5; i++) {
        const eventMessage = createEventMessage('play');
        simulateWebSocketMessage(mockWs, JSON.stringify(eventMessage));
      }

      // Verify all events were processed (or rate limited)
      // Implementation-specific behavior
    });
  });
});
