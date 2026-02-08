/**
 * Jest configuration for extension testing
 */
/* eslint-disable */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'jsdom',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.ts', '**/?(*.)+(spec|test).ts'],
  transform: {
    '^.+\\.ts$': 'ts-jest',
  },
  setupFilesAfterEnv: ['<rootDir>/src/__tests__/setup.ts'],
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.d.ts', '!src/**/__tests__/**', '!src/index.ts'],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  verbose: true,
  testTimeout: 10000,
  globals: {
    'ts-jest': {
      tsconfig: {
        lib: ['ES2022', 'DOM'],
        types: ['chrome', 'jest', 'node'],
      },
    },
  },
};
