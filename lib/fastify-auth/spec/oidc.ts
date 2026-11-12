/**
 * @jest-environment node
 */

import type { FastifyInstance } from 'fastify';
import type { KeyObject } from 'node:crypto';
import type { AppOptions, Jar } from './helpers/app.js';
import type { MockUser } from './helpers/mock-oidc-provider.js';

import { generateKeyPairSync } from 'node:crypto';
import { createApp as _createApp, later, redirectUri, signIn as _signIn, startSignIn, updateJar, whoami } from './helpers/app.js';
import { SessionStore } from '../src/index.js';
import { basicCredentials, decodeJwt } from './helpers/common.js';
import { MockOIDCProvider } from './helpers/mock-oidc-provider.js';

const clientId = 'my-client';
const clientSecret = 'my-client-secret';

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

const createApp = (issuer: string, options: Omit<AppOptions, 'clientId'> = {}) => _createApp(issuer, { clientId, ...options });

const signIn = (app: FastifyInstance, op: MockOIDCProvider, jar: Jar) => _signIn(app, op, jar, alice);

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
        expect(location.searchParams.get('scope')).toBe('openid profile email');
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

      it('sends a nonce, which differs each time', async () => {
        const a = new URL((await app.inject({ method: 'GET', url: '/auth/sign-in' })).headers.location as string);
        const b = new URL((await app.inject({ method: 'GET', url: '/auth/sign-in' })).headers.location as string);

        expect(a.searchParams.get('nonce')).toMatch(/^[A-Za-z0-9_-]{43,}$/);
        expect(a.searchParams.get('nonce')).not.toBe(b.searchParams.get('nonce'));
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

        expect(basicCredentials(authorization)).toEqual([ clientId, clientSecret ]);
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

        expect(callback.statusCode).toBe(400);
        expect(op.tokenRequests).toHaveLength(0);
        expect(await whoami(app, jar)).toBeNull();
      });

      it('reports a cancelled sign-in as not signed in', async () => {
        const start = await app.inject({ method: 'GET', url: '/auth/sign-in' });
        updateJar(jar, start);

        const state = new URL(start.headers.location as string).searchParams.get('state');
        const callback = await app.inject({
          method: 'GET',
          url: `/auth/callback?error=access_denied&state=${state}`,
          cookies: jar
        });
        updateJar(jar, callback);

        expect(callback.statusCode).toBe(401);
        expect(callback.json().code).toBe('FST_OIDC_NOT_SIGNED_IN');
        expect(op.tokenRequests).toHaveLength(0);
        expect(await whoami(app, jar)).toBeNull();
      });

      it('rejects an ID token issued with a different nonce', async () => {
        const start = await app.inject({ method: 'GET', url: '/auth/sign-in' });
        updateJar(jar, start);

        const url = new URL(start.headers.location as string);
        url.searchParams.set('nonce', 'not-the-nonce');

        const { code, state } = op.authorize(url.href, alice);
        const callback = await app.inject({
          method: 'GET',
          url: `/auth/callback?code=${code}&state=${state}`,
          cookies: jar
        });
        updateJar(jar, callback);

        expect(callback.statusCode).toBe(400);
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

        expect(replay.statusCode).toBe(400);
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
          idTokenValid: true
        });
        expect(user.accessToken).toEqual(expect.any(String));
        expect(user.refreshToken).toEqual(expect.any(String));
        expect(user.idToken).toEqual(expect.any(String));
      });

      it('takes token expiry times from the token response', async () => {
        const start = Math.floor(Date.now() / 1000);
        await signIn(app, op, jar);

        const user = await whoami(app, jar);

        expect(user.accessTokenExp - start).toBeGreaterThanOrEqual(op.accessTokenTTL);
        expect(user.accessTokenExp - start).toBeLessThanOrEqual(op.accessTokenTTL + 1);
        expect(user.refreshTokenExp - start).toBeGreaterThanOrEqual(op.refreshTokenTTL);
        expect(user.refreshTokenExp - start).toBeLessThanOrEqual(op.refreshTokenTTL + 1);
        expect(new Date(user.expiry).getTime()).toBe(user.refreshTokenExp * 1000);
      });

      it('renews an expired access token using the refresh token', async () => {
        await signIn(app, op, jar);

        const before = op.tokenRequests.length;
        const user = await later(op.accessTokenTTL, () => whoami(app, jar));

        expect(op.tokenRequests).toHaveLength(before + 1);

        const { authorization, params } = op.tokenRequests[before];

        expect(basicCredentials(authorization)).toEqual([ clientId, clientSecret ]);
        expect(params.grant_type).toBe('refresh_token');
        expect(user).toMatchObject({
          username: 'alice',
          accessTokenValid: true
        });
      });

      it('signs the user out when the refresh token has also expired', async () => {
        await signIn(app, op, jar);

        const before = op.tokenRequests.length;

        expect(await later(op.refreshTokenTTL, () => whoami(app, jar))).toBeNull();
        expect(op.tokenRequests).toHaveLength(before);
      });

      it('signs the user out when the provider refuses to renew the token', async () => {
        await signIn(app, op, jar);
        op.revokeRefreshTokens();

        expect(await later(op.accessTokenTTL, () => whoami(app, jar))).toBeNull();
      });

      it('keeps the refresh token when the provider does not issue a new one', async () => {
        op.rotateRefreshTokens = false;

        try {
          await signIn(app, op, jar);

          const first = await later(op.accessTokenTTL, () => whoami(app, jar));
          const second = await later(op.accessTokenTTL * 2, () => whoami(app, jar));

          expect(first).toMatchObject({ username: 'alice', accessTokenValid: true });
          expect(second).toMatchObject({ username: 'alice', accessTokenValid: true, refreshToken: first.refreshToken });
          expect(op.tokenRequests.filter(({ params }) => params.grant_type === 'refresh_token')).toHaveLength(2);
        } finally {
          op.rotateRefreshTokens = true;
        }
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

      it('sends id_token_hint', async () => {
        await signIn(app, op, jar);

        const res = await app.inject({ method: 'GET', url: '/auth/sign-out', cookies: jar });
        const location = new URL(res.headers.location as string);

        expect(decodeJwt(location.searchParams.get('id_token_hint') as string).payload).toMatchObject({ sub: alice.sub, aud: clientId });
      });

      it('leaves out id_token_hint when nobody is signed in', async () => {
        const res = await app.inject({ method: 'GET', url: '/auth/sign-out' });
        const location = new URL(res.headers.location as string);

        expect(location.searchParams.has('id_token_hint')).toBe(false);
      });

      it('ends the local session', async () => {
        await signIn(app, op, jar);

        const res = await app.inject({ method: 'GET', url: '/auth/sign-out', cookies: jar });
        updateJar(jar, res);

        expect(await whoami(app, jar)).toBeNull();
      });
    });
  });

  describe('with a server-side session', () => {
    let op: MockOIDCProvider;
    let app: FastifyInstance;

    beforeAll(async () => {
      op = new MockOIDCProvider({ clientId, clientSecret });
      await op.start();
      app = await createApp(op.issuer, {
        clientSecret,
        session: {
          store: SessionStore.Memory,
          cookies: { secret: 'a-secret-that-is-at-least-32-characters-long' }
        }
      });
    });

    afterAll(async () => {
      await app.close();
      await op.stop();
    });

    it('keeps the userinfo and the token expiry times', async () => {
      const jar: Jar = {};
      await signIn(app, op, jar);

      expect(await whoami(app, jar)).toMatchObject({
        username: 'alice',
        accessTokenExp: expect.any(Number),
        refreshTokenExp: expect.any(Number),
        userinfo: {
          sub: alice.sub,
          preferred_username: 'alice',
          email: 'alice@example.com'
        }
      });
    });
  });

  describe('with opaque access and refresh tokens', () => {
    let op: MockOIDCProvider;
    let app: FastifyInstance;
    let jar: Jar;

    beforeAll(async () => {
      op = new MockOIDCProvider({ clientId, clientSecret });
      op.opaqueTokens = true;
      await op.start();
      app = await createApp(op.issuer, { clientSecret });
    });

    afterAll(async () => {
      await app.close();
      await op.stop();
    });

    beforeEach(() => {
      jar = {};
      op.sendRefreshExpiresIn = true;
      op.tokenRequests.length = 0;
    });

    it('signs the user in from the ID token and userinfo', async () => {
      const { callback } = await signIn(app, op, jar);

      expect(callback.statusCode).toBe(302);
      expect(await whoami(app, jar)).toMatchObject({
        id: alice.sub,
        username: 'alice',
        accessTokenValid: true,
        refreshTokenValid: true
      });
    });

    it('renews an expired access token using the refresh token', async () => {
      await signIn(app, op, jar);

      expect(await later(op.accessTokenTTL, () => whoami(app, jar))).toMatchObject({ username: 'alice', accessTokenValid: true });
      expect(op.tokenRequests.at(-1)?.params.grant_type).toBe('refresh_token');
    });

    describe('when the refresh token\'s lifetime is unknown', () => {
      beforeEach(() => {
        op.sendRefreshExpiresIn = false;
      });

      it('leaves the session\'s expiry unknown', async () => {
        await signIn(app, op, jar);

        expect((await whoami(app, jar)).expiry).toBeUndefined();
      });

      it('tries the refresh token until the provider refuses it', async () => {
        await signIn(app, op, jar);

        const before = op.tokenRequests.length;

        expect(await later(op.refreshTokenTTL, () => whoami(app, jar))).toBeNull();
        expect(op.tokenRequests[before]?.params.grant_type).toBe('refresh_token');
      });
    });
  });

  describe('when the provider leaves out expires_in', () => {
    let op: MockOIDCProvider;
    let app: FastifyInstance;
    let logs: string[];

    beforeAll(async () => {
      op = new MockOIDCProvider({ clientId, clientSecret });
      op.sendExpiresIn = false;
      await op.start();
      logs = [];
      app = await createApp(op.issuer, { clientSecret, logs });
    });

    afterAll(async () => {
      await app.close();
      await op.stop();
    });

    beforeEach(() => {
      op.opaqueTokens = false;
      op.tokenRequests.length = 0;
    });

    it('takes the access token\'s expiry from the token itself', async () => {
      const jar: Jar = {};
      await signIn(app, op, jar);

      expect(await whoami(app, jar)).toMatchObject({ username: 'alice', accessTokenValid: true });
      expect(op.tokenRequests).toHaveLength(1);
    });

    it('treats an opaque access token as expired, and warns', async () => {
      const jar: Jar = {};
      op.opaqueTokens = true;
      await signIn(app, op, jar);

      await whoami(app, jar);

      expect(op.tokenRequests.at(-1)?.params.grant_type).toBe('refresh_token');
      expect(logs).toContain('Identity provider did not say when the access token expires; treating it as expired');
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

  describe('with a private key', () => {
    const rsaKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = (key: KeyObject) => key.export({ format: 'pem', type: 'pkcs8' }) as string;
    let op: MockOIDCProvider;
    let app: FastifyInstance;

    const start = async () => {
      op = new MockOIDCProvider({ clientId, clientPublicKey: rsaKeys.publicKey });
      await op.start();
      app = await createApp(op.issuer, { extra: { clientPrivateKey: pem(rsaKeys.privateKey) } });
    };

    const assertion = async () => {
      const jar: Jar = {};
      await signIn(app, op, jar);

      const [ { authorization, params } ] = op.tokenRequests;

      expect(authorization).toBeUndefined();
      expect(params.client_secret).toBeUndefined();
      expect(params.client_assertion_type).toBe('urn:ietf:params:oauth:client-assertion-type:jwt-bearer');
      expect(await whoami(app, jar)).toMatchObject({ username: 'alice' });

      return decodeJwt(params.client_assertion);
    };

    afterEach(async () => {
      await app?.close();
      await op?.stop();
    });

    it('authenticates with private_key_jwt, addressed to the issuer', async () => {
      await start();

      const { header, payload } = await assertion();

      expect(header.alg).toBe('PS256');
      expect(header.kid).toBeUndefined();
      expect(payload).toMatchObject({ iss: clientId, sub: clientId, aud: op.issuer });
    });

    it('also authenticates when renewing the access token', async () => {
      await start();

      const jar: Jar = {};
      await signIn(app, op, jar);
      const user = await later(op.accessTokenTTL, () => whoami(app, jar));
      const [ , { params } ] = op.tokenRequests;

      expect(params.grant_type).toBe('refresh_token');
      expect(params.client_assertion).toBeDefined();
      expect(user).toMatchObject({ username: 'alice', accessTokenValid: true });
    });

    it('prefers the private key to a client secret, and warns', async () => {
      const logs: string[] = [];
      op = new MockOIDCProvider({ clientId, clientPublicKey: rsaKeys.publicKey });
      await op.start();
      app = await createApp(op.issuer, { clientSecret, logs, extra: { clientPrivateKey: pem(rsaKeys.privateKey) } });

      expect((await assertion()).header.alg).toBe('PS256');
      expect(logs).toContain('OIDC client has both a private key and a secret; using the private key');
    });
  });

  describe('choosing the scopes', () => {
    const requestedScope = async (scopesSupported: string[] | undefined, extra?: AppOptions['extra']) => {
      const op = new MockOIDCProvider({ clientId, clientSecret });
      op.scopesSupported = scopesSupported;
      await op.start();

      const app = await createApp(op.issuer, { clientSecret, extra });
      const res = await startSignIn(app, {});

      await app.close();
      await op.stop();

      return new URL(res.headers.location as string).searchParams.get('scope');
    };

    it('leaves out the scopes that the provider does not support', async () => {
      expect(await requestedScope([ 'openid', 'email', 'phone' ])).toBe('openid email');
    });

    it('requests the profile and email scopes when the provider does not list its scopes', async () => {
      expect(await requestedScope(undefined)).toBe('openid profile email');
    });

    it('adds offline access when asked', async () => {
      expect(await requestedScope(undefined, { offlineAccess: true })).toBe('openid profile email offline_access');
    });

    it('requests the configured scopes', async () => {
      expect(await requestedScope(undefined, { scope: 'openid', offlineAccess: true })).toBe('openid');
    });
  });

  describe('choosing the claims', () => {
    const signInAs = async (user: MockUser, extra?: AppOptions['extra']) => {
      const op = new MockOIDCProvider({ clientId, clientSecret });
      await op.start();

      const app = await createApp(op.issuer, { clientSecret, extra });
      const jar: Jar = {};
      await _signIn(app, op, jar, user);
      const result = await whoami(app, jar);

      await app.close();
      await op.stop();

      return result;
    };

    it('falls back to the email address when there is no preferred username', async () => {
      expect(await signInAs({ ...alice, preferred_username: undefined })).toMatchObject({
        id: alice.sub,
        username: 'alice@example.com'
      });
    });

    it('falls back to the subject when there is no preferred username or email address', async () => {
      expect(await signInAs({ ...alice, preferred_username: undefined, email: undefined })).toMatchObject({
        id: alice.sub,
        username: alice.sub
      });
    });

    it('prefers the object ID to the subject', async () => {
      const user = { ...alice, idTokenClaims: { oid: '00000000-0000-4000-8000-00000000a11c' } };

      expect(await signInAs(user)).toMatchObject({ id: '00000000-0000-4000-8000-00000000a11c' });
    });

    it('uses only the configured ID claim', async () => {
      const user = { ...alice, idTokenClaims: { oid: '00000000-0000-4000-8000-00000000a11c' } };

      expect(await signInAs(user, { claims: { id: 'sub' } })).toMatchObject({ id: alice.sub });
    });

    it('takes the ID and username from the configured claims', async () => {
      const user = { ...alice, idTokenClaims: { employee_id: 'E1234' } };

      expect(await signInAs(user, { claims: { id: 'employee_id', username: 'email' } })).toMatchObject({
        id: 'E1234',
        username: 'alice@example.com'
      });
    });

    it('does not sign the user in without the configured username claim', async () => {
      expect(await signInAs(alice, { claims: { username: 'upn' } })).toBeNull();
    });

    it('combines the roles and groups from the access token and the ID token', async () => {
      const user = {
        ...alice,
        groups: [ '/staff' ],
        idTokenClaims: { roles: [ 'admin', 'viewer' ], groups: [ '/staff', '/editors' ] }
      };

      expect(await signInAs(user)).toMatchObject({
        roles: [ 'admin', `${clientId}:editor`, 'viewer' ],
        groups: [ '/staff', '/editors' ]
      });
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

    it('lets authenticated users through', async () => {
      const jar: Jar = {};
      const start = await app.inject({ method: 'GET', url: '/whoami' });
      updateJar(jar, start);

      const { code, state } = op.authorize(start.headers.location as string, alice);
      const callback = await app.inject({
        method: 'GET',
        url: `/auth/callback?code=${code}&state=${state}`,
        cookies: jar
      });
      updateJar(jar, callback);

      expect(callback.statusCode).toBe(302);
      expect(callback.headers.location).toBe('/');
      expect(await whoami(app, jar)).toMatchObject({ username: 'alice' });
    });
  });

  describe('when the provider rejects the client\'s credentials', () => {
    it('reports a provider error', async () => {
      const op = new MockOIDCProvider({ clientId, clientSecret });
      await op.start();

      const app = await createApp(op.issuer, { clientSecret: 'not-the-secret' });
      const { callback } = await signIn(app, op, {});

      expect(callback.statusCode).toBe(502);
      expect(callback.json().code).toBe('FST_OIDC_PROVIDER_ERROR');

      await app.close();
      await op.stop();
    });
  });

  describe('when the issuer is not using HTTPS', () => {
    it('warns that it is insecure', async () => {
      const op = new MockOIDCProvider({ clientId, clientSecret });
      const logs: string[] = [];
      await op.start();

      const app = await createApp(op.issuer, { clientSecret, logs });

      expect(logs).toContain('OIDC issuer is not using HTTPS; credentials and tokens could be intercepted!');

      await app.close();
      await op.stop();
    });
  });

  describe('when the issuer does not match the discovered issuer', () => {
    it('fails to start', async () => {
      const op = new MockOIDCProvider({ clientId, clientSecret });
      await op.start();

      await expect(createApp(`${op.issuer}/`, { clientSecret })).rejects.toThrow(/issuer/);

      await op.stop();
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
