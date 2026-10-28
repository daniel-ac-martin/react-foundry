/**
 * @jest-environment node
 */

import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import type { MockUser } from './helpers/mock-oidc-provider.js';

import Fastify from 'fastify';
import { AuthMethod, fastifyAuth } from '../src/index.js';
import { MockOIDCProvider } from './helpers/mock-oidc-provider.js';

const clientId = 'my-client';
const clientSecret = 'my-client-secret';
const redirectUri = 'https://my-website';

const alice: MockUser = {
  sub: 'f6c1d2a0-0000-4000-8000-000000000001',
  preferred_username: 'alice',
  name: 'Alice Example',
  given_name: 'Alice',
  family_name: 'Example',
  email: 'alice@example.com',
  realm_access: { roles: [ 'admin' ] },
  resource_access: { [clientId]: { roles: [ 'editor' ] } }
};

type Jar = Record<string, string>;

const updateJar = (jar: Jar, res: LightMyRequestResponse) => {
  (res.cookies as Array<{ name: string, value: string }>).forEach(({ name, value }) => {
    jar[name] = value;
  });
};

const createApp = async (issuer: string, options: { clientSecret?: string, privacy?: boolean } = {}) => {
  const app = Fastify();

  await app.register(fastifyAuth, {
    privacy: options.privacy ?? false,
    session: {
      cookies: {
        secret: 'a-secret-that-is-at-least-32-characters-long'
      }
    },
    method: AuthMethod.OIDC,
    issuer,
    clientId,
    clientSecret: options.clientSecret,
    redirectUri
  });

  app.get('/whoami', async (req: any) => req.user || null);

  await app.ready();

  return app;
};

const signIn = async (app: FastifyInstance, op: MockOIDCProvider, jar: Jar, user: MockUser = alice) => {
  const start = await app.inject({ method: 'GET', url: '/auth/sign-in', cookies: jar });
  updateJar(jar, start);

  const { code, state } = op.authorize(start.headers.location as string, user);
  const callback = await app.inject({
    method: 'GET',
    url: `/auth/callback?code=${code}&state=${state}`,
    cookies: jar
  });
  updateJar(jar, callback);

  return { start, callback };
};

const whoami = async (app: FastifyInstance, jar: Jar) => {
  const res = await app.inject({ method: 'GET', url: '/whoami', cookies: jar });
  updateJar(jar, res);

  return res.json();
};

describe('OIDC authentication', () => {
  describe('with a confidential client', () => {
    let op: MockOIDCProvider;
    let app: FastifyInstance;
    let jar: Jar;

    beforeAll(async () => {
      op = new MockOIDCProvider({ clientId, clientSecret });
      await op.start();
      app = await createApp(op.issuer, { clientSecret });
    });

    afterAll(async () => {
      await app.close();
      await op.stop();
    });

    beforeEach(() => {
      jar = {};
      op.accessTokenTTL = 300;
      op.refreshTokenTTL = 1800;
      op.tokenRequests.length = 0;
      op.userinfoRequests.length = 0;
    });

    describe('signing in', () => {
      it('redirects to the authorization endpoint with PKCE and state', async () => {
        const res = await app.inject({ method: 'GET', url: '/auth/sign-in' });
        const location = new URL(res.headers.location as string);

        expect(res.statusCode).toBe(302);
        expect(location.origin + location.pathname).toBe(`${op.issuer}/protocol/openid-connect/auth`);
        expect(location.searchParams.get('client_id')).toBe(clientId);
        expect(location.searchParams.get('response_type')).toBe('code');
        expect(location.searchParams.get('scope')).toBe('openid');
        expect(location.searchParams.get('redirect_uri')).toBe(`${redirectUri}/auth/callback`);
        expect(location.searchParams.get('code_challenge_method')).toBe('S256');
        expect(location.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(location.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]+$/);
      });

      it('uses a different state and challenge each time', async () => {
        const a = new URL((await app.inject({ method: 'GET', url: '/auth/sign-in' })).headers.location as string);
        const b = new URL((await app.inject({ method: 'GET', url: '/auth/sign-in' })).headers.location as string);

        expect(a.searchParams.get('state')).not.toBe(b.searchParams.get('state'));
        expect(a.searchParams.get('code_challenge')).not.toBe(b.searchParams.get('code_challenge'));
      });

      it('stores the PKCE verifier and state in a session cookie', async () => {
        const res = await app.inject({ method: 'GET', url: '/auth/sign-in' });
        updateJar(jar, res);

        expect(jar.session).toBeDefined();
      });
    });

    describe('the callback', () => {
      it('redirects to the home page', async () => {
        const { callback } = await signIn(app, op, jar);

        expect(callback.statusCode).toBe(302);
        expect(callback.headers.location).toBe('/');
      });

      it('exchanges the code using client_secret_basic and the PKCE verifier', async () => {
        await signIn(app, op, jar);

        expect(op.tokenRequests).toHaveLength(1);

        const [ { authorization, params } ] = op.tokenRequests;

        expect(authorization).toBe('Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64'));
        expect(params.grant_type).toBe('authorization_code');
        expect(params.redirect_uri).toBe(`${redirectUri}/auth/callback`);
        expect(params.code_verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
        expect(params.client_secret).toBeUndefined();
      });

      it('fetches the userinfo with the access token', async () => {
        await signIn(app, op, jar);

        expect(op.userinfoRequests).toHaveLength(1);
        expect(op.userinfoRequests[0].authorization).toMatch(/^Bearer [^.]+\.[^.]+\.[^.]+$/);
      });

      it('rejects a mismatched state', async () => {
        const start = await app.inject({ method: 'GET', url: '/auth/sign-in' });
        updateJar(jar, start);

        const { code } = op.authorize(start.headers.location as string, alice);
        const callback = await app.inject({
          method: 'GET',
          url: `/auth/callback?code=${code}&state=not-the-state`,
          cookies: jar
        });
        updateJar(jar, callback);

        expect(callback.statusCode).toBeGreaterThanOrEqual(400);
        expect(op.tokenRequests).toHaveLength(0);
        expect(await whoami(app, jar)).toBeNull();
      });

      it('rejects an error response from the provider', async () => {
        const start = await app.inject({ method: 'GET', url: '/auth/sign-in' });
        updateJar(jar, start);

        const state = new URL(start.headers.location as string).searchParams.get('state');
        const callback = await app.inject({
          method: 'GET',
          url: `/auth/callback?error=access_denied&state=${state}`,
          cookies: jar
        });
        updateJar(jar, callback);

        expect(callback.statusCode).toBeGreaterThanOrEqual(400);
        expect(op.tokenRequests).toHaveLength(0);
        expect(await whoami(app, jar)).toBeNull();
      });

      it('rejects a callback without a sign-in session', async () => {
        const callback = await app.inject({ method: 'GET', url: '/auth/callback?code=abc&state=xyz' });

        expect(callback.statusCode).toBe(409);
        expect(op.tokenRequests).toHaveLength(0);
      });

      it('cannot be replayed', async () => {
        const start = await app.inject({ method: 'GET', url: '/auth/sign-in' });
        updateJar(jar, start);

        const { code, state } = op.authorize(start.headers.location as string, alice);
        const url = `/auth/callback?code=${code}&state=${state}`;
        const replayJar = { ...jar };

        await app.inject({ method: 'GET', url, cookies: jar });
        const replay = await app.inject({ method: 'GET', url, cookies: replayJar });

        expect(replay.statusCode).toBeGreaterThanOrEqual(400);
      });
    });

    describe('once signed in', () => {
      it('provides the user profile', async () => {
        await signIn(app, op, jar);

        const user = await whoami(app, jar);

        expect(user).toMatchObject({
          provider: 'oidc',
          id: alice.sub,
          username: 'alice',
          displayName: 'Alice Example',
          name: {
            givenName: 'Alice',
            familyName: 'Example'
          },
          emails: [ { value: 'alice@example.com' } ],
          roles: [ 'admin', `${clientId}:editor` ],
          accessTokenValid: true,
          refreshTokenValid: true,
          idTokenValid: true,
          userinfo: {
            sub: alice.sub,
            preferred_username: 'alice',
            email: 'alice@example.com'
          }
        });
        expect(user.accessToken).toEqual(expect.any(String));
        expect(user.refreshToken).toEqual(expect.any(String));
        expect(user.idToken).toEqual(expect.any(String));
      });

      it('renews an expired access token using the refresh token', async () => {
        op.accessTokenTTL = -10;
        await signIn(app, op, jar);
        op.accessTokenTTL = 300;

        const before = op.tokenRequests.length;
        const user = await whoami(app, jar);

        expect(op.tokenRequests).toHaveLength(before + 1);

        const { authorization, params } = op.tokenRequests[before];

        expect(authorization).toBe('Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64'));
        expect(params.grant_type).toBe('refresh_token');
        expect(user).toMatchObject({
          username: 'alice',
          accessTokenValid: true
        });
      });

      it('signs the user out when the refresh token has also expired', async () => {
        op.accessTokenTTL = -10;
        op.refreshTokenTTL = -10;
        await signIn(app, op, jar);

        const before = op.tokenRequests.length;

        expect(await whoami(app, jar)).toBeNull();
        expect(op.tokenRequests).toHaveLength(before);
      });

      it('signs the user out when the provider refuses to renew the token', async () => {
        op.accessTokenTTL = -10;
        await signIn(app, op, jar);
        op.revokeRefreshTokens();

        expect(await whoami(app, jar)).toBeNull();
      });
    });

    describe('signing out', () => {
      it('redirects to the end session endpoint', async () => {
        await signIn(app, op, jar);

        const res = await app.inject({ method: 'GET', url: '/auth/sign-out', cookies: jar });
        updateJar(jar, res);

        const location = new URL(res.headers.location as string);

        expect(res.statusCode).toBe(302);
        expect(location.origin + location.pathname).toBe(`${op.issuer}/protocol/openid-connect/logout`);
        expect(location.searchParams.get('client_id')).toBe(clientId);
        expect(location.searchParams.get('post_logout_redirect_uri')).toBe(redirectUri);
      });

      it('ends the local session', async () => {
        await signIn(app, op, jar);

        const res = await app.inject({ method: 'GET', url: '/auth/sign-out', cookies: jar });
        updateJar(jar, res);

        expect(await whoami(app, jar)).toBeNull();
      });
    });
  });

  describe('with a public client', () => {
    let op: MockOIDCProvider;
    let app: FastifyInstance;

    beforeAll(async () => {
      op = new MockOIDCProvider({ clientId });
      await op.start();
      app = await createApp(op.issuer);
    });

    afterAll(async () => {
      await app.close();
      await op.stop();
    });

    it('exchanges the code without a client secret', async () => {
      const jar: Jar = {};
      await signIn(app, op, jar);

      const [ { authorization, params } ] = op.tokenRequests;

      expect(authorization).toBeUndefined();
      expect(params.client_id).toBe(clientId);
      expect(params.client_secret).toBeUndefined();
      expect(await whoami(app, jar)).toMatchObject({ username: 'alice' });
    });
  });

  describe('in privacy mode', () => {
    let op: MockOIDCProvider;
    let app: FastifyInstance;

    beforeAll(async () => {
      op = new MockOIDCProvider({ clientId, clientSecret });
      await op.start();
      app = await createApp(op.issuer, { clientSecret, privacy: true });
    });

    afterAll(async () => {
      await app.close();
      await op.stop();
    });

    it('redirects unauthenticated users to the provider', async () => {
      const res = await app.inject({ method: 'GET', url: '/whoami' });
      const location = new URL(res.headers.location as string);

      expect(res.statusCode).toBe(302);
      expect(location.origin + location.pathname).toBe(`${op.issuer}/protocol/openid-connect/auth`);
    });
  });

  describe('when the issuer cannot be discovered', () => {
    it('fails to start', async () => {
      const op = new MockOIDCProvider({ clientId, clientSecret });
      const issuer = await op.start();
      await op.stop();

      await expect(createApp(issuer, { clientSecret })).rejects.toThrow();
    });
  });
});
