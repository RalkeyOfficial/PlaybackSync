/**
 * Jest setup file - runs before all tests
 * Sets up test environment variables before any modules are imported
 */

import { TEST_CONFIG } from './helpers/fixtures';

// Set SERVER_SECRET before any modules that require it are imported
process.env.SERVER_SECRET = TEST_CONFIG.SERVER_SECRET;
process.env.PORT = TEST_CONFIG.PORT;
process.env.LOG_LEVEL = TEST_CONFIG.LOG_LEVEL;
process.env.NODE_ENV = TEST_CONFIG.NODE_ENV;
