/**
 * Test data fixtures for use in tests
 */

/**
 * Default test configuration values
 */
export const TEST_CONFIG = {
  SERVER_SECRET: 'test-secret-key-for-testing-only',
  PORT: '8080',
  LOG_LEVEL: 'info',
  NODE_ENV: 'test',
} as const;

/**
 * Set up test environment variables
 * Call this in beforeEach or beforeAll hooks
 */
export function setupTestEnv(): void {
  process.env.SERVER_SECRET = TEST_CONFIG.SERVER_SECRET;
  process.env.PORT = TEST_CONFIG.PORT;
  process.env.LOG_LEVEL = TEST_CONFIG.LOG_LEVEL;
  process.env.NODE_ENV = TEST_CONFIG.NODE_ENV;
}

/**
 * Clean up test environment variables
 * Call this in afterEach or afterAll hooks
 */
export function cleanupTestEnv(): void {
  delete process.env.SERVER_SECRET;
  delete process.env.PORT;
  delete process.env.LOG_LEVEL;
  delete process.env.NODE_ENV;
}
