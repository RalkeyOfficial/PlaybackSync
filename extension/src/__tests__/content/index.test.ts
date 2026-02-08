/**
 * Unit tests for content script
 *
 * Tests verify:
 * - sendToBackground() sends messages correctly
 * - Message handler receives and processes commands
 * - Domain verification works correctly
 * - Test communication function works
 */

/// <reference lib="dom" />

import { createMockTab, createMockSender } from '../helpers/chrome-mocks';

describe('Content Script', () => {
  let mockChrome: {
    runtime: {
      sendMessage: jest.Mock;
      onMessage: {
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
        sendMessage: jest.fn((message, callback) => {
          // Simulate successful response
          if (callback) {
            callback({ type: 'PONG' });
          }
        }),
        onMessage: {
          addListener: jest.fn(listener => {
            messageListener = listener;
          }),
        },
        lastError: undefined,
      },
    };

    // Replace global chrome with mock
    (global as unknown as { chrome: typeof chrome }).chrome =
      mockChrome as unknown as typeof chrome;

    // Reset window.location mock
    Object.defineProperty(window, 'location', {
      writable: true,
      configurable: true,
      value: {
        href: 'https://miruro.tv/watch/test',
        hostname: 'miruro.tv',
        pathname: '/watch/test',
      },
    });

    // Clear console mocks
    jest.clearAllMocks();

    // Clear module cache to allow fresh imports
    jest.resetModules();
  });

  describe('sendToBackground', () => {
    it('should send message to background script', async () => {
      // Import content script - this will trigger module load and testCommunication()
      await import('../../content/index');

      // Wait for async operations
      await new Promise(resolve => setTimeout(resolve, 100));

      // Verify PING was sent
      expect(mockChrome.runtime.sendMessage).toHaveBeenCalledWith(
        { type: 'PING' },
        expect.any(Function)
      );
    });

    it('should handle Chrome runtime errors', async () => {
      mockChrome.runtime.lastError = { message: 'Extension context invalidated' };
      mockChrome.runtime.sendMessage = jest.fn((message, callback) => {
        if (callback) {
          callback();
        }
      });

      // Import content script - testCommunication will trigger error handling
      await import('../../content/index');

      // Wait for async operations
      await new Promise(resolve => setTimeout(resolve, 100));

      // Verify error was handled (check console.error was called)
      expect(console.error).toHaveBeenCalled();
    });
  });

  describe('Message Handler', () => {
    beforeEach(async () => {
      // Import content script to register listeners
      await import('../../content/index');
    });

    it('should register message listener on module load', () => {
      expect(mockChrome.runtime.onMessage.addListener).toHaveBeenCalled();
      expect(messageListener).toBeDefined();
    });

    it('should handle PONG messages', () => {
      const sendResponse = jest.fn();
      const result = messageListener!(
        { type: 'PONG' },
        createMockSender({ tab: createMockTab({ url: 'https://miruro.tv/test' }) }),
        sendResponse
      );

      expect(result).toBe(true);
      expect(sendResponse).toHaveBeenCalledWith({ success: true });
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('Received PONG from background')
      );
    });

    it('should handle PLAYBACK_COMMAND messages', () => {
      const sendResponse = jest.fn();
      const result = messageListener!(
        {
          type: 'PLAYBACK_COMMAND',
          data: { type: 'play', time: 10 },
        },
        createMockSender({ tab: createMockTab({ url: 'https://miruro.tv/test' }) }),
        sendResponse
      );

      expect(result).toBe(true);
      expect(sendResponse).toHaveBeenCalledWith({ success: true });
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('Received playback command'),
        expect.any(Object)
      );
    });

    it('should handle unknown message types', () => {
      const sendResponse = jest.fn();
      const result = messageListener!(
        { type: 'UNKNOWN_TYPE' as any },
        createMockSender({ tab: createMockTab({ url: 'https://miruro.tv/test' }) }),
        sendResponse
      );

      expect(result).toBe(true);
      expect(sendResponse).toHaveBeenCalledWith({
        success: false,
        error: 'Unknown message type',
      });
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('Unknown message type'),
        expect.objectContaining({ type: 'UNKNOWN_TYPE' })
      );
    });
  });

  describe('Domain Verification', () => {
    it('should activate on miruro.tv domain', async () => {
      Object.defineProperty(window, 'location', {
        writable: true,
        configurable: true,
        value: {
          href: 'https://miruro.tv/watch/test',
          hostname: 'miruro.tv',
          pathname: '/watch/test',
        },
      });

      await import('../../content/index');

      // Wait for async operations
      await new Promise(resolve => setTimeout(resolve, 100));

      // Should have sent PING message
      expect(mockChrome.runtime.sendMessage).toHaveBeenCalledWith(
        { type: 'PING' },
        expect.any(Function)
      );
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('Content script loaded on supported domain'),
        expect.objectContaining({ hostname: 'miruro.tv' })
      );
    });

    it('should activate on miruro.to domain', async () => {
      Object.defineProperty(window, 'location', {
        writable: true,
        configurable: true,
        value: {
          href: 'https://miruro.to/watch/test',
          hostname: 'miruro.to',
          pathname: '/watch/test',
        },
      });

      await import('../../content/index');

      await new Promise(resolve => setTimeout(resolve, 100));

      expect(mockChrome.runtime.sendMessage).toHaveBeenCalledWith(
        { type: 'PING' },
        expect.any(Function)
      );
    });

    it('should activate on subdomain of miruro.tv', async () => {
      Object.defineProperty(window, 'location', {
        writable: true,
        configurable: true,
        value: {
          href: 'https://www.miruro.tv/watch/test',
          hostname: 'www.miruro.tv',
          pathname: '/watch/test',
        },
      });

      await import('../../content/index');

      await new Promise(resolve => setTimeout(resolve, 100));

      expect(mockChrome.runtime.sendMessage).toHaveBeenCalledWith(
        { type: 'PING' },
        expect.any(Function)
      );
    });

    it('should not activate on unsupported domain', async () => {
      Object.defineProperty(window, 'location', {
        writable: true,
        configurable: true,
        value: {
          href: 'https://example.com/video',
          hostname: 'example.com',
          pathname: '/video',
        },
      });

      await import('../../content/index');

      await new Promise(resolve => setTimeout(resolve, 100));

      // Should not send PING on unsupported domain
      expect(mockChrome.runtime.sendMessage).not.toHaveBeenCalled();
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('Content script loaded on unsupported domain'),
        expect.objectContaining({ hostname: 'example.com' })
      );
    });
  });

  describe('testCommunication', () => {
    it('should send PING and handle PONG response', async () => {
      mockChrome.runtime.sendMessage = jest.fn((message, callback) => {
        if (message.type === 'PING' && callback) {
          callback({ type: 'PONG' });
        }
      });

      Object.defineProperty(window, 'location', {
        writable: true,
        configurable: true,
        value: {
          href: 'https://miruro.tv/watch/test',
          hostname: 'miruro.tv',
          pathname: '/watch/test',
        },
      });

      await import('../../content/index');

      await new Promise(resolve => setTimeout(resolve, 100));

      expect(mockChrome.runtime.sendMessage).toHaveBeenCalledWith(
        { type: 'PING' },
        expect.any(Function)
      );
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('Successfully established communication with background script')
      );
    });

    it('should handle communication failure gracefully', async () => {
      mockChrome.runtime.sendMessage = jest.fn((message, callback) => {
        if (callback) {
          mockChrome.runtime.lastError = { message: 'Failed to send message' };
          callback();
        }
      });

      Object.defineProperty(window, 'location', {
        writable: true,
        configurable: true,
        value: {
          href: 'https://miruro.tv/watch/test',
          hostname: 'miruro.tv',
          pathname: '/watch/test',
        },
      });

      await import('../../content/index');

      await new Promise(resolve => setTimeout(resolve, 100));

      // Error should be logged
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to communicate with background script'),
        expect.any(Error)
      );
    });

    it('should handle unexpected response format', async () => {
      mockChrome.runtime.sendMessage = jest.fn((message, callback) => {
        if (message.type === 'PING' && callback) {
          callback({ type: 'UNEXPECTED' });
        }
      });

      Object.defineProperty(window, 'location', {
        writable: true,
        configurable: true,
        value: {
          href: 'https://miruro.tv/watch/test',
          hostname: 'miruro.tv',
          pathname: '/watch/test',
        },
      });

      await import('../../content/index');

      await new Promise(resolve => setTimeout(resolve, 100));

      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('Unexpected response from background'),
        expect.any(Object)
      );
    });
  });
});
