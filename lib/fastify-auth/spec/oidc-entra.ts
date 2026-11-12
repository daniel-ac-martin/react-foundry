/**
 * @jest-environment node
 */

import type { FastifyInstance } from 'fastify';
import type { Jar } from './helpers/app.js';
import type { MockEntraUser } from './helpers/mock-entra.js';

import { SessionStore } from '../src/index.js';
import { createApp, later, redirectUri, signIn, signOut, startSignIn, updateJar, whoami } from './helpers/app.js';
import { basicCredentials, decodeJwt } from './helpers/common.js';
import { MockEntraProvider, certificateThumbprint, createCertificate } from './helpers/mock-entra.js';

const clientId = '6731de76-14a6-49ae-97bc-6eba6914391e';
// Entra's secrets contain characters that are form-urlencoded in client_secret_basic
const clientSecret = 'Xq28Q~vZ.jK3_mN9pLr-T4wYbC6dEfGh1sUoIaxn';
// Entra's tokens are too large to keep in a cookie
const session = {
  store: SessionStore.Memory,
  cookies: { secret: 'a-secret-that-is-at-least-32-characters-long' }
} as const;

const alice: MockEntraUser = {
  oid: '00000000-0000-4000-8000-00000000a11c',
  preferred_username: 'alice@contoso.example',
  name: 'Alice Example',
  given_name: 'Alice',
  family_name: 'Example',
  email: 'alice@contoso.example',
  roles: [ 'Indicators.Publish' ],
  groups: [ '9a1e0b8c-0000-4000-8000-000000000001' ]
};

describe('OIDC authentication with Entra ID', () => {
  let op: MockEntraProvider;
  let app: FastifyInstance;
  let jar: Jar;

  beforeAll(async () => {
    op = new MockEntraProvider({ clientId, clientSecret });
    await op.start();
    app = await createApp(op.issuer, {
      clientId,
      clientSecret,
      session,
      extra: {
        offlineAccess: true
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

  it('discovers the tenant from its v2.0 issuer', async () => {
    const res = await startSignIn(app, jar);
    const location = new URL(res.headers.location as string);

    expect(res.statusCode).toBe(302);
    expect(location.origin + location.pathname).toBe(`${op.base}/${op.tenantId}/oauth2/v2.0/authorize`);
  });

  it('form-urlencodes the client secret for client_secret_basic', async () => {
    await signIn(app, op, jar, alice);

    const [ { authorization, params } ] = op.tokenRequests;

    expect(basicCredentials(authorization)).toEqual([ clientId, clientSecret ]);
    expect(params.grant_type).toBe('authorization_code');
  });

  it('requests the profile and email scopes, and offline access', async () => {
    const res = await startSignIn(app, jar);

    expect(new URL(res.headers.location as string).searchParams.get('scope')).toBe('openid profile email offline_access');
  });

  it('sends a nonce', async () => {
    const res = await startSignIn(app, jar);

    expect(new URL(res.headers.location as string).searchParams.get('nonce')).toMatch(/^[A-Za-z0-9_-]{43,}$/);
  });

  it('signs the user in with the ID token\'s claims', async () => {
    const { callback } = await signIn(app, op, jar, alice);

    expect(callback.statusCode).toBe(302);
    expect(await whoami(app, jar)).toMatchObject({
      provider: 'oidc',
      id: alice.oid,
      username: 'alice@contoso.example',
      displayName: 'Alice Example',
      emails: [ { value: 'alice@contoso.example' } ],
      roles: [ 'Indicators.Publish' ],
      groups: alice.groups
    });
  });

  it('renews an expired access token with the opaque refresh token', async () => {
    await signIn(app, op, jar, alice);

    const before = op.tokenRequests.length;
    const user = await later(op.accessTokenTTL, () => whoami(app, jar));

    expect(op.tokenRequests[before]?.params.grant_type).toBe('refresh_token');
    expect(user).toMatchObject({ username: 'alice@contoso.example', accessTokenValid: true });
  });

  it('reports a cancelled sign-in as not signed in', async () => {
    const start = await startSignIn(app, jar);
    const state = new URL(start.headers.location as string).searchParams.get('state');
    const callback = await app.inject({
      method: 'GET',
      url: `/auth/callback?error=access_denied&error_description=AADSTS65004&state=${state}`,
      cookies: jar
    });
    updateJar(jar, callback);

    expect(callback.statusCode).toBe(401);
  });

  it('signs out at the tenant\'s logout endpoint', async () => {
    const res = await signOut(app, jar);
    const location = new URL(res.headers.location as string);

    expect(res.statusCode).toBe(302);
    expect(location.origin + location.pathname).toBe(`${op.base}/${op.tenantId}/oauth2/v2.0/logout`);
    expect(location.searchParams.get('post_logout_redirect_uri')).toBe(redirectUri);
  });

  describe('with a certificate credential (#496)', () => {
    let certOp: MockEntraProvider;
    let certApp: FastifyInstance;
    let certificate: string;

    beforeAll(async () => {
      const credential = createCertificate();
      certificate = credential.certificate;
      certOp = new MockEntraProvider({ clientId, certificate });
      await certOp.start();
      certApp = await createApp(certOp.issuer, {
        clientId,
        session,
        extra: {
          offlineAccess: true,
          clientPrivateKey: credential.privateKey,
          clientCertificate: certificate,
          clientAssertionAudience: 'token-endpoint'
        }
      });
    });

    afterAll(async () => {
      await certApp.close();
      await certOp.stop();
    });

    it('authenticates with a private_key_jwt identified by the certificate\'s thumbprint', async () => {
      const certJar: Jar = {};
      const { callback } = await signIn(certApp, certOp, certJar, alice);

      const [ { authorization, params } ] = certOp.tokenRequests;
      const assertion = decodeJwt(params.client_assertion);

      expect(authorization).toBeUndefined();
      expect(params.client_secret).toBeUndefined();
      expect(params.client_assertion_type).toBe('urn:ietf:params:oauth:client-assertion-type:jwt-bearer');
      expect(assertion.header['x5t#S256']).toBe(certificateThumbprint(certificate));
      expect(assertion.payload.aud).toBe(certOp.tokenEndpoint);
      expect(callback.statusCode).toBe(302);
      expect(await whoami(certApp, certJar)).toMatchObject({ username: 'alice@contoso.example' });
    });
  });
});
