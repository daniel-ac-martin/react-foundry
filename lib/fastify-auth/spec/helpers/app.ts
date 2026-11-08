import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import type { FastifyAuthOptions } from '../../src/index.js';

import Fastify from 'fastify';
import { AuthMethod, fastifyAuth } from '../../src/index.js';

export const redirectUri = 'https://my-website';

export type Jar = Record<string, string>;

export const updateJar = (jar: Jar, res: LightMyRequestResponse) => {
  (res.cookies as Array<{ name: string, value: string }>).forEach(({ name, value }) => {
    jar[name] = value;
  });
};

export type AppOptions = {
  clientId: string
  clientSecret?: string
  privacy?: boolean
  logs?: string[]
  // Options that the plugin's types don't include yet
  extra?: Record<string, unknown>
};

export const createApp = async (issuer: string, { clientId, clientSecret, privacy = false, logs, extra = {} }: AppOptions) => {
  const app = Fastify({
    logger: logs && {
      level: 'warn',
      stream: { write: (line: string) => logs.push(JSON.parse(line).msg) }
    }
  });

  await app.register(fastifyAuth, {
    privacy,
    session: {
      cookies: {
        secret: 'a-secret-that-is-at-least-32-characters-long'
      }
    },
    method: AuthMethod.OIDC,
    issuer,
    clientId,
    clientSecret,
    redirectUri,
    ...extra
  } as FastifyAuthOptions);

  app.get('/whoami', async (req: any) => req.user || null);

  await app.ready();

  return app;
};

export type Authorizer<U> = {
  authorize: (authorizationUrl: string, user: U) => { code: string, state: string }
};

export const startSignIn = async (app: FastifyInstance, jar: Jar) => {
  const res = await app.inject({ method: 'GET', url: '/auth/sign-in', cookies: jar });
  updateJar(jar, res);

  return res;
};

export const signIn = async <U>(app: FastifyInstance, op: Authorizer<U>, jar: Jar, user: U) => {
  const start = await startSignIn(app, jar);
  const { code, state } = op.authorize(start.headers.location as string, user);
  const callback = await app.inject({
    method: 'GET',
    url: `/auth/callback?code=${code}&state=${state}`,
    cookies: jar
  });
  updateJar(jar, callback);

  return { start, callback };
};

export const whoami = async (app: FastifyInstance, jar: Jar) => {
  const res = await app.inject({ method: 'GET', url: '/whoami', cookies: jar });
  updateJar(jar, res);

  return res.statusCode === 200 ? res.json() : undefined;
};

export const signOut = async (app: FastifyInstance, jar: Jar) => {
  const res = await app.inject({ method: 'GET', url: '/auth/sign-out', cookies: jar });
  updateJar(jar, res);

  return res;
};
