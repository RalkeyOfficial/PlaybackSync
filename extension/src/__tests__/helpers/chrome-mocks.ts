/**
 * Helper utilities for mocking Chrome APIs in tests
 */

import type { ContentMessage, BackgroundMessage } from '../../types/messages';

/**
 * Create a mock Tab with default values
 * Provides all required Tab properties with sensible defaults
 */
export function createMockTab(overrides?: Partial<chrome.tabs.Tab>): chrome.tabs.Tab {
  return {
    id: 1,
    url: 'https://miruro.tv/watch/test',
    index: 0,
    windowId: 1,
    highlighted: false,
    active: false,
    pinned: false,
    incognito: false,
    selected: false, // deprecated but required by type
    status: 'complete',
    title: 'Test Tab',
    discarded: false,
    groupId: 0,
    autoDiscardable: true,
    // Optional fields
    favIconUrl: undefined,
    audible: undefined,
    mutedInfo: undefined,
    openerTabId: undefined,
    pendingUrl: undefined,
    ...overrides,
  };
}

/**
 * Create a mock MessageSender for testing
 */
export function createMockSender(
  overrides?: Omit<chrome.runtime.MessageSender, 'tab'> & { tab?: Partial<chrome.tabs.Tab> }
): chrome.runtime.MessageSender {
  const baseTab = createMockTab(overrides?.tab);

  return {
    ...overrides,
    tab: baseTab,
  };
}

/**
 * Mock Chrome runtime sendMessage implementation
 * Stores sent messages and allows tests to simulate responses
 */
export class MockChromeRuntime {
  private sentMessages: Array<{
    message: ContentMessage;
    callback: (response?: BackgroundMessage) => void;
  }> = [];

  private messageListeners: Array<
    (
      message: ContentMessage | BackgroundMessage,
      sender: chrome.runtime.MessageSender,
      sendResponse: (response?: unknown) => void
    ) => boolean | void
  > = [];

  /**
   * Mock implementation of chrome.runtime.sendMessage
   */
  sendMessage(
    message: ContentMessage | BackgroundMessage,
    callback?: (response?: BackgroundMessage | ContentMessage) => void
  ): void {
    if (callback) {
      this.sentMessages.push({
        message: message as ContentMessage,
        callback: callback as (response?: BackgroundMessage) => void,
      });
    }
  }

  /**
   * Simulate receiving a message (triggers registered listeners)
   */
  simulateMessage(
    message: ContentMessage | BackgroundMessage,
    sender: chrome.runtime.MessageSender = createMockSender()
  ): void {
    this.messageListeners.forEach(listener => {
      let response: unknown;
      const sendResponse = (resp?: unknown) => {
        response = resp;
      };
      const result = listener(message, sender, sendResponse);
      // If listener returns true, it will send response asynchronously
      if (result !== true && response !== undefined) {
        // Synchronous response
      }
    });
  }

  /**
   * Simulate response to a sent message
   */
  respondToMessage(index: number, response: BackgroundMessage | ContentMessage): void {
    if (this.sentMessages[index]) {
      this.sentMessages[index].callback(response as BackgroundMessage);
    }
  }

  /**
   * Get all sent messages
   */
  getSentMessages(): ContentMessage[] {
    return this.sentMessages.map(m => m.message);
  }

  /**
   * Clear all sent messages
   */
  clearSentMessages(): void {
    this.sentMessages = [];
  }

  /**
   * Register a message listener (simulates chrome.runtime.onMessage.addListener)
   */
  addListener(
    listener: (
      message: ContentMessage | BackgroundMessage,
      sender: chrome.runtime.MessageSender,
      sendResponse: (response?: unknown) => void
    ) => boolean | void
  ): void {
    this.messageListeners.push(listener);
  }

  /**
   * Clear all listeners
   */
  clearListeners(): void {
    this.messageListeners = [];
  }

  /**
   * Simulate chrome.runtime.lastError
   */
  setLastError(error: string | undefined): void {
    (global.chrome.runtime as { lastError?: { message: string } }).lastError = error
      ? { message: error }
      : undefined;
  }
}
