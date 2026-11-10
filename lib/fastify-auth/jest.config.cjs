'use strict';

const baseConfig = require('../../jest.config.base.cjs');

const config = {
  ...baseConfig,
  collectCoverageFrom: [
    '<rootDir>/src/**/*.{ts,tsx}',
  ],
  testMatch: [
    '<rootDir>/spec/**/*.{ts,tsx}'
  ],
  testPathIgnorePatterns: [
    '/node_modules/',
    '<rootDir>/spec/helpers/'
  ]
};

module.exports = config;
