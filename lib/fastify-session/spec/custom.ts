/**
 * @jest-environment node
 */

import type { FastifyInstance } from 'fastify';
import type { ReadFunction, WriteFunction } from '../src/common.js';

import Fastify from 'fastify';
import { SessionStore, fastifySession } from '../src/index.js';

const createApp = async (read: ReadFunction, write: WriteFunction) => {
  const app = Fastify();

  await app.register(fastifySession, {
    store: SessionStore.Custom,
    read,
    write,
    cookies: {
      secret: 'a-secret-that-is-at-least-32-characters-long'
    }
  });

  app.get('/count', async (req: any) => {
    req.session.count = (req.session.count || 0) + 1;

    return req.session.count;
  });

  await app.ready();

  return app;
};

describe('A custom session store', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app.close();
  });

  it('saves the session before the response is sent', async () => {
    let saved = false;
    const write: WriteFunction = async () => {
      await new Promise(resolve => setTimeout(resolve, 20));
      saved = true;
    };

    app = await createApp(() => ({}), write);

    const res = await app.inject({ method: 'GET', url: '/count' });

    expect(res.statusCode).toBe(200);
    expect(saved).toBe(true);
  });

  it('responds with an error when the session can\'t be saved', async () => {
    const write: WriteFunction = async () => {
      throw new Error('The store is down');
    };

    app = await createApp(() => ({}), write);

    const res = await app.inject({ method: 'GET', url: '/count' });

    expect(res.statusCode).toBe(500);
  });

  it('doesn\'t read the store without a session cookie', async () => {
    const reads: string[] = [];

    app = await createApp(id => {
      reads.push(id);

      return {};
    }, () => {});

    await app.inject({ method: 'GET', url: '/count' });

    expect(reads).toEqual([]);
  });
});
