/**
 * Test setup file - runs before all tests
 * Sets up Chrome API mocks and global test utilities
 */

// Mock Chrome APIs
global.chrome = {
  runtime: {
    sendMessage: jest.fn(),
    onMessage: {
      addListener: jest.fn(),
      removeListener: jest.fn(),
      hasListener: jest.fn(),
    },
    onInstalled: {
      addListener: jest.fn(),
    },
    onStartup: {
      addListener: jest.fn(),
    },
    lastError: undefined,
  },
  tabs: {
    sendMessage: jest.fn(),
    onUpdated: {
      addListener: jest.fn(),
    },
    onRemoved: {
      addListener: jest.fn(),
    },
  },
  storage: {
    local: {
      get: jest.fn(),
      set: jest.fn(),
      remove: jest.fn(),
    },
  },
  alarms: {
    create: jest.fn(),
    onAlarm: {
      addListener: jest.fn(),
    },
    clear: jest.fn(),
  },
  scripting: {
    executeScript: jest.fn(),
  },
} as unknown as typeof chrome;

// Mock window.location
Object.defineProperty(window, 'location', {
  writable: true,
  value: {
    href: 'https://miruro.tv/watch/test',
    hostname: 'miruro.tv',
    pathname: '/watch/test',
  },
});

// Suppress console output during tests unless DEBUG is set
if (!process.env.DEBUG) {
  global.console = {
    ...console,
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
  };
}
