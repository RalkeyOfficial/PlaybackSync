/**
 * Unit tests for background service worker
 *
 * Tests verify:
 * - Message handler processes different message types correctly
 * - PING/PONG communication works
 * - Error handling works correctly
 * - Lifecycle events are logged
 */

import { createMockSender } from '../helpers/chrome-mocks';

describe('Background Service Worker', () => {
  let mockChrome: {
    runtime: {
      onMessage: {
        addListener: jest.Mock;
      };
      onInstalled: {
        addListener: jest.Mock;
      };
      onStartup: {
        addListener: jest.Mock;
      };
      lastError?: { message: string };
    };
  };

  let messageListener: (
    message: unknown,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response?: unknown) => void
  ) => boolean | void;

  beforeEach(() => {
    // Reset Chrome mocks
    mockChrome = {
      runtime: {
        onMessage: {
          addListener: jest.fn(listener => {
            messageListener = listener;
          }),
        },
        onInstalled: {
          addListener: jest.fn(),
        },
        onStartup: {
          addListener: jest.fn(),
        },
        lastError: undefined,
      },
    };

    // Replace global chrome with mock
    (global as unknown as { chrome: typeof chrome }).chrome =
      mockChrome as unknown as typeof chrome;

    // Clear console mocks
    jest.clearAllMocks();
  });

  describe('Message Handler', () => {
    beforeEach(async () => {
      // Import background script to register listeners
      await import('../../background/index');
    });

    it('should register message listener on module load', () => {
      expect(mockChrome.runtime.onMessage.addListener).toHaveBeenCalled();
      expect(messageListener).toBeDefined();
    });

    it('should handle PING message with PONG response', () => {
      const sendResponse = jest.fn();
      const sender = createMockSender({
        tab: { id: 1, url: 'https://miruro.tv/watch/test' },
      });

      const result = messageListener({ type: 'PING' }, sender, sendResponse);

      expect(result).toBe(true);
      expect(sendResponse).toHaveBeenCalledWith({ type: 'PONG' });
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('Received message from content script'),
        expect.objectContaining({ type: 'PING' })
      );
    });

    it('should handle PLAYBACK_INTENT message', () => {
      const sendResponse = jest.fn();
      const sender = createMockSender({
        tab: { id: 1, url: 'https://miruro.tv/watch/test' },
      });

      const result = messageListener(
        {
          type: 'PLAYBACK_INTENT',
          data: { type: 'play', time: 10 },
        },
        sender,
        sendResponse
      );

      expect(result).toBe(true);
      expect(sendResponse).toHaveBeenCalledWith({ success: true });
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('Received playback intent'),
        expect.any(Object)
      );
    });

    it('should handle CONTENT_IDENTITY message', () => {
      const sendResponse = jest.fn();
      const sender = createMockSender({
        tab: { id: 1, url: 'https://miruro.tv/watch/test' },
      });

      const result = messageListener(
        {
          type: 'CONTENT_IDENTITY',
          data: {
            providerId: 'miruro',
            episodeId: 'test-episode',
            normalizedUrl: '/watch/test',
          },
        },
        sender,
        sendResponse
      );

      expect(result).toBe(true);
      expect(sendResponse).toHaveBeenCalledWith({ success: true });
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('Received content identity'),
        expect.any(Object)
      );
    });

    it('should handle EPISODE_CHANGE_REQUEST message', () => {
      const sendResponse = jest.fn();
      const sender = createMockSender({
        tab: { id: 1, url: 'https://miruro.tv/watch/test' },
      });

      const result = messageListener(
        {
          type: 'EPISODE_CHANGE_REQUEST',
          data: {},
        },
        sender,
        sendResponse
      );

      expect(result).toBe(true);
      expect(sendResponse).toHaveBeenCalledWith({ success: true });
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('Received episode change request'),
        expect.any(Object)
      );
    });

    it('should handle unknown message types', () => {
      const sendResponse = jest.fn();
      const sender = createMockSender({
        tab: { id: 1, url: 'https://miruro.tv/watch/test' },
      });

      const result = messageListener({ type: 'UNKNOWN_TYPE' as any }, sender, sendResponse);

      expect(result).toBe(true);
      expect(sendResponse).toHaveBeenCalledWith({
        success: false,
        error: 'Unknown message type',
      });
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('Unknown message type from content script'),
        expect.objectContaining({ type: 'UNKNOWN_TYPE' })
      );
    });

    it('should handle errors gracefully', () => {
      const sendResponse = jest.fn();
      const sender = createMockSender({
        tab: { id: 1, url: 'https://miruro.tv/watch/test' },
      });

      // Create a message that will cause an error
      const invalidMessage = {
        type: 'PLAYBACK_INTENT',
        data: null,
      };

      // Mock console.log to throw an error
      const originalLog = console.log;
      console.log = jest.fn(() => {
        throw new Error('Test error');
      });

      const result = messageListener(invalidMessage as any, sender, sendResponse);

      // Restore console.log
      console.log = originalLog;

      expect(result).toBe(true);
      expect(sendResponse).toHaveBeenCalledWith({
        success: false,
        error: 'Internal error',
      });
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('Error handling message from content script'),
        expect.any(Error),
        expect.any(Object)
      );
    });

    it('should log sender information', () => {
      const sendResponse = jest.fn();
      const sender = createMockSender({
        tab: { id: 123, url: 'https://miruro.tv/watch/episode-1' },
      });

      messageListener({ type: 'PING' }, sender, sendResponse);

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('Received message from content script'),
        expect.objectContaining({
          type: 'PING',
          tabId: 123,
          url: 'https://miruro.tv/watch/episode-1',
        })
      );
    });
  });

  describe('Lifecycle Events', () => {
    beforeEach(async () => {
      await import('../../background/index');
    });

    it('should register onInstalled listener', () => {
      expect(mockChrome.runtime.onInstalled.addListener).toHaveBeenCalled();
    });

    it('should register onStartup listener', () => {
      expect(mockChrome.runtime.onStartup.addListener).toHaveBeenCalled();
    });

    it('should log installation event', () => {
      const installedListener = mockChrome.runtime.onInstalled.addListener.mock.calls[0]?.[0];
      expect(installedListener).toBeDefined();

      installedListener({
        reason: 'install',
        previousVersion: undefined,
      } as chrome.runtime.InstalledDetails);

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('Extension installed'),
        expect.objectContaining({
          reason: 'install',
          previousVersion: undefined,
        })
      );
    });

    it('should log startup event', () => {
      const startupListener = mockChrome.runtime.onStartup.addListener.mock.calls[0]?.[0];
      expect(startupListener).toBeDefined();

      startupListener();

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('Extension started on browser startup')
      );
    });
  });

  describe('Error Handling', () => {
    beforeEach(async () => {
      await import('../../background/index');
    });

    it('should handle service worker errors', () => {
      const errorEvent = new ErrorEvent('error', {
        message: 'Test error',
        filename: 'test.js',
        lineno: 10,
        colno: 5,
        error: new Error('Test error'),
      });

      // Trigger error event
      window.dispatchEvent(errorEvent);

      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('Service worker error'),
        expect.any(Error),
        expect.objectContaining({
          message: 'Test error',
          filename: 'test.js',
          lineno: 10,
          colno: 5,
        })
      );
    });

    it('should handle unhandled promise rejections', () => {
      const rejectionEvent = new PromiseRejectionEvent('unhandledrejection', {
        promise: Promise.reject('Test rejection'),
        reason: 'Test rejection',
      });

      // Trigger rejection event
      window.dispatchEvent(rejectionEvent);

      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('Unhandled promise rejection'),
        'Test rejection'
      );
    });
  });

  describe('Initialization', () => {
    it('should log initialization message', async () => {
      await import('../../background/index');

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('Background service worker initialized')
      );
    });
  });
});
