// Content script entry point

import type { ContentMessage, BackgroundMessage } from '../types/messages';

/**
 * Structured logging helper for content script
 */
const logger = {
  info: (message: string, data?: Record<string, unknown>) => {
    console.log(`[PlaybackSync Content] ${message}`, data || {});
  },
  warn: (message: string, data?: Record<string, unknown>) => {
    console.warn(`[PlaybackSync Content] ${message}`, data || {});
  },
  error: (message: string, error?: Error | unknown, data?: Record<string, unknown>) => {
    const errorData =
      error instanceof Error
        ? { error: error.message, stack: error.stack, ...data }
        : { error, ...data };
    console.error(`[PlaybackSync Content] ${message}`, errorData);
  },
};

/**
 * Send a message to the background script
 */
function sendToBackground(message: ContentMessage): Promise<BackgroundMessage | undefined> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, response => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response);
    });
  });
}

/**
 * Handle messages from background script
 */
chrome.runtime.onMessage.addListener((message: BackgroundMessage, _sender, sendResponse) => {
  logger.info('Received message from background', { type: message.type });

  // Handle PONG response
  if (message.type === 'PONG') {
    logger.info('Received PONG from background');
    sendResponse({ success: true });
    return true;
  }

  // Handle playback commands (will be implemented in later steps)
  if (message.type === 'PLAYBACK_COMMAND') {
    logger.info('Received playback command', { data: message.data });
    sendResponse({ success: true });
    return true;
  }

  logger.warn('Unknown message type', { type: message.type });
  sendResponse({ success: false, error: 'Unknown message type' });
  return true;
});

/**
 * Send a test ping message to verify communication
 */
async function testCommunication() {
  try {
    logger.info('Sending PING to background script');
    const response = await sendToBackground({ type: 'PING' });
    if (response?.type === 'PONG') {
      logger.info('Successfully established communication with background script');
    } else {
      logger.warn('Unexpected response from background', { response });
    }
  } catch (error) {
    logger.error('Failed to communicate with background script', error);
  }
}

// Verify we're on a supported domain
const currentUrl = new URL(window.location.href);
const supportedDomains = ['miruro.tv', 'miruro.to'];
const isSupportedDomain = supportedDomains.some(
  domain => currentUrl.hostname === domain || currentUrl.hostname.endsWith(`.${domain}`)
);

if (isSupportedDomain) {
  logger.info('Content script loaded on supported domain', {
    hostname: currentUrl.hostname,
    pathname: currentUrl.pathname,
  });

  // Test communication on load
  testCommunication();
} else {
  logger.warn('Content script loaded on unsupported domain', {
    hostname: currentUrl.hostname,
  });
}
