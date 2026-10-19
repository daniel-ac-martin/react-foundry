'use strict';

const baseConfig = require('../../jest.config.base.cjs');

const config = {
  ...baseConfig,
  testEnvironment: '<rootDir>/jest.environment.cjs',
  collectCoverageFrom: [
    '<rootDir>/src/**.{ts,tsx}',
  ],
  testMatch: [
    '<rootDir>/spec/**.{ts,tsx}'
  ]
};

module.exports = config;
