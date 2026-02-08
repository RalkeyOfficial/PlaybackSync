// Background service worker entry point

import type { ContentMessage, BackgroundMessage } from '../types/messages';

/**
 * Structured logging helper for background service worker
 * Uses console methods with structured objects for better debugging
 */
const logger = {
  info: (message: string, data?: Record<string, unknown>) => {
    console.log(`[PlaybackSync] ${message}`, data || {});
  },
  warn: (message: string, data?: Record<string, unknown>) => {
    console.warn(`[PlaybackSync] ${message}`, data || {});
  },
  error: (message: string, error?: Error | unknown, data?: Record<string, unknown>) => {
    const errorData =
      error instanceof Error
        ? { error: error.message, stack: error.stack, ...data }
        : { error, ...data };
    console.error(`[PlaybackSync] ${message}`, errorData);
  },
};

/**
 * Handle extension installation
 */
chrome.runtime.onInstalled.addListener(details => {
  logger.info('Extension installed', {
    reason: details.reason,
    previousVersion: details.previousVersion,
  });
});

/**
 * Handle browser startup
 */
chrome.runtime.onStartup.addListener(() => {
  logger.info('Extension started on browser startup');
});

/**
 * Handle service worker errors
 */
addEventListener('error', (event: ErrorEvent) => {
  logger.error('Service worker error', event.error, {
    message: event.message,
    filename: event.filename,
    lineno: event.lineno,
    colno: event.colno,
  });
});

/**
 * Handle unhandled promise rejections
 */
addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
  logger.error('Unhandled promise rejection', event.reason);
  // Don't prevent default handling to allow Chrome DevTools to show the error
});

/**
 * Handle messages from content scripts
 */
chrome.runtime.onMessage.addListener((message: ContentMessage, sender, sendResponse) => {
  logger.info('Received message from content script', {
    type: message.type,
    tabId: sender.tab?.id,
    url: sender.tab?.url,
  });

  try {
    // Handle PING test message
    if (message.type === 'PING') {
      logger.info('Responding to PING with PONG');
      sendResponse({ type: 'PONG' } satisfies BackgroundMessage);
      return true;
    }

    // Handle playback intent (will be implemented in later steps)
    if (message.type === 'PLAYBACK_INTENT') {
      logger.info('Received playback intent', { data: message.data });
      sendResponse({ success: true });
      return true;
    }

    // Handle content identity (will be implemented in later steps)
    if (message.type === 'CONTENT_IDENTITY') {
      logger.info('Received content identity', { data: message.data });
      sendResponse({ success: true });
      return true;
    }

    // Handle episode change request (will be implemented in later steps)
    if (message.type === 'EPISODE_CHANGE_REQUEST') {
      logger.info('Received episode change request', { data: message.data });
      sendResponse({ success: true });
      return true;
    }

    logger.warn('Unknown message type from content script', { type: message.type });
    sendResponse({ success: false, error: 'Unknown message type' });
    return true;
  } catch (error) {
    logger.error('Error handling message from content script', error, {
      type: message.type,
      tabId: sender.tab?.id,
    });
    sendResponse({ success: false, error: 'Internal error' });
    return true;
  }
});

// Log that service worker has initialized
logger.info('Background service worker initialized');
