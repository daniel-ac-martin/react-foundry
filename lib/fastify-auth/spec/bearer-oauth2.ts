/**
 * @jest-environment node
 */

import type { FastifyInstance } from 'fastify';
import type { Jar } from './helpers/app.js';
import type { MockEntraUser } from './helpers/mock-entra.js';

import { generateKeyPairSync } from 'node:crypto';
import Fastify from 'fastify';
import { AuthMethod, SessionStore, fastifyAuth } from '../src/index.js';
import { createApp as createOIDCApp, signIn, whoami } from './helpers/app.js';
import { base64url, signJwt } from './helpers/common.js';
import { MockEntraProvider } from './helpers/mock-entra.js';
import { MockOIDCProvider } from './helpers/mock-oidc-provider.js';

const audience = 'my-api';

const createApp = async (issuer: string, options: Record<string, unknown> = {}) => {
  const app = Fastify();

  await app.register(fastifyAuth, {
    method: AuthMethod.BearerOAuth2,
    issuer,
    audience,
    ...options
  } as any);

  app.get('/whoami', async (req: any) => req.user || null);

  await app.ready();

  return app;
};

const get = (app: FastifyInstance, token?: string, scheme = 'Bearer') => app.inject({
  method: 'GET',
  url: '/whoami',
  headers: token ? { authorization: `${scheme} ${token}` } : {}
});

describe('Bearer token authentication with OAuth 2.0', () => {
  let op: MockOIDCProvider;
  const now = () => Math.floor(Date.now() / 1000);
  const claims = () => ({
    iss: op.issuer,
    aud: audience,
    sub: 'f6c1d2a0-0000-4000-8000-000000000001',
    iat: now(),
    exp: now() + 300,
    preferred_username: 'alice',
    realm_access: { roles: [ 'admin' ] },
    resource_access: { [audience]: { roles: [ 'editor' ] } },
    scope: 'profile email read'
  });

  beforeAll(async () => {
    op = new MockOIDCProvider({ clientId: 'my-client' });
    await op.start();
  });

  afterAll(async () => {
    await op.stop();
  });

  describe('with privacy', () => {
    let app: FastifyInstance;

    beforeAll(async () => {
      app = await createApp(op.issuer);
    });

    afterAll(async () => {
      await app.close();
    });

    it('accepts a valid token, and reads the user from its claims', async () => {
      const token = op.jwt(claims());
      const res = await get(app, token);

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        provider: 'bearer-oauth2',
        id: 'f6c1d2a0-0000-4000-8000-000000000001',
        username: 'alice',
        roles: [ 'admin', `${audience}:editor` ],
        scopes: [ 'profile', 'email', 'read' ],
        accessToken: token
      });
      expect(new Date(res.json().expiry).getTime()).toBe(claims().exp * 1000);
    });

    it('accepts RFC 9068\'s token type', async () => {
      const res = await get(app, op.jwt(claims(), { typ: 'at+jwt' }));

      expect(res.statusCode).toBe(200);
    });

    it('reads scopes from `scp`, as a string or an array', async () => {
      const { scope: _scope, ...rest } = claims();
      const asString = await get(app, op.jwt({ ...rest, scp: 'read write' }));
      const asArray = await get(app, op.jwt({ ...rest, scp: [ 'read', 'write' ] }));

      expect(asString.json().scopes).toEqual([ 'read', 'write' ]);
      expect(asArray.json().scopes).toEqual([ 'read', 'write' ]);
    });

    it('asks for a token when there isn\'t one', async () => {
      const res = await get(app);

      expect(res.statusCode).toBe(401);
      expect(res.headers['www-authenticate']).toBe('Bearer');
      expect(res.json().code).toBe('FST_BEARER_NO_TOKEN');
    });

    it('asks for a token when the request uses another scheme', async () => {
      const res = await get(app, base64url('alice:secret'), 'Basic');

      expect(res.statusCode).toBe(401);
      expect(res.headers['www-authenticate']).toBe('Bearer');
    });

    it.each([
      [ 'for another API', { aud: 'another-api' } ],
      [ 'from another issuer', { iss: 'https://another-issuer.example' } ],
      [ 'that has expired', { exp: Math.floor(Date.now() / 1000) - 60 } ],
      [ 'that isn\'t valid yet', { nbf: Math.floor(Date.now() / 1000) + 300 } ],
      [ 'without an expiry', { exp: undefined } ]
    ])('rejects a token %s', async (_name, changes) => {
      const res = await get(app, op.jwt({ ...claims(), ...changes }));

      expect(res.statusCode).toBe(401);
      expect(res.headers['www-authenticate']).toMatch(/^Bearer error="invalid_token", error_description=".+"$/);
      expect(res.json().code).toBe('FST_BEARER_INVALID_TOKEN');
    });

    it('rejects a token signed with another key', async () => {
      const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
      const res = await get(app, signJwt(claims(), privateKey));

      expect(res.statusCode).toBe(401);
    });

    it('rejects an unsigned token', async () => {
      const unsigned = `${base64url(JSON.stringify({ alg: 'none', typ: 'JWT' }))}.${base64url(JSON.stringify(claims()))}.`;
      const res = await get(app, unsigned);

      expect(res.statusCode).toBe(401);
    });

    it('rejects a token of another type, such as an ID token for a logout', async () => {
      const res = await get(app, op.jwt(claims(), { typ: 'logout+jwt' }));

      expect(res.statusCode).toBe(401);
    });

    it('has no sign-in or sign-out routes', async () => {
      const token = op.jwt(claims());
      const signInRes = await app.inject({ method: 'GET', url: '/auth/sign-in', headers: { authorization: `Bearer ${token}` } });
      const signOutRes = await app.inject({ method: 'GET', url: '/auth/sign-out', headers: { authorization: `Bearer ${token}` } });

      expect(signInRes.statusCode).toBe(404);
      expect(signOutRes.statusCode).toBe(404);
    });
  });

  describe('without privacy', () => {
    let app: FastifyInstance;

    beforeAll(async () => {
      app = await createApp(op.issuer, { privacy: false });
    });

    afterAll(async () => {
      await app.close();
    });

    it('lets a request without a token through, without a user', async () => {
      const res = await get(app);

      expect(res.statusCode).toBe(200);
      expect(res.json()).toBeNull();
      expect(res.headers['set-cookie']).toBeUndefined();
    });

    it('accepts a valid token', async () => {
      const res = await get(app, op.jwt(claims()));

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ username: 'alice' });
    });

    it('still rejects an invalid token', async () => {
      const res = await get(app, op.jwt({ ...claims(), aud: 'another-api' }));

      expect(res.statusCode).toBe(401);
    });
  });

  describe('with configured claims', () => {
    let app: FastifyInstance;

    beforeAll(async () => {
      app = await createApp(op.issuer, { claims: { id: 'sub', username: 'email' } });
    });

    afterAll(async () => {
      await app.close();
    });

    it('reads the ID and username from them', async () => {
      const res = await get(app, op.jwt({ ...claims(), email: 'alice@example.com' }));

      expect(res.json()).toMatchObject({ id: claims().sub, username: 'alice@example.com' });
    });
  });

  it('refuses to start without an audience', async () => {
    await expect(createApp(op.issuer, { audience: undefined })).rejects.toThrow(/needs an audience/);
  });
});

describe('Bearer token authentication with Entra ID', () => {
  const clientId = '6731de76-14a6-49ae-97bc-6eba6914391e';
  const clientSecret = 'Xq28Q~vZ.jK3_mN9pLr-T4wYbC6dEfGh1sUoIaxn';
  const alice: MockEntraUser = {
    oid: '00000000-0000-4000-8000-00000000a11c',
    preferred_username: 'alice@contoso.example',
    name: 'Alice Example',
    email: 'alice@contoso.example',
    roles: [ 'Indicators.Publish' ]
  };
  let op: MockEntraProvider;
  let web: FastifyInstance;
  let api: FastifyInstance;

  beforeAll(async () => {
    op = new MockEntraProvider({ clientId, clientSecret });
    await op.start();
    web = await createOIDCApp(op.issuer, {
      clientId,
      clientSecret,
      session: { store: SessionStore.Memory, cookies: { secret: 'a-secret-that-is-at-least-32-characters-long' } },
      extra: { extraScopes: [ 'offline_access', `api://${clientId}/access_as_user` ], userinfoScope: false }
    });
    api = await createApp(op.issuer, { audience: clientId });
  });

  afterAll(async () => {
    await web.close();
    await api.close();
    await op.stop();
  });

  it('accepts the token that the web app gets for the API', async () => {
    const jar: Jar = {};
    await signIn(web, op, jar, alice);
    const { accessToken } = await whoami(web, jar);

    const res = await get(api, accessToken);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      id: alice.oid,
      username: 'alice@contoso.example',
      roles: [ 'Indicators.Publish' ],
      scopes: [ 'access_as_user' ]
    });
  });
});
