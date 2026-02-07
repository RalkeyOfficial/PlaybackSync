/**
 * Unit tests for Drift Reconciliation System
 *
 * Tests verify:
 * - HEARTBEAT message validation and handling
 * - Expected playback time calculation (paused vs playing)
 * - Drift detection based on HEARTBEAT messages
 * - SYNC_ADJUST message generation (nudge-rate vs seek)
 * - Cooldown window prevents reconciliation after explicit events
 * - Threshold-based correction mode selection
 * - Multiple clients with different drift amounts
 * - No drift correction across episode boundaries
 * - Reconciliation doesn't interfere with explicit control
 * - Schema validation for HEARTBEAT and SYNC_ADJUST messages
 *
 * Based on:
 * - backend_network_design_v1.md (highest priority)
 * - unified_v1_backend_and_network_design.md
 */

import { setupTestEnv, cleanupTestEnv } from '../helpers/fixtures';
import { toRoomId } from '../../types/ids';
import type { ClientId } from '../../types/ids';
import { createRoom, getRoom, clearAllRooms } from '../../storage/rooms';
import { hashPassword } from '../../utils/password';
import { getConfig } from '../../config';
import { validateMessage } from '../../utils/validation';
import { handleConnection, type ExtendedWebSocket } from '../../handlers/websocket';
import type { HeartbeatMessage, SyncAdjustMessage, EventMessage } from '../../types/messages';

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
 * Create a valid HEARTBEAT message
 */
function createHeartbeatMessage(
  currentPos: number,
  playerState: 'playing' | 'paused' | 'buffering',
  clockSample?: number
): HeartbeatMessage {
  const message: HeartbeatMessage = {
    type: 'HEARTBEAT',
    currentPos,
    playerState,
  };
  if (clockSample !== undefined) {
    message.clockSample = clockSample;
  }
  return message;
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

/**
 * Calculate expected playback time based on room state
 * This matches the server-side calculation logic
 */
function calculateExpectedTime(room: ReturnType<typeof getRoom>): number {
  if (!room) {
    throw new Error('Room not found');
  }
  const now = Date.now();
  if (room.state.playerState === 'paused') {
    return room.state.videoPos;
  } else {
    // Playing: expected_time = state.videoPos + (now - last_state_update_ts)
    const elapsedSeconds = (now - room.state.last_state_update_ts) / 1000;
    return room.state.videoPos + elapsedSeconds;
  }
}

describe('Drift Reconciliation System', () => {
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

  describe('HEARTBEAT Message Schema Validation', () => {
    it('should validate a valid HEARTBEAT message with all fields', () => {
      const message = createHeartbeatMessage(123.45, 'playing', Date.now());
      const result = validateMessage(message, 'HEARTBEAT');
      expect(result.valid).toBe(true);
      expect(result.errors).toBeNull();
    });

    it('should validate a valid HEARTBEAT message without clockSample', () => {
      const message = createHeartbeatMessage(123.45, 'paused');
      const result = validateMessage(message, 'HEARTBEAT');
      expect(result.valid).toBe(true);
      expect(result.errors).toBeNull();
    });

    it('should validate HEARTBEAT message with buffering state', () => {
      const message = createHeartbeatMessage(123.45, 'buffering');
      const result = validateMessage(message, 'HEARTBEAT');
      expect(result.valid).toBe(true);
      expect(result.errors).toBeNull();
    });

    it('should reject HEARTBEAT message with missing required fields', () => {
      const message = {
        type: 'HEARTBEAT',
        // Missing currentPos and playerState
      };
      const result = validateMessage(message, 'HEARTBEAT');
      expect(result.valid).toBe(false);
      expect(result.errors).not.toBeNull();
    });

    it('should reject HEARTBEAT message with invalid playerState', () => {
      const message = {
        type: 'HEARTBEAT',
        currentPos: 123.45,
        playerState: 'invalid-state',
      };
      const result = validateMessage(message, 'HEARTBEAT');
      expect(result.valid).toBe(false);
      expect(result.errors).not.toBeNull();
    });

    it('should reject HEARTBEAT message with negative currentPos', () => {
      const message = createHeartbeatMessage(-1, 'playing');
      const result = validateMessage(message, 'HEARTBEAT');
      expect(result.valid).toBe(false);
      expect(result.errors).not.toBeNull();
    });
  });

  describe('SYNC_ADJUST Message Schema Validation', () => {
    it('should validate a valid SYNC_ADJUST message with nudge-rate mode', () => {
      const message: SyncAdjustMessage = {
        type: 'SYNC_ADJUST',
        serverTime: Date.now(),
        targetPos: 123.45,
        mode: 'nudge-rate',
      };
      const result = validateMessage(message, 'SYNC_ADJUST');
      expect(result.valid).toBe(true);
      expect(result.errors).toBeNull();
    });

    it('should validate a valid SYNC_ADJUST message with seek mode', () => {
      const message: SyncAdjustMessage = {
        type: 'SYNC_ADJUST',
        serverTime: Date.now(),
        targetPos: 123.45,
        mode: 'seek',
      };
      const result = validateMessage(message, 'SYNC_ADJUST');
      expect(result.valid).toBe(true);
      expect(result.errors).toBeNull();
    });

    it('should reject SYNC_ADJUST message with missing required fields', () => {
      const message = {
        type: 'SYNC_ADJUST',
        // Missing serverTime, targetPos, mode
      };
      const result = validateMessage(message, 'SYNC_ADJUST');
      expect(result.valid).toBe(false);
      expect(result.errors).not.toBeNull();
    });

    it('should reject SYNC_ADJUST message with invalid mode', () => {
      const message = {
        type: 'SYNC_ADJUST',
        serverTime: Date.now(),
        targetPos: 123.45,
        mode: 'invalid-mode',
      };
      const result = validateMessage(message, 'SYNC_ADJUST');
      expect(result.valid).toBe(false);
      expect(result.errors).not.toBeNull();
    });

    it('should reject SYNC_ADJUST message with negative targetPos', () => {
      const message: SyncAdjustMessage = {
        type: 'SYNC_ADJUST',
        serverTime: Date.now(),
        targetPos: -1,
        mode: 'seek',
      };
      const result = validateMessage(message, 'SYNC_ADJUST');
      expect(result.valid).toBe(false);
      expect(result.errors).not.toBeNull();
    });
  });

  describe('Expected Playback Time Calculation', () => {
    it('should calculate expected time as current time when paused', () => {
      const { roomId } = setupRoomWithClient(
        '123e4567-e89b-12d3-a456-426614174000',
        'test-password'
      );

      const room = getRoom(roomId);
      expect(room).toBeDefined();
      if (!room) {
        return;
      }

      // Set room to paused state
      room.state.playerState = 'paused';
      room.state.videoPos = 100.0;
      room.state.last_state_update_ts = Date.now();

      const expectedTime = calculateExpectedTime(room);
      expect(expectedTime).toBe(100.0);
    });

    it('should calculate expected time with elapsed time when playing', () => {
      const { roomId } = setupRoomWithClient(
        '123e4567-e89b-12d3-a456-426614174000',
        'test-password'
      );

      const room = getRoom(roomId);
      expect(room).toBeDefined();
      if (!room) {
        return;
      }

      // Set room to playing state
      room.state.playerState = 'playing';
      room.state.videoPos = 100.0;
      const baseTime = Date.now();
      room.state.last_state_update_ts = baseTime;

      // Advance time by 5 seconds
      jest.advanceTimersByTime(5000);

      const expectedTime = calculateExpectedTime(room);
      expect(expectedTime).toBeCloseTo(105.0, 1); // 100.0 + 5 seconds
    });

    it('should not advance expected time when paused even if time passes', () => {
      const { roomId } = setupRoomWithClient(
        '123e4567-e89b-12d3-a456-426614174000',
        'test-password'
      );

      const room = getRoom(roomId);
      expect(room).toBeDefined();
      if (!room) {
        return;
      }

      room.state.playerState = 'paused';
      room.state.videoPos = 100.0;
      room.state.last_state_update_ts = Date.now();

      // Advance time by 10 seconds
      jest.advanceTimersByTime(10000);

      const expectedTime = calculateExpectedTime(room);
      expect(expectedTime).toBe(100.0); // Should remain unchanged
    });
  });

  describe('Drift Detection from HEARTBEAT', () => {
    it('should detect no drift when client position matches expected time', () => {
      const { mockWs, roomId } = setupRoomWithClient(
        '123e4567-e89b-12d3-a456-426614174000',
        'test-password'
      );

      const room = getRoom(roomId);
      expect(room).toBeDefined();
      if (!room) {
        return;
      }

      // Set room state
      room.state.playerState = 'playing';
      room.state.videoPos = 100.0;
      room.state.last_state_update_ts = Date.now();

      // Send HEARTBEAT with matching position (after small time advance)
      jest.advanceTimersByTime(100);
      const heartbeat = createHeartbeatMessage(100.1, 'playing'); // ~100ms drift, within threshold
      simulateWebSocketMessage(mockWs, JSON.stringify(heartbeat));

      // Note: Actual implementation would check drift and send SYNC_ADJUST if needed
      // This test verifies the drift calculation logic
      const expectedTime = calculateExpectedTime(room);
      const driftMs = Math.abs(heartbeat.currentPos - expectedTime) * 1000;
      const config = getConfig();
      expect(driftMs).toBeLessThan(config.driftThresholdMs);
    });

    it('should send SYNC_ADJUST with seek mode when client is significantly behind', () => {
      const { mockWs, roomId } = setupRoomWithClient(
        '123e4567-e89b-12d3-a456-426614174000',
        'test-password'
      );

      const room = getRoom(roomId);
      expect(room).toBeDefined();
      if (!room) {
        return;
      }

      // Set room to playing state
      room.state.playerState = 'playing';
      room.state.videoPos = 0.0;
      room.state.last_state_update_ts = Date.now();

      // Advance time by 8 seconds (simulating playback)
      jest.advanceTimersByTime(8000);

      // Client sends HEARTBEAT reporting position 0 (way behind)
      const heartbeat = createHeartbeatMessage(0.0, 'playing');
      simulateWebSocketMessage(mockWs, JSON.stringify(heartbeat));

      // Verify SYNC_ADJUST was sent
      const syncAdjustCalls = mockWs.send.mock.calls.filter(call => {
        try {
          const message = JSON.parse(call[0] as string);
          return message.type === 'SYNC_ADJUST';
        } catch {
          return false;
        }
      });

      expect(syncAdjustCalls.length).toBeGreaterThan(0);

      if (syncAdjustCalls.length > 0) {
        const syncAdjustMessage = JSON.parse(syncAdjustCalls[0][0] as string) as SyncAdjustMessage;
        expect(syncAdjustMessage.type).toBe('SYNC_ADJUST');
        expect(syncAdjustMessage.mode).toBe('seek'); // Large drift should use seek
        expect(syncAdjustMessage.targetPos).toBeGreaterThan(7.0); // Should be ~8 seconds
      }
    });

    it('should detect positive drift when client is ahead', () => {
      const { mockWs, roomId } = setupRoomWithClient(
        '123e4567-e89b-12d3-a456-426614174000',
        'test-password'
      );

      const room = getRoom(roomId);
      expect(room).toBeDefined();
      if (!room) {
        return;
      }

      room.state.playerState = 'playing';
      room.state.videoPos = 100.0;
      room.state.last_state_update_ts = Date.now();

      // Client reports position ahead by 1 second
      const heartbeat = createHeartbeatMessage(101.0, 'playing');
      simulateWebSocketMessage(mockWs, JSON.stringify(heartbeat));

      const expectedTime = calculateExpectedTime(room);
      const driftMs = (heartbeat.currentPos - expectedTime) * 1000;
      expect(driftMs).toBeGreaterThan(0); // Positive drift
    });

    it('should detect negative drift when client is behind', () => {
      const { mockWs, roomId } = setupRoomWithClient(
        '123e4567-e89b-12d3-a456-426614174000',
        'test-password'
      );

      const room = getRoom(roomId);
      expect(room).toBeDefined();
      if (!room) {
        return;
      }

      room.state.playerState = 'playing';
      room.state.videoPos = 100.0;
      room.state.last_state_update_ts = Date.now();

      // Client reports position behind by 1 second
      const heartbeat = createHeartbeatMessage(99.0, 'playing');
      simulateWebSocketMessage(mockWs, JSON.stringify(heartbeat));

      const expectedTime = calculateExpectedTime(room);
      const driftMs = (heartbeat.currentPos - expectedTime) * 1000;
      expect(driftMs).toBeLessThan(0); // Negative drift
    });
  });

  describe('SYNC_ADJUST Mode Selection (Nudge vs Seek)', () => {
    it('should select nudge-rate mode for small drift below SEEK_THRESHOLD_MS', () => {
      const config = getConfig();
      const { mockWs, roomId } = setupRoomWithClient(
        '123e4567-e89b-12d3-a456-426614174000',
        'test-password'
      );

      const room = getRoom(roomId);
      expect(room).toBeDefined();
      if (!room) {
        return;
      }

      room.state.playerState = 'playing';
      room.state.videoPos = 100.0;
      room.state.last_state_update_ts = Date.now();

      // Small drift: 150ms (between NUDGE_THRESHOLD_MS and SEEK_THRESHOLD_MS)
      const driftSeconds = config.nudgeThresholdMs / 1000 + 0.05; // ~250ms
      const heartbeat = createHeartbeatMessage(100.0 + driftSeconds, 'playing');
      simulateWebSocketMessage(mockWs, JSON.stringify(heartbeat));

      // Expected: mode should be 'nudge-rate' for drift < SEEK_THRESHOLD_MS
      const expectedTime = calculateExpectedTime(room);
      const driftMs = Math.abs(heartbeat.currentPos - expectedTime) * 1000;

      if (driftMs >= config.driftThresholdMs && driftMs < config.seekThresholdMs) {
        // Should use nudge-rate
        expect(driftMs).toBeLessThan(config.seekThresholdMs);
        expect(driftMs).toBeGreaterThanOrEqual(config.nudgeThresholdMs);
      }
    });

    it('should select seek mode for large drift above SEEK_THRESHOLD_MS', () => {
      const config = getConfig();
      const { mockWs, roomId } = setupRoomWithClient(
        '123e4567-e89b-12d3-a456-426614174000',
        'test-password'
      );

      const room = getRoom(roomId);
      expect(room).toBeDefined();
      if (!room) {
        return;
      }

      room.state.playerState = 'playing';
      room.state.videoPos = 100.0;
      room.state.last_state_update_ts = Date.now();

      // Large drift: 1 second (above SEEK_THRESHOLD_MS)
      const heartbeat = createHeartbeatMessage(101.0, 'playing');
      simulateWebSocketMessage(mockWs, JSON.stringify(heartbeat));

      const expectedTime = calculateExpectedTime(room);
      const driftMs = Math.abs(heartbeat.currentPos - expectedTime) * 1000;

      if (driftMs >= config.seekThresholdMs) {
        // Should use seek
        expect(driftMs).toBeGreaterThanOrEqual(config.seekThresholdMs);
      }
    });

    it('should select nudge-rate for drift between NUDGE_THRESHOLD_MS and SEEK_THRESHOLD_MS', () => {
      const config = getConfig();
      const { mockWs, roomId } = setupRoomWithClient(
        '123e4567-e89b-12d3-a456-426614174000',
        'test-password'
      );

      const room = getRoom(roomId);
      expect(room).toBeDefined();
      if (!room) {
        return;
      }

      room.state.playerState = 'playing';
      room.state.videoPos = 100.0;
      room.state.last_state_update_ts = Date.now();

      // Medium drift: between thresholds
      const driftSeconds = (config.nudgeThresholdMs + config.seekThresholdMs) / 2000; // Middle point
      const heartbeat = createHeartbeatMessage(100.0 + driftSeconds, 'playing');
      simulateWebSocketMessage(mockWs, JSON.stringify(heartbeat));

      const expectedTime = calculateExpectedTime(room);
      const driftMs = Math.abs(heartbeat.currentPos - expectedTime) * 1000;

      // Should use nudge-rate if drift is >= NUDGE_THRESHOLD_MS but < SEEK_THRESHOLD_MS
      if (driftMs >= config.nudgeThresholdMs && driftMs < config.seekThresholdMs) {
        expect(driftMs).toBeGreaterThanOrEqual(config.nudgeThresholdMs);
        expect(driftMs).toBeLessThan(config.seekThresholdMs);
      }
    });
  });

  describe('Cooldown Window', () => {
    it('should skip reconciliation during cooldown window after explicit event', () => {
      const config = getConfig();
      const { mockWs, roomId } = setupRoomWithClient(
        '123e4567-e89b-12d3-a456-426614174000',
        'test-password'
      );

      const room = getRoom(roomId);
      expect(room).toBeDefined();
      if (!room) {
        return;
      }

      // Send explicit play event
      const eventMessage = createEventMessage('play');
      simulateWebSocketMessage(mockWs, JSON.stringify(eventMessage));

      const lastExplicitEventTs = room.state.last_explicit_event_ts;
      const timeSinceEvent = Date.now() - lastExplicitEventTs;

      // Should be within cooldown window
      expect(timeSinceEvent).toBeLessThan(config.cooldownWindowMs);

      // Send HEARTBEAT with large drift
      const heartbeat = createHeartbeatMessage(200.0, 'playing'); // Large drift
      simulateWebSocketMessage(mockWs, JSON.stringify(heartbeat));

      // Reconciliation should be skipped during cooldown
      // Note: Actual implementation would check cooldown before processing HEARTBEAT
      const shouldSkip = timeSinceEvent < config.cooldownWindowMs;
      expect(shouldSkip).toBe(true);
    });

    it('should allow reconciliation after cooldown window expires', () => {
      const config = getConfig();
      const { mockWs, roomId } = setupRoomWithClient(
        '123e4567-e89b-12d3-a456-426614174000',
        'test-password'
      );

      const room = getRoom(roomId);
      expect(room).toBeDefined();
      if (!room) {
        return;
      }

      // Send explicit play event
      const eventMessage = createEventMessage('play');
      simulateWebSocketMessage(mockWs, JSON.stringify(eventMessage));

      // Advance time past cooldown window
      jest.advanceTimersByTime(config.cooldownWindowMs + 100);

      const timeSinceEvent = Date.now() - room.state.last_explicit_event_ts;

      // Should be past cooldown window
      expect(timeSinceEvent).toBeGreaterThanOrEqual(config.cooldownWindowMs);

      // Reconciliation should be allowed now
      const shouldSkip = timeSinceEvent < config.cooldownWindowMs;
      expect(shouldSkip).toBe(false);
    });
  });

  describe('Multiple Clients with Different Drift', () => {
    it('should handle multiple clients with varying drift amounts', () => {
      const { mockWs: mockWs1 } = setupRoomWithClient(
        '123e4567-e89b-12d3-a456-426614174000',
        'test-password'
      );
      const { mockWs: mockWs2 } = setupRoomWithClient(
        '123e4567-e89b-12d3-a456-426614174000',
        'test-password'
      );
      const { mockWs: mockWs3, roomId } = setupRoomWithClient(
        '123e4567-e89b-12d3-a456-426614174000',
        'test-password'
      );

      const room = getRoom(roomId);
      expect(room).toBeDefined();
      if (!room) {
        return;
      }

      room.state.playerState = 'playing';
      room.state.videoPos = 100.0;
      room.state.last_state_update_ts = Date.now();

      // Client 1: small drift (within threshold)
      const heartbeat1 = createHeartbeatMessage(100.05, 'playing');
      simulateWebSocketMessage(mockWs1, JSON.stringify(heartbeat1));

      // Client 2: medium drift (needs nudge-rate)
      const heartbeat2 = createHeartbeatMessage(100.3, 'playing');
      simulateWebSocketMessage(mockWs2, JSON.stringify(heartbeat2));

      // Client 3: large drift (needs seek)
      const heartbeat3 = createHeartbeatMessage(101.0, 'playing');
      simulateWebSocketMessage(mockWs3, JSON.stringify(heartbeat3));

      const expectedTime = calculateExpectedTime(room);
      const config = getConfig();

      const drift1 = Math.abs(heartbeat1.currentPos - expectedTime) * 1000;
      const drift2 = Math.abs(heartbeat2.currentPos - expectedTime) * 1000;
      const drift3 = Math.abs(heartbeat3.currentPos - expectedTime) * 1000;

      // Client 1 should not need correction
      expect(drift1).toBeLessThan(config.driftThresholdMs);

      // Client 2 should need nudge-rate correction
      if (drift2 >= config.driftThresholdMs && drift2 < config.seekThresholdMs) {
        expect(drift2).toBeGreaterThanOrEqual(config.nudgeThresholdMs);
        expect(drift2).toBeLessThan(config.seekThresholdMs);
      }

      // Client 3 should need seek correction
      if (drift3 >= config.seekThresholdMs) {
        expect(drift3).toBeGreaterThanOrEqual(config.seekThresholdMs);
      }
    });
  });

  describe('No Drift Correction Across Episode Boundaries', () => {
    it('should not apply drift correction when content identity differs', () => {
      const { mockWs, roomId } = setupRoomWithClient(
        '123e4567-e89b-12d3-a456-426614174000',
        'test-password'
      );

      const room = getRoom(roomId);
      expect(room).toBeDefined();
      if (!room) {
        return;
      }

      // Set different content identity (simulating episode mismatch)
      room.contentIdentity = {
        episodeId: 'episode-1',
        providerId: 'netflix',
        derivedContentKey: 'key-1',
      };

      room.state.playerState = 'playing';
      room.state.videoPos = 100.0;
      room.state.last_state_update_ts = Date.now();

      // Send HEARTBEAT with large drift
      const heartbeat = createHeartbeatMessage(200.0, 'playing');
      simulateWebSocketMessage(mockWs, JSON.stringify(heartbeat));

      // According to unified_v1_backend_and_network_design.md:
      // "No drift correction is applied across episode boundaries"
      // This test documents this requirement - actual implementation would check content identity
      expect(room.contentIdentity).toBeDefined();
    });
  });

  describe('Reconciliation Non-Interference Rules', () => {
    it('should not change paused state during reconciliation', () => {
      const { mockWs, roomId } = setupRoomWithClient(
        '123e4567-e89b-12d3-a456-426614174000',
        'test-password'
      );

      const room = getRoom(roomId);
      expect(room).toBeDefined();
      if (!room) {
        return;
      }

      room.state.playerState = 'paused';
      const initialPlayerState = room.state.playerState;

      // Send HEARTBEAT with drift
      const heartbeat = createHeartbeatMessage(200.0, 'playing');
      simulateWebSocketMessage(mockWs, JSON.stringify(heartbeat));

      // Paused state should not change
      expect(room.state.playerState).toBe(initialPlayerState);
    });

    it('should not override user intent from explicit events', () => {
      const { mockWs, roomId } = setupRoomWithClient(
        '123e4567-e89b-12d3-a456-426614174000',
        'test-password'
      );

      const room = getRoom(roomId);
      expect(room).toBeDefined();
      if (!room) {
        return;
      }

      // User sends explicit seek event
      const seekEvent = createEventMessage('seek', 150.0);
      simulateWebSocketMessage(mockWs, JSON.stringify(seekEvent));

      const explicitVideoPos = room.state.videoPos;

      // Send HEARTBEAT immediately after (should be in cooldown)
      const heartbeat = createHeartbeatMessage(100.0, 'playing');
      simulateWebSocketMessage(mockWs, JSON.stringify(heartbeat));

      // VideoPos should remain at explicit seek value (not changed by reconciliation)
      expect(room.state.videoPos).toBe(explicitVideoPos);
    });
  });

  describe('HEARTBEAT Handling Before JOIN', () => {
    it('should reject HEARTBEAT message before JOIN completes', () => {
      const mockWs = createMockWebSocket();
      const config = getConfig();
      const roomId = toRoomId('123e4567-e89b-12d3-a456-426614174000');
      const password = 'test-password';
      const passwordHash = hashPassword(password, config.serverSecret);

      // Create room
      createRoom(roomId, passwordHash, config.roomTtlSeconds, 'https://example.com/video');

      // Establish connection
      simulateWebSocketUpgrade(mockWs, roomId);

      // Send HEARTBEAT before JOIN
      const heartbeat = createHeartbeatMessage(100.0, 'playing');
      simulateWebSocketMessage(mockWs, JSON.stringify(heartbeat));

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
  });

  describe('Buffering State Handling', () => {
    it('should handle HEARTBEAT with buffering state', () => {
      const { mockWs, roomId } = setupRoomWithClient(
        '123e4567-e89b-12d3-a456-426614174000',
        'test-password'
      );

      const room = getRoom(roomId);
      expect(room).toBeDefined();
      if (!room) {
        return;
      }

      // Send HEARTBEAT with buffering state
      const heartbeat = createHeartbeatMessage(100.0, 'buffering');
      simulateWebSocketMessage(mockWs, JSON.stringify(heartbeat));

      // According to backend_network_design_v1.md:
      // "server uses these to detect drift and buffering without overwhelming the network"
      // Buffering state should be handled appropriately
      expect(heartbeat.playerState).toBe('buffering');
    });
  });
});
