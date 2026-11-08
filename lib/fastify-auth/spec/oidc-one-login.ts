/**
 * @jest-environment node
 */

// Skipped tests wait on the issues in their names. The options they pass are
// provisional until those issues settle them.

import type { FastifyInstance } from 'fastify';
import type { Jar } from './helpers/app.js';
import type { MockOneLoginUser } from './helpers/mock-one-login.js';

import { generateKeyPairSync } from 'node:crypto';
import { createApp, later, redirectUri, signIn, signOut, startSignIn, updateJar, whoami } from './helpers/app.js';
import { decodeJwt } from './helpers/common.js';
import { MockOneLoginProvider } from './helpers/mock-one-login.js';

const clientId = 'HGIOgho9HIRhgoepdIOPFdIUWgewi0';
const clientKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });

const alice: MockOneLoginUser = {
  sub: 'urn:fdc:gov.uk:2022:56P4CMsGh_02YOlWpd8PAOI-2sVlB2nsNU7mcLZYhYw=',
  email: 'alice@example.com',
  phone_number: '+447700900000'
};

describe('OIDC authentication with GOV.UK One Login', () => {
  let op: MockOneLoginProvider;
  let app: FastifyInstance;
  let jar: Jar;

  beforeAll(async () => {
    op = new MockOneLoginProvider({ clientId, clientPublicKey: clientKeys.publicKey });
    await op.start();
    app = await createApp(op.issuer, {
      clientId,
      extra: {
        scope: 'openid email',
        claims: { username: 'email' },
        clientPrivateKey: clientKeys.privateKey.export({ format: 'pem', type: 'pkcs8' })
      }
    });
  });

  afterAll(async () => {
    await app.close();
    await op.stop();
  });

  beforeEach(() => {
    jar = {};
    op.tokenRequests.length = 0;
  });

  it('discovers One Login from its issuer', async () => {
    const res = await startSignIn(app, jar);
    const location = new URL(res.headers.location as string);

    expect(res.statusCode).toBe(302);
    expect(location.origin + location.pathname).toBe(`${op.base}/authorize`);
  });

  it('sends a nonce', async () => {
    const res = await startSignIn(app, jar);

    expect(new URL(res.headers.location as string).searchParams.get('nonce')).toMatch(/^[A-Za-z0-9_-]{43,}$/);
  });

  it.skip('authenticates with private_key_jwt (#490, #496)', async () => {
    await signIn(app, op, jar, alice);

    const [ { authorization, userAgent, params } ] = op.tokenRequests;

    expect(authorization).toBeUndefined();
    expect(userAgent).toBeTruthy();
    expect(params.client_assertion_type).toBe('urn:ietf:params:oauth:client-assertion-type:jwt-bearer');
    expect(decodeJwt(params.client_assertion).payload).toMatchObject({ iss: clientId, sub: clientId });
  });

  it.skip('signs the user in with their email address as their username (#490, #493, #494, #496)', async () => {
    const { callback } = await signIn(app, op, jar, alice);

    expect(callback.statusCode).toBe(302);
    expect(await whoami(app, jar)).toMatchObject({
      provider: 'oidc',
      id: alice.sub,
      username: 'alice@example.com',
      emails: [ { value: 'alice@example.com' } ],
      roles: []
    });
  });

  it.skip('signs the user back in through One Login once their access token expires (#490, #493, #494, #495, #496)', async () => {
    await signIn(app, op, jar, alice);

    await later(op.accessTokenTTL, async () => {
      const navigation = await app.inject({ method: 'GET', url: '/whoami', cookies: jar });
      updateJar(jar, navigation);

      expect(navigation.statusCode).toBe(302);

      const { code, state } = op.authorize(navigation.headers.location as string, alice);
      const callback = await app.inject({ method: 'GET', url: `/auth/callback?code=${code}&state=${state}`, cookies: jar });
      updateJar(jar, callback);

      expect(await whoami(app, jar)).toMatchObject({ username: 'alice@example.com' });
    });
  });

  it.skip('reports a cancelled sign-in as a client error (#492)', async () => {
    const start = await startSignIn(app, jar);
    const state = new URL(start.headers.location as string).searchParams.get('state');
    const callback = await app.inject({
      method: 'GET',
      url: `/auth/callback?error=access_denied&state=${state}`,
      cookies: jar
    });
    updateJar(jar, callback);

    expect(callback.statusCode).toBeGreaterThanOrEqual(400);
    expect(callback.statusCode).toBeLessThan(500);
  });

  it('signs out at One Login\'s logout endpoint', async () => {
    const res = await signOut(app, jar);
    const location = new URL(res.headers.location as string);

    expect(res.statusCode).toBe(302);
    expect(location.origin + location.pathname).toBe(`${op.base}/logout`);
    expect(location.searchParams.get('post_logout_redirect_uri')).toBe(redirectUri);
  });

  it.skip('sends id_token_hint with post_logout_redirect_uri (#490, #491, #493, #494, #496)', async () => {
    await signIn(app, op, jar, alice);

    const res = await signOut(app, jar);
    const location = new URL(res.headers.location as string);

    expect(decodeJwt(location.searchParams.get('id_token_hint') as string).payload).toMatchObject({ sub: alice.sub, aud: clientId });
  });
});
