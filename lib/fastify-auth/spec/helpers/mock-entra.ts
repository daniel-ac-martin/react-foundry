import type { FastifyInstance } from 'fastify';

import { execFileSync } from 'node:child_process';
import { X509Certificate, createPublicKey, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { base64url, basicCredentials, bearerToken, checkClientAssertion, createServer, decodeJwt, sha256, signJwt, verifyJwt } from './common.js';

// A minimal Microsoft Entra ID (v2.0 endpoints) for exercising the OIDC flow
// See: https://learn.microsoft.com/en-us/entra/identity-platform/v2-protocols-oidc

export type TokenRequest = {
  authorization?: string
  params: Record<string, string>
};

export type MockEntraUser = {
  oid: string
  preferred_username: string
  name?: string
  given_name?: string
  family_name?: string
  email?: string
  roles?: string[]
  groups?: string[]
};

export type MockEntraProviderOptions = {
  clientId: string
  clientSecret?: string
  certificate?: string
  tenantId?: string
};

type Grant = {
  codeChallenge: string
  nonce?: string
  scopes: string[]
  user: MockEntraUser
};

const graph = '00000003-0000-0000-c000-000000000000';
// Scopes that don't name a resource; Entra issues a Graph token for these alone
const oidcScopes = [ 'openid', 'profile', 'email', 'offline_access' ];

export const certificateThumbprint = (pem: string) => sha256(new X509Certificate(pem).raw);

export const createCertificate = () => {
  const dir = mkdtempSync(join(tmpdir(), 'mock-entra-'));

  try {
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=my-client',
      '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')
    ], { stdio: 'ignore' });

    return {
      privateKey: readFileSync(join(dir, 'key.pem'), 'utf8'),
      certificate: readFileSync(join(dir, 'cert.pem'), 'utf8')
    };
  } finally {
    rmSync(dir, { recursive: true });
  }
};

export class MockEntraProvider {
  readonly clientId: string;
  readonly clientSecret?: string;
  readonly certificate?: string;
  readonly tenantId: string;
  readonly authorizationRequests: URL[] = [];
  readonly tokenRequests: TokenRequest[] = [];
  readonly userinfoRequests: Array<{ authorization?: string }> = [];
  // Seconds; Entra issues access tokens for 60-90 minutes
  accessTokenTTL = 3600;
  base = '';
  issuer = '';

  private readonly httpd: FastifyInstance;
  private readonly keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  private readonly kid = randomUUID();
  private readonly grants = new Map<string, Grant>();
  private readonly refreshTokens = new Map<string, Grant>();
  private readonly accessTokens = new Map<string, Grant>();
  private readonly usedAssertionIds = new Set<string>();

  constructor({ clientId, clientSecret, certificate, tenantId = randomUUID() }: MockEntraProviderOptions) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.certificate = certificate;
    this.tenantId = tenantId;
    this.httpd = createServer();

    const tenant = `/${tenantId}`;

    this.httpd.get(`${tenant}/v2.0/.well-known/openid-configuration`, async () => ({
      issuer: this.issuer,
      authorization_endpoint: `${this.base}${tenant}/oauth2/v2.0/authorize`,
      token_endpoint: this.tokenEndpoint,
      userinfo_endpoint: `${this.base}/oidc/userinfo`,
      end_session_endpoint: `${this.base}${tenant}/oauth2/v2.0/logout`,
      jwks_uri: `${this.base}${tenant}/discovery/v2.0/keys`,
      response_modes_supported: [ 'query', 'fragment', 'form_post' ],
      response_types_supported: [ 'code', 'id_token', 'code id_token', 'id_token token' ],
      scopes_supported: [ 'openid', 'profile', 'email', 'offline_access' ],
      subject_types_supported: [ 'pairwise' ],
      id_token_signing_alg_values_supported: [ 'RS256' ],
      token_endpoint_auth_methods_supported: [ 'client_secret_post', 'private_key_jwt', 'client_secret_basic' ],
      claims_supported: [ 'sub', 'iss', 'aud', 'exp', 'iat', 'auth_time', 'nonce', 'preferred_username', 'name', 'tid', 'ver', 'email' ],
      tenant_region_scope: 'EU'
    }));

    this.httpd.get(`${tenant}/discovery/v2.0/keys`, async () => ({
      keys: [{
        ...this.keys.publicKey.export({ format: 'jwk' }),
        kid: this.kid,
        use: 'sig'
      }]
    }));

    this.httpd.post(`${tenant}/oauth2/v2.0/token`, async (req, reply) => {
      const params = req.body as Record<string, string>;
      const authorization = req.headers.authorization;

      this.tokenRequests.push({ authorization, params });

      if (!this.clientAuthenticated(authorization, params)) {
        return reply.code(401).send({ error: 'invalid_client' });
      }

      if (params.grant_type === 'authorization_code') {
        const grant = this.grants.get(params.code);
        this.grants.delete(params.code);

        if (!grant || sha256(params.code_verifier || '') !== grant.codeChallenge) {
          return reply.code(400).send({ error: 'invalid_grant' });
        }

        return this.tokenResponse(grant, params.scope);
      } else if (params.grant_type === 'refresh_token') {
        const grant = this.refreshTokens.get(params.refresh_token);
        this.refreshTokens.delete(params.refresh_token);

        if (!grant) {
          return reply.code(400).send({ error: 'invalid_grant' });
        }

        return this.tokenResponse({ ...grant, nonce: undefined }, params.scope);
      } else {
        return reply.code(400).send({ error: 'unsupported_grant_type' });
      }
    });

    // Really on graph.microsoft.com, and only accepts access tokens for Microsoft Graph
    this.httpd.get('/oidc/userinfo', async (req, reply) => {
      const authorization = req.headers.authorization;
      const token = bearerToken(authorization);
      const claims = token && verifyJwt(token, this.keys.publicKey)?.payload;
      const grant = token && this.accessTokens.get(token);

      this.userinfoRequests.push({ authorization });

      if (!claims || !grant || claims.aud !== graph || claims.exp <= Math.floor(Date.now() / 1000)) {
        return reply.code(401).send({ error: 'invalid_token' });
      }

      const { scopes, user } = grant;

      return {
        sub: this.sub(user),
        ...(scopes.includes('profile') && {
          name: user.name,
          given_name: user.given_name,
          family_name: user.family_name
        }),
        ...(scopes.includes('email') && { email: user.email })
      };
    });
  }

  get tokenEndpoint() {
    return `${this.base}/${this.tenantId}/oauth2/v2.0/token`;
  }

  async start() {
    this.base = await this.httpd.listen({ host: '127.0.0.1', port: 0 });
    this.issuer = `${this.base}/${this.tenantId}/v2.0`;

    return this.issuer;
  }

  async stop() {
    await this.httpd.close();
  }

  // Simulates the user signing in at the authorization endpoint
  authorize(authorizationUrl: string, user: MockEntraUser) {
    const url = new URL(authorizationUrl);
    const scopes = (url.searchParams.get('scope') || '').split(' ');
    const code = base64url(randomBytes(32));

    this.authorizationRequests.push(url);

    if (url.searchParams.get('client_id') !== this.clientId || !scopes.includes('openid')) {
      throw new Error('Entra would show an error page for this request');
    }

    this.grants.set(code, {
      codeChallenge: url.searchParams.get('code_challenge') || '',
      nonce: url.searchParams.get('nonce') || undefined,
      scopes,
      user
    });

    return {
      code,
      state: url.searchParams.get('state') || ''
    };
  }

  // Entra's subject identifiers are pairwise: they differ between applications
  sub(user: MockEntraUser) {
    return sha256(`${user.oid}:${this.clientId}`);
  }

  private clientAuthenticated(authorization: string | undefined, params: Record<string, string>) {
    if (params.client_assertion && this.certificate) {
      // Entra identifies the certificate by its thumbprint, not by `kid`
      // See: https://learn.microsoft.com/en-us/entra/identity-platform/certificate-credentials
      const jwt = checkClientAssertion(params, {
        clientId: this.clientId,
        audiences: [ this.tokenEndpoint ],
        key: createPublicKey(this.certificate),
        usedIds: this.usedAssertionIds
      });

      return !!jwt && jwt.header['x5t#S256'] === certificateThumbprint(this.certificate);
    } else if (this.clientSecret) {
      const [ id, secret ] = basicCredentials(authorization) || [ params.client_id, params.client_secret ];

      return id === this.clientId && secret === this.clientSecret;
    } else {
      return false;
    }
  }

  // Issues a token for the resource of the first scope that names one, or for Graph
  // See: https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow#refresh-the-access-token
  private tokenResponse(grant: Grant, scope?: string) {
    const { nonce, user } = grant;
    // Requests may narrow the consented scopes, but not add to them
    const scopes = scope?.split(' ').filter(v => grant.scopes.includes(v)) || grant.scopes;
    const apiScopes = scopes.filter(v => v.startsWith('api://'));
    const api = apiScopes[0]?.replace(/^api:\/\/([^/]+)\/.*$/, '$1');
    const resourceScopes = apiScopes.filter(v => v.startsWith(`api://${api}/`));
    const now = Math.floor(Date.now() / 1000);
    const sub = this.sub(user);
    const { oid, roles, groups, ...profile } = user;
    const idToken = scopes.includes('openid') && signJwt({
      aud: this.clientId,
      iss: this.issuer,
      iat: now,
      nbf: now,
      exp: now + 3600,
      sub,
      oid,
      tid: this.tenantId,
      ver: '2.0',
      ...(nonce && { nonce }),
      ...(scopes.includes('profile') && {
        name: profile.name,
        preferred_username: profile.preferred_username
      }),
      ...(scopes.includes('email') && { email: profile.email }),
      ...(roles && { roles }),
      ...(groups && { groups })
    }, this.keys.privateKey, { kid: this.kid });
    // A v2.0 token for the app's own API, assuming a single app registration
    const apiToken = api && signJwt({
      aud: api,
      iss: this.issuer,
      iat: now,
      nbf: now,
      exp: now + this.accessTokenTTL,
      oid,
      tid: this.tenantId,
      sub: sha256(`${oid}:${api}`),
      azp: this.clientId,
      scp: resourceScopes.map(v => v.replace(/^.*\//, '')).join(' '),
      name: profile.name,
      preferred_username: profile.preferred_username,
      ...(roles && { roles }),
      ver: '2.0'
    }, this.keys.privateKey, { kid: this.kid });
    // Graph's tokens carry a `nonce` header, so only Graph can verify them
    const accessToken = apiToken || signJwt({
      aud: graph,
      iss: `https://sts.windows.net/${this.tenantId}/`,
      iat: now,
      nbf: now,
      exp: now + this.accessTokenTTL,
      oid,
      tid: this.tenantId,
      sub: sha256(`${oid}:${graph}`),
      scp: scopes.filter(v => oidcScopes.includes(v) && v !== 'offline_access').join(' '),
      upn: profile.preferred_username,
      unique_name: profile.preferred_username,
      name: profile.name,
      given_name: profile.given_name,
      family_name: profile.family_name,
      email: profile.email,
      ver: '1.0'
    }, this.keys.privateKey, { kid: this.kid, nonce: base64url(randomBytes(32)) });
    // Entra's refresh tokens are opaque
    const refreshToken = scopes.includes('offline_access') && `0.A${base64url(randomBytes(64))}.${base64url(randomBytes(32))}`;

    this.accessTokens.set(accessToken, { codeChallenge: '', scopes, user });

    // A refresh token carries all of the consented scopes
    if (refreshToken) {
      this.refreshTokens.set(refreshToken, { codeChallenge: '', scopes: grant.scopes, user });
    }

    return {
      token_type: 'Bearer',
      scope: (
        api
          ? resourceScopes.join(' ')
          : decodeJwt(accessToken).payload.scp
      ),
      expires_in: Math.max(this.accessTokenTTL, 0),
      ext_expires_in: Math.max(this.accessTokenTTL, 0),
      access_token: accessToken,
      ...(idToken && { id_token: idToken }),
      ...(refreshToken && { refresh_token: refreshToken })
    };
  }
}
