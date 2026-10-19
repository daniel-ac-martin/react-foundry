'use strict';

const { TestEnvironment } = require('jest-environment-jsdom');

// jsdom lacks the Fetch API, which react-router's data routers need, so we
// borrow Node's. AbortController must come from Node too, or Request will
// reject its signal.
class JSDOMWithFetchEnvironment extends TestEnvironment {
  constructor(...args) {
    super(...args);

    for (const name of [ 'AbortController', 'AbortSignal', 'Headers', 'Request', 'Response', 'fetch' ]) {
      this.global[name] = globalThis[name];
    }
  }
}

module.exports = JSDOMWithFetchEnvironment;
