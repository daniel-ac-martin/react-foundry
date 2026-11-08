import type { FastifyInstance } from 'fastify';

import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { basicCredentials, createServer, sha256, signJwt } from './common.js';

// A minimal OpenID Provider (in the style of Keycloak) for exercising the OIDC
// flow without a real identity server.

export type TokenRequest = {
  authorization?: string
  params: Record<string, string>
};

export type MockOIDCProviderOptions = {
  clientId: string
  clientSecret?: string
  realm?: string
};

export type MockUser = {
  sub: string
  preferred_username: string
  name?: string
  given_name?: string
  family_name?: string
  email?: string
  realm_access?: { roles: string[] }
  resource_access?: Record<string, { roles: string[] }>
};

type Grant = {
  codeChallenge: string
  user: MockUser
};

export class MockOIDCProvider {
  readonly clientId: string;
  readonly clientSecret?: string;
  readonly realm: string;
  readonly tokenRequests: TokenRequest[] = [];
  readonly userinfoRequests: Array<{ authorization?: string }> = [];
  // Token lifetimes in seconds; set negative values to issue expired tokens
  accessTokenTTL = 300;
  refreshTokenTTL = 1800;
  issuer = '';

  private readonly httpd: FastifyInstance;
  private readonly keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  private readonly kid = randomUUID();
  private readonly grants = new Map<string, Grant>();
  private readonly refreshTokens = new Map<string, MockUser>();

  constructor({ clientId, clientSecret, realm = 'test' }: MockOIDCProviderOptions) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.realm = realm;
    this.httpd = createServer();

    const prefix = `/realms/${realm}`;

    this.httpd.get(`${prefix}/.well-known/openid-configuration`, async () => ({
      issuer: this.issuer,
      authorization_endpoint: `${this.issuer}/protocol/openid-connect/auth`,
      token_endpoint: `${this.issuer}/protocol/openid-connect/token`,
      userinfo_endpoint: `${this.issuer}/protocol/openid-connect/userinfo`,
      end_session_endpoint: `${this.issuer}/protocol/openid-connect/logout`,
      jwks_uri: `${this.issuer}/protocol/openid-connect/certs`,
      response_types_supported: [ 'code' ],
      subject_types_supported: [ 'public' ],
      id_token_signing_alg_values_supported: [ 'RS256' ],
      token_endpoint_auth_methods_supported: [ 'client_secret_basic', 'client_secret_post', 'none' ],
      code_challenge_methods_supported: [ 'S256' ]
    }));

    this.httpd.get(`${prefix}/protocol/openid-connect/certs`, async () => ({
      keys: [{
        ...this.keys.publicKey.export({ format: 'jwk' }),
        kid: this.kid,
        alg: 'RS256',
        use: 'sig'
      }]
    }));

    this.httpd.post(`${prefix}/protocol/openid-connect/token`, async (req, reply) => {
      const params = req.body as Record<string, string>;
      const authorization = req.headers.authorization;

      this.tokenRequests.push({ authorization, params });

      if (!this.clientAuthenticated(authorization, params)) {
        return reply.code(401).send({ error: 'invalid_client' });
      }

      if (params.grant_type === 'authorization_code') {
        const grant = this.grants.get(params.code);
        this.grants.delete(params.code);

        const challenge = params.code_verifier && sha256(params.code_verifier);

        if (!grant || challenge !== grant.codeChallenge) {
          return reply.code(400).send({ error: 'invalid_grant' });
        }

        return this.tokenResponse(grant.user);
      } else if (params.grant_type === 'refresh_token') {
        const user = this.refreshTokens.get(params.refresh_token);

        if (!user) {
          return reply.code(400).send({ error: 'invalid_grant' });
        }

        return this.tokenResponse(user);
      } else {
        return reply.code(400).send({ error: 'unsupported_grant_type' });
      }
    });

    this.httpd.get(`${prefix}/protocol/openid-connect/userinfo`, async (req, reply) => {
      const authorization = req.headers.authorization;
      const token = authorization?.replace(/^Bearer /, '');
      const payload = token && JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());

      this.userinfoRequests.push({ authorization });

      if (!payload) {
        return reply.code(401).send({ error: 'invalid_token' });
      }

      const { sub, preferred_username, name, given_name, family_name, email } = payload;

      return { sub, preferred_username, name, given_name, family_name, email };
    });
  }

  async start() {
    const address = await this.httpd.listen({ host: '127.0.0.1', port: 0 });
    this.issuer = `${address}/realms/${this.realm}`;

    return this.issuer;
  }

  async stop() {
    await this.httpd.close();
  }

  // Simulates the user signing in at the authorization endpoint
  authorize(authorizationUrl: string, user: MockUser) {
    const url = new URL(authorizationUrl);
    const code = randomUUID();

    this.grants.set(code, {
      codeChallenge: url.searchParams.get('code_challenge') || '',
      user
    });

    return {
      code,
      state: url.searchParams.get('state') || ''
    };
  }

  revokeRefreshTokens() {
    this.refreshTokens.clear();
  }

  jwt(claims: object) {
    return signJwt(claims, this.keys.privateKey, { kid: this.kid });
  }

  private clientAuthenticated(authorization: string | undefined, params: Record<string, string>) {
    if (this.clientSecret) {
      const [ id, secret ] = basicCredentials(authorization) || [];

      return id === this.clientId && secret === this.clientSecret;
    } else {
      return !authorization && params.client_id === this.clientId;
    }
  }

  private tokenResponse(user: MockUser) {
    const now = Math.floor(Date.now() / 1000);
    const common = {
      iss: this.issuer,
      sub: user.sub,
      iat: now - 1
    };
    const accessToken = this.jwt({
      ...common,
      ...user,
      aud: 'account',
      azp: this.clientId,
      exp: now + this.accessTokenTTL,
      jti: randomUUID()
    });
    const refreshToken = this.jwt({
      ...common,
      aud: this.issuer,
      exp: now + this.refreshTokenTTL,
      jti: randomUUID()
    });
    const idToken = this.jwt({
      ...common,
      aud: this.clientId,
      azp: this.clientId,
      exp: now + 300,
      preferred_username: user.preferred_username
    });

    this.refreshTokens.set(refreshToken, user);

    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: Math.max(this.accessTokenTTL, 0),
      refresh_token: refreshToken,
      id_token: idToken,
      scope: 'openid'
    };
  }
}
