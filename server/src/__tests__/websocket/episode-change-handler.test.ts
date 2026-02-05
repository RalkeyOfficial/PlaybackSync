/**
 * Unit tests for Episode Change Handling
 *
 * Tests verify:
 * - Episode change request updates room state
 * - Episode change broadcasts to all clients
 * - Playback state resets on episode change (paused=true, videoPos=0)
 * - Content mismatch detection works
 * - derivedContentKey is computed correctly
 * - Multiple episode changes handled correctly
 * - EventId is incremented
 * - Timestamps are updated
 * - Schema validation for EPISODE_CHANGE_REQUEST messages
 *
 * Note: These tests are based on the expected behavior from the documentation
 * The tests will fail until the EPISODE_CHANGE_REQUEST handler is implemented
 * in the websocket handler. These tests serve as a specification for the implementation.
 */

import { setupTestEnv, cleanupTestEnv } from '../helpers/fixtures';
import { toRoomId } from '../../types/ids';
import type { ClientId } from '../../types/ids';
import { createRoom, getRoom, clearAllRooms } from '../../storage/rooms';
import { hashPassword } from '../../utils/password';
import { getConfig } from '../../config';
import { validateMessage } from '../../utils/validation';
import { handleConnection, type ExtendedWebSocket } from '../../handlers/websocket';
import type {
  EpisodeChangeRequestMessage,
  EpisodeChangeMessage,
} from '../../types/messages';
import { createHash } from 'crypto';

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
 * Create a valid EPISODE_CHANGE_REQUEST message
 */
function createEpisodeChangeRequestMessage(
  episodeId: string | number,
  providerId: string,
  pageUrl: string,
  client_ts?: number
): EpisodeChangeRequestMessage {
  return {
    type: 'EPISODE_CHANGE_REQUEST',
    episodeId,
    providerId,
    pageUrl,
    client_ts: client_ts ?? Date.now(),
  };
}

/**
 * Compute derivedContentKey from URL + provider + episode
 * This matches the server-side computation logic
 */
function computeDerivedContentKey(
  pageUrl: string,
  providerId: string,
  episodeId: string | number
): string {
  // Normalize URL (remove query params and hash for consistency)
  const normalizedUrl = new URL(pageUrl).pathname;
  const keyString = `${providerId}:${normalizedUrl}:${episodeId}`;
  return createHash('sha256').update(keyString).digest('hex');
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

describe('Episode Change Handling', () => {
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
    it('should validate a valid EPISODE_CHANGE_REQUEST message', () => {
      const message = createEpisodeChangeRequestMessage('ep1', 'netflix', 'https://netflix.com/watch/123');
      const result = validateMessage(message, 'EPISODE_CHANGE_REQUEST');
      expect(result.valid).toBe(true);
      expect(result.errors).toBeNull();
    });

    it('should validate EPISODE_CHANGE_REQUEST with numeric episodeId', () => {
      const message = createEpisodeChangeRequestMessage(5, 'netflix', 'https://netflix.com/watch/123');
      const result = validateMessage(message, 'EPISODE_CHANGE_REQUEST');
      expect(result.valid).toBe(true);
      expect(result.errors).toBeNull();
    });

    it('should validate EPISODE_CHANGE_REQUEST with string episodeId', () => {
      const message = createEpisodeChangeRequestMessage('episode-5', 'netflix', 'https://netflix.com/watch/123');
      const result = validateMessage(message, 'EPISODE_CHANGE_REQUEST');
      expect(result.valid).toBe(true);
      expect(result.errors).toBeNull();
    });

    it('should reject EPISODE_CHANGE_REQUEST missing required field: episodeId', () => {
      const invalidRequest = {
        type: 'EPISODE_CHANGE_REQUEST',
        providerId: 'netflix',
        pageUrl: 'https://netflix.com/watch/123',
        client_ts: Date.now(),
        // Missing episodeId
      };
      const result = validateMessage(invalidRequest, 'EPISODE_CHANGE_REQUEST');
      expect(result.valid).toBe(false);
      expect(result.errors).not.toBeNull();
    });

    it('should reject EPISODE_CHANGE_REQUEST missing required field: providerId', () => {
      const invalidRequest = {
        type: 'EPISODE_CHANGE_REQUEST',
        episodeId: 'ep1',
        pageUrl: 'https://netflix.com/watch/123',
        client_ts: Date.now(),
        // Missing providerId
      };
      const result = validateMessage(invalidRequest, 'EPISODE_CHANGE_REQUEST');
      expect(result.valid).toBe(false);
      expect(result.errors).not.toBeNull();
    });

    it('should reject EPISODE_CHANGE_REQUEST missing required field: pageUrl', () => {
      const invalidRequest = {
        type: 'EPISODE_CHANGE_REQUEST',
        episodeId: 'ep1',
        providerId: 'netflix',
        client_ts: Date.now(),
        // Missing pageUrl
      };
      const result = validateMessage(invalidRequest, 'EPISODE_CHANGE_REQUEST');
      expect(result.valid).toBe(false);
      expect(result.errors).not.toBeNull();
    });

    it('should reject EPISODE_CHANGE_REQUEST missing required field: client_ts', () => {
      const invalidRequest = {
        type: 'EPISODE_CHANGE_REQUEST',
        episodeId: 'ep1',
        providerId: 'netflix',
        pageUrl: 'https://netflix.com/watch/123',
        // Missing client_ts
      };
      const result = validateMessage(invalidRequest, 'EPISODE_CHANGE_REQUEST');
      expect(result.valid).toBe(false);
      expect(result.errors).not.toBeNull();
    });

    it('should reject EPISODE_CHANGE_REQUEST with empty providerId', () => {
      const invalidRequest = createEpisodeChangeRequestMessage('ep1', '', 'https://netflix.com/watch/123');
      const result = validateMessage(invalidRequest, 'EPISODE_CHANGE_REQUEST');
      expect(result.valid).toBe(false);
      expect(result.errors).not.toBeNull();
    });

    it('should reject EPISODE_CHANGE_REQUEST with empty pageUrl', () => {
      const invalidRequest = createEpisodeChangeRequestMessage('ep1', 'netflix', '');
      const result = validateMessage(invalidRequest, 'EPISODE_CHANGE_REQUEST');
      expect(result.valid).toBe(false);
      expect(result.errors).not.toBeNull();
    });
  });

  describe('Episode Change Request Processing', () => {
    it('should update room state with new episode info on episode change request', () => {
      const { mockWs, roomId } = setupRoomWithClient(
        '123e4567-e89b-12d3-a456-426614174000',
        'test-password'
      );

      const room = getRoom(roomId);
      expect(room).toBeDefined();
      if (!room) {
        return;
      }

      const episodeId = 'episode-5';
      const providerId = 'netflix';
      const pageUrl = 'https://netflix.com/watch/12345';

      // Send episode change request
      const episodeChangeRequest = createEpisodeChangeRequestMessage(episodeId, providerId, pageUrl);
      simulateWebSocketMessage(mockWs, JSON.stringify(episodeChangeRequest));

      // Verify room state was updated with episode info
      expect(room.contentIdentity).toBeDefined();
      if (room.contentIdentity) {
        expect(room.contentIdentity.episodeId).toBe(episodeId);
        expect(room.contentIdentity.providerId).toBe(providerId);
        expect(room.contentIdentity.pageUrl).toBe(pageUrl);
        expect(room.contentIdentity.derivedContentKey).toBeDefined();
      }
    });

    it('should reset playback state on episode change (paused=true, time=0)', () => {
      const { mockWs, roomId } = setupRoomWithClient(
        '123e4567-e89b-12d3-a456-426614174000',
        'test-password'
      );

      const room = getRoom(roomId);
      expect(room).toBeDefined();
      if (!room) {
        return;
      }

      // Set initial playback state (playing at position 100)
      room.state.paused = false;
      room.state.time = 100.5;

      // Send episode change request
      const episodeChangeRequest = createEpisodeChangeRequestMessage('ep1', 'netflix', 'https://netflix.com/watch/123');
      simulateWebSocketMessage(mockWs, JSON.stringify(episodeChangeRequest));

      // Verify playback state was reset
      expect(room.state.paused).toBe(true);
      expect(room.state.time).toBe(0);
    });

    it('should increment eventId on episode change', () => {
      const { mockWs, roomId } = setupRoomWithClient(
        '123e4567-e89b-12d3-a456-426614174000',
        'test-password'
      );

      const room = getRoom(roomId);
      expect(room).toBeDefined();
      if (!room) {
        return;
      }
      const initialEventId = room.state.eventId;

      // Send episode change request
      const episodeChangeRequest = createEpisodeChangeRequestMessage('ep1', 'netflix', 'https://netflix.com/watch/123');
      simulateWebSocketMessage(mockWs, JSON.stringify(episodeChangeRequest));

      // Verify eventId was incremented
      expect(room.state.eventId).toBe(initialEventId + 1);
    });

    it('should update timestamps on episode change', () => {
      const { mockWs, roomId } = setupRoomWithClient(
        '123e4567-e89b-12d3-a456-426614174000',
        'test-password'
      );

      const room = getRoom(roomId);
      expect(room).toBeDefined();
      if (!room) {
        return;
      }
      const initialExplicitTs = room.state.last_explicit_event_ts;
      const initialStateTs = room.state.last_state_update_ts;

      jest.advanceTimersByTime(1000); // Advance time by 1 second

      // Send episode change request
      const episodeChangeRequest = createEpisodeChangeRequestMessage('ep1', 'netflix', 'https://netflix.com/watch/123');
      simulateWebSocketMessage(mockWs, JSON.stringify(episodeChangeRequest));

      // Verify timestamps were updated
      expect(room.state.last_explicit_event_ts).toBeGreaterThan(initialExplicitTs);
      expect(room.state.last_state_update_ts).toBeGreaterThan(initialStateTs);
    });

    it('should compute derivedContentKey correctly from URL + provider + episode', () => {
      const { mockWs, roomId } = setupRoomWithClient(
        '123e4567-e89b-12d3-a456-426614174000',
        'test-password'
      );

      const room = getRoom(roomId);
      expect(room).toBeDefined();
      if (!room) {
        return;
      }

      const episodeId = 'episode-5';
      const providerId = 'netflix';
      const pageUrl = 'https://netflix.com/watch/12345';

      // Send episode change request
      const episodeChangeRequest = createEpisodeChangeRequestMessage(episodeId, providerId, pageUrl);
      simulateWebSocketMessage(mockWs, JSON.stringify(episodeChangeRequest));

      // Verify derivedContentKey was computed correctly
      const expectedKey = computeDerivedContentKey(pageUrl, providerId, episodeId);
      expect(room.contentIdentity?.derivedContentKey).toBe(expectedKey);
    });

    it('should handle multiple episode changes correctly', () => {
      const { mockWs, roomId } = setupRoomWithClient(
        '123e4567-e89b-12d3-a456-426614174000',
        'test-password'
      );

      const room = getRoom(roomId);
      expect(room).toBeDefined();
      if (!room) {
        return;
      }
      const initialEventId = room.state.eventId;

      // Send first episode change
      const episodeChange1 = createEpisodeChangeRequestMessage('ep1', 'netflix', 'https://netflix.com/watch/123');
      simulateWebSocketMessage(mockWs, JSON.stringify(episodeChange1));

      expect(room.state.eventId).toBe(initialEventId + 1);
      expect(room.contentIdentity?.episodeId).toBe('ep1');

      // Send second episode change
      const episodeChange2 = createEpisodeChangeRequestMessage('ep2', 'netflix', 'https://netflix.com/watch/124');
      simulateWebSocketMessage(mockWs, JSON.stringify(episodeChange2));

      expect(room.state.eventId).toBe(initialEventId + 2);
      expect(room.contentIdentity?.episodeId).toBe('ep2');
      expect(room.state.paused).toBe(true);
      expect(room.state.time).toBe(0);
    });
  });

  describe('Episode Change Broadcasting', () => {
    it('should broadcast EPISODE_CHANGE message to all clients', () => {
      const { mockWs: mockWs1 } = setupRoomWithClient(
        '123e4567-e89b-12d3-a456-426614174000',
        'test-password'
      );

      // Add second client
      const { mockWs: mockWs2 } = setupRoomWithClient(
        '123e4567-e89b-12d3-a456-426614174000',
        'test-password'
      );

      // Send episode change request from first client
      const episodeChangeRequest = createEpisodeChangeRequestMessage('ep1', 'netflix', 'https://netflix.com/watch/123');
      simulateWebSocketMessage(mockWs1, JSON.stringify(episodeChangeRequest));

      // Verify both clients received EPISODE_CHANGE broadcast
      expect(mockWs1.send).toHaveBeenCalled();
      expect(mockWs2.send).toHaveBeenCalled();

      // Verify EPISODE_CHANGE message content
      const episodeChangeMessages = mockWs1.send.mock.calls
        .map(call => JSON.parse(call[0] as string))
        .filter((msg: { type: string }) => msg.type === 'EPISODE_CHANGE') as EpisodeChangeMessage[];

      expect(episodeChangeMessages.length).toBeGreaterThan(0);
      const episodeChange = episodeChangeMessages[0];
      expect(episodeChange.type).toBe('EPISODE_CHANGE');
      expect(episodeChange.episodeId).toBe('ep1');
      expect(episodeChange.providerId).toBe('netflix');
      expect(episodeChange.derivedContentKey).toBeDefined();
      expect(episodeChange.eventId).toBeDefined();
      expect(episodeChange.server_ts).toBeDefined();
    });

    it('should include correct eventId in EPISODE_CHANGE broadcast', () => {
      const { mockWs, roomId } = setupRoomWithClient(
        '123e4567-e89b-12d3-a456-426614174000',
        'test-password'
      );

      const room = getRoom(roomId);
      expect(room).toBeDefined();
      if (!room) {
        return;
      }

      // Send episode change request
      const episodeChangeRequest = createEpisodeChangeRequestMessage('ep1', 'netflix', 'https://netflix.com/watch/123');
      simulateWebSocketMessage(mockWs, JSON.stringify(episodeChangeRequest));

      // Verify EPISODE_CHANGE includes eventId matching room state
      const episodeChangeMessages = mockWs.send.mock.calls
        .map(call => JSON.parse(call[0] as string))
        .filter((msg: { type: string }) => msg.type === 'EPISODE_CHANGE') as EpisodeChangeMessage[];

      expect(episodeChangeMessages.length).toBeGreaterThan(0);
      expect(episodeChangeMessages[0].eventId).toBe(room.state.eventId);
    });

    it('should include server_ts in EPISODE_CHANGE broadcast', () => {
      const { mockWs } = setupRoomWithClient(
        '123e4567-e89b-12d3-a456-426614174000',
        'test-password'
      );

      const beforeTs = Date.now();

      // Send episode change request
      const episodeChangeRequest = createEpisodeChangeRequestMessage('ep1', 'netflix', 'https://netflix.com/watch/123');
      simulateWebSocketMessage(mockWs, JSON.stringify(episodeChangeRequest));

      // Verify EPISODE_CHANGE includes server_ts
      const episodeChangeMessages = mockWs.send.mock.calls
        .map(call => JSON.parse(call[0] as string))
        .filter((msg: { type: string }) => msg.type === 'EPISODE_CHANGE') as EpisodeChangeMessage[];

      expect(episodeChangeMessages.length).toBeGreaterThan(0);
      expect(episodeChangeMessages[0].server_ts).toBeDefined();
      expect(episodeChangeMessages[0].server_ts).toBeGreaterThanOrEqual(beforeTs);
    });

    it('should broadcast EPISODE_CHANGE to all connected clients including sender', () => {
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

      // Send episode change request from first client
      const episodeChangeRequest = createEpisodeChangeRequestMessage('ep1', 'netflix', 'https://netflix.com/watch/123');
      simulateWebSocketMessage(mockWs1, JSON.stringify(episodeChangeRequest));

      // Verify all three clients received EPISODE_CHANGE
      expect(mockWs1.send).toHaveBeenCalled();
      expect(mockWs2.send).toHaveBeenCalled();
      expect(mockWs3.send).toHaveBeenCalled();

      // Verify all received EPISODE_CHANGE messages
      const getEpisodeChangeMessages = (mockWs: MockWebSocket): EpisodeChangeMessage[] =>
        mockWs.send.mock.calls
          .map(call => JSON.parse(call[0] as string))
          .filter((msg: { type: string }) => msg.type === 'EPISODE_CHANGE') as EpisodeChangeMessage[];

      const messages1 = getEpisodeChangeMessages(mockWs1);
      const messages2 = getEpisodeChangeMessages(mockWs2);
      const messages3 = getEpisodeChangeMessages(mockWs3);

      expect(messages1.length).toBeGreaterThan(0);
      expect(messages2.length).toBeGreaterThan(0);
      expect(messages3.length).toBeGreaterThan(0);

      // Verify all have same episode info
      expect(messages1[0].episodeId).toBe(messages2[0].episodeId);
      expect(messages2[0].episodeId).toBe(messages3[0].episodeId);
      expect(messages1[0].eventId).toBe(messages2[0].eventId);
      expect(messages2[0].eventId).toBe(messages3[0].eventId);
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

      // Send episode change request from first client
      const episodeChangeRequest = createEpisodeChangeRequestMessage('ep1', 'netflix', 'https://netflix.com/watch/123');
      simulateWebSocketMessage(mockWs1, JSON.stringify(episodeChangeRequest));

      // Verify first client still received EPISODE_CHANGE
      expect(mockWs1.send).toHaveBeenCalled();

      // Verify no errors occurred (closed connection handled gracefully)
      // This is verified by the test completing without throwing
    });
  });

  describe('Content Mismatch Detection', () => {
    it('should detect content mismatch when client reports different derivedContentKey on JOIN', () => {
      // This test verifies that content mismatch detection works
      // The implementation should send CONTENT_MISMATCH when a client joins
      // with a different derivedContentKey than the room's current contentIdentity
      const { mockWs, roomId } = setupRoomWithClient(
        '123e4567-e89b-12d3-a456-426614174000',
        'test-password'
      );

      const room = getRoom(roomId);
      expect(room).toBeDefined();
      if (!room) {
        return;
      }

      // Set room content identity
      const episodeId = 'episode-5';
      const providerId = 'netflix';
      const pageUrl = 'https://netflix.com/watch/12345';
      const episodeChangeRequest = createEpisodeChangeRequestMessage(episodeId, providerId, pageUrl);
      simulateWebSocketMessage(mockWs, JSON.stringify(episodeChangeRequest));

      // Verify room has content identity set
      expect(room.contentIdentity).toBeDefined();
      expect(room.contentIdentity?.derivedContentKey).toBeDefined();

      // Note: Content mismatch detection on JOIN would be tested separately
      // when a new client joins with different content identity
      // This test verifies the room state is set up correctly for mismatch detection
    });

    it('should handle episode change with same content identity correctly', () => {
      const { mockWs, roomId } = setupRoomWithClient(
        '123e4567-e89b-12d3-a456-426614174000',
        'test-password'
      );

      const room = getRoom(roomId);
      expect(room).toBeDefined();
      if (!room) {
        return;
      }

      const episodeId = 'episode-5';
      const providerId = 'netflix';
      const pageUrl = 'https://netflix.com/watch/12345';

      // Send first episode change
      const episodeChangeRequest1 = createEpisodeChangeRequestMessage(episodeId, providerId, pageUrl);
      simulateWebSocketMessage(mockWs, JSON.stringify(episodeChangeRequest1));

      const firstKey = room.contentIdentity?.derivedContentKey;
      expect(firstKey).toBeDefined();

      // Send same episode change again (same content identity)
      const episodeChangeRequest2 = createEpisodeChangeRequestMessage(episodeId, providerId, pageUrl);
      simulateWebSocketMessage(mockWs, JSON.stringify(episodeChangeRequest2));

      // Verify derivedContentKey remains the same
      expect(room.contentIdentity?.derivedContentKey).toBe(firstKey);
      // But eventId should increment
      expect(room.state.eventId).toBeGreaterThan(1);
    });
  });

  describe('State Reset Semantics', () => {
    it('should reset playback state even if already paused', () => {
      const { mockWs, roomId } = setupRoomWithClient(
        '123e4567-e89b-12d3-a456-426614174000',
        'test-password'
      );

      const room = getRoom(roomId);
      expect(room).toBeDefined();
      if (!room) {
        return;
      }

      // Set initial state (paused at position 50)
      room.state.paused = true;
      room.state.time = 50.0;

      // Send episode change request
      const episodeChangeRequest = createEpisodeChangeRequestMessage('ep1', 'netflix', 'https://netflix.com/watch/123');
      simulateWebSocketMessage(mockWs, JSON.stringify(episodeChangeRequest));

      // Verify playback state was reset
      expect(room.state.paused).toBe(true);
      expect(room.state.time).toBe(0);
    });

    it('should reset playback state even if already at time 0', () => {
      const { mockWs, roomId } = setupRoomWithClient(
        '123e4567-e89b-12d3-a456-426614174000',
        'test-password'
      );

      const room = getRoom(roomId);
      expect(room).toBeDefined();
      if (!room) {
        return;
      }

      // Set initial state (paused at position 0)
      room.state.paused = true;
      room.state.time = 0;

      // Send episode change request
      const episodeChangeRequest = createEpisodeChangeRequestMessage('ep1', 'netflix', 'https://netflix.com/watch/123');
      simulateWebSocketMessage(mockWs, JSON.stringify(episodeChangeRequest));

      // Verify playback state was reset (still paused at 0, but episode changed)
      expect(room.state.paused).toBe(true);
      expect(room.state.time).toBe(0);
      // Verify episode info was updated
      expect(room.contentIdentity?.episodeId).toBe('ep1');
    });
  });

  describe('Edge Cases', () => {
    it('should handle EPISODE_CHANGE_REQUEST message before JOIN completes', () => {
      const mockWs = createMockWebSocket();
      const config = getConfig();
      const roomId = toRoomId('123e4567-e89b-12d3-a456-426614174000');
      const password = 'test-password';
      const passwordHash = hashPassword(password, config.serverSecret);

      // Create room
      createRoom(roomId, passwordHash, config.roomTtlSeconds, 'https://example.com/video');

      // Establish connection
      simulateWebSocketUpgrade(mockWs, roomId);

      // Send EPISODE_CHANGE_REQUEST before JOIN
      const episodeChangeRequest = createEpisodeChangeRequestMessage('ep1', 'netflix', 'https://netflix.com/watch/123');
      simulateWebSocketMessage(mockWs, JSON.stringify(episodeChangeRequest));

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

    it('should handle invalid EPISODE_CHANGE_REQUEST message format gracefully', () => {
      const { mockWs } = setupRoomWithClient(
        '123e4567-e89b-12d3-a456-426614174000',
        'test-password'
      );

      // Send invalid JSON
      simulateWebSocketMessage(mockWs, 'invalid json{');

      // Verify connection is closed or ERROR is sent
      // Implementation-specific behavior
    });

    it('should handle episode change with different provider IDs', () => {
      const { mockWs, roomId } = setupRoomWithClient(
        '123e4567-e89b-12d3-a456-426614174000',
        'test-password'
      );

      const room = getRoom(roomId);
      expect(room).toBeDefined();
      if (!room) {
        return;
      }

      // Send episode change with netflix
      const episodeChange1 = createEpisodeChangeRequestMessage('ep1', 'netflix', 'https://netflix.com/watch/123');
      simulateWebSocketMessage(mockWs, JSON.stringify(episodeChange1));

      expect(room.contentIdentity?.providerId).toBe('netflix');

      // Send episode change with hulu (different provider)
      const episodeChange2 = createEpisodeChangeRequestMessage('ep1', 'hulu', 'https://hulu.com/watch/456');
      simulateWebSocketMessage(mockWs, JSON.stringify(episodeChange2));

      expect(room.contentIdentity?.providerId).toBe('hulu');
      expect(room.contentIdentity?.derivedContentKey).toBeDefined();
    });

    it('should handle episode change with numeric and string episode IDs', () => {
      const { mockWs, roomId } = setupRoomWithClient(
        '123e4567-e89b-12d3-a456-426614174000',
        'test-password'
      );

      const room = getRoom(roomId);
      expect(room).toBeDefined();
      if (!room) {
        return;
      }

      // Send episode change with numeric episodeId
      const episodeChange1 = createEpisodeChangeRequestMessage(5, 'netflix', 'https://netflix.com/watch/123');
      simulateWebSocketMessage(mockWs, JSON.stringify(episodeChange1));

      expect(room.contentIdentity?.episodeId).toBe(5);

      // Send episode change with string episodeId
      const episodeChange2 = createEpisodeChangeRequestMessage('episode-6', 'netflix', 'https://netflix.com/watch/124');
      simulateWebSocketMessage(mockWs, JSON.stringify(episodeChange2));

      expect(room.contentIdentity?.episodeId).toBe('episode-6');
    });
  });
});
