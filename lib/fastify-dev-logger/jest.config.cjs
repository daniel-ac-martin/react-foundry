'use strict';

const baseConfig = require('../../jest.config.base.cjs');

const config = {
  ...baseConfig,
  collectCoverageFrom: [
    '<rootDir>/src/**/*.js',
  ],
  testMatch: [
    '<rootDir>/spec/**/*.js'
  ]
};

module.exports = config;
