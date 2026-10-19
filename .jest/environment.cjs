'use strict';

const { TestEnvironment } = require('jest-environment-jsdom');

// jsdom lacks some APIs that Node provides, so we borrow Node's. These include
// the Fetch API, which react-router's data routers need. AbortController must
// come from Node too, or Request will reject its signal.
class JSDOMWithNodeAPIsEnvironment extends TestEnvironment {
  constructor(...args) {
    super(...args);

    for (const name of [
      'AbortController',
      'AbortSignal',
      'Headers',
      'Request',
      'Response',
      'TextDecoder',
      'TextEncoder',
      'fetch'
    ]) {
      this.global[name] = globalThis[name];
    }
  }
}

module.exports = JSDOMWithNodeAPIsEnvironment;
