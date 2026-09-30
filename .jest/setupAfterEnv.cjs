'use strict';

const {
  MessageChannel: NativeMessageChannel,
  MessagePort
} = require('node:worker_threads');
const { TextEncoder, TextDecoder } = require('node:util');

const onmessageDescriptor = Object.getOwnPropertyDescriptor(
  MessagePort.prototype,
  'onmessage'
);

if (
  !onmessageDescriptor
  || typeof onmessageDescriptor.get !== 'function'
  || typeof onmessageDescriptor.set !== 'function'
) {
  throw new Error('Unable to wrap MessagePort.onmessage');
}

const keepPortUnreferenced = (port) => {
  Object.defineProperty(port, 'onmessage', {
    configurable: true,
    enumerable: onmessageDescriptor.enumerable,
    get() {
      return onmessageDescriptor.get.call(this);
    },
    set(handler) {
      onmessageDescriptor.set.call(this, handler);
      this.unref();
    }
  });
  port.unref();
};

class JestMessageChannel extends NativeMessageChannel {
  constructor(...args) {
    super(...args);
    keepPortUnreferenced(this.port1);
    keepPortUnreferenced(this.port2);
  }
}

global.MessageChannel = JestMessageChannel;
global.TextEncoder = TextEncoder;
global.TextDecoder = TextDecoder;
