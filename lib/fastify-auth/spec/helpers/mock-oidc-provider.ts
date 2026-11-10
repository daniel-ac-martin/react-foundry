import type { FastifyInstance } from 'fastify';
import type { KeyObject } from 'node:crypto';

import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { base64url, basicCredentials, bearerToken, checkClientAssertion, createServer, sha256, signJwt } from './common.js';

// A minimal OpenID Provider (in the style of Keycloak) for exercising the OIDC
// flow without a real identity server.

export type TokenRequest = {
  authorization?: string
  params: Record<string, string>
};

export type MockOIDCProviderOptions = {
  clientId: string
  clientSecret?: string
  // The public half of the client's private_key_jwt key
  clientPublicKey?: KeyObject
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
  nonce?: string
  user: MockUser
};

type IssuedToken = {
  expiry: number
  user: MockUser
};

export class MockOIDCProvider {
  readonly clientId: string;
  readonly clientSecret?: string;
  readonly clientPublicKey?: KeyObject;
  readonly realm: string;
  readonly tokenRequests: TokenRequest[] = [];
  readonly userinfoRequests: Array<{ authorization?: string }> = [];
  // Seconds
  accessTokenTTL = 300;
  refreshTokenTTL = 1800;
  // Behaviours of providers other than Keycloak
  opaqueTokens = false;
  sendExpiresIn = true;
  sendRefreshExpiresIn = true;
  rotateRefreshTokens = true;
  readonly clientAssertionAlgorithms = [ 'PS256', 'RS256', 'ES256' ];
  issuer = '';

  private readonly httpd: FastifyInstance;
  private readonly keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  private readonly kid = randomUUID();
  private readonly grants = new Map<string, Grant>();
  private readonly accessTokens = new Map<string, IssuedToken>();
  private readonly refreshTokens = new Map<string, IssuedToken>();
  private readonly usedAssertionIds = new Set<string>();

  constructor({ clientId, clientSecret, clientPublicKey, realm = 'test' }: MockOIDCProviderOptions) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.clientPublicKey = clientPublicKey;
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
      token_endpoint_auth_methods_supported: [ 'client_secret_basic', 'client_secret_post', 'private_key_jwt', 'none' ],
      token_endpoint_auth_signing_alg_values_supported: this.clientAssertionAlgorithms,
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

        return this.tokenResponse(grant.user, grant.nonce);
      } else if (params.grant_type === 'refresh_token') {
        const refreshToken = this.refreshTokens.get(params.refresh_token);

        if (!refreshToken || refreshToken.expiry <= Math.floor(Date.now() / 1000)) {
          return reply.code(400).send({ error: 'invalid_grant' });
        }

        if (this.rotateRefreshTokens) {
          this.refreshTokens.delete(params.refresh_token);
        }

        return this.tokenResponse(refreshToken.user, undefined, this.rotateRefreshTokens);
      } else {
        return reply.code(400).send({ error: 'unsupported_grant_type' });
      }
    });

    this.httpd.get(`${prefix}/protocol/openid-connect/userinfo`, async (req, reply) => {
      const authorization = req.headers.authorization;
      const token = bearerToken(authorization);
      const accessToken = token && this.accessTokens.get(token);

      this.userinfoRequests.push({ authorization });

      if (!accessToken || accessToken.expiry <= Math.floor(Date.now() / 1000)) {
        return reply.code(401).send({ error: 'invalid_token' });
      }

      const { sub, preferred_username, name, given_name, family_name, email } = accessToken.user;

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
      nonce: url.searchParams.get('nonce') || undefined,
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

  get tokenEndpoint() {
    return `${this.issuer}/protocol/openid-connect/token`;
  }

  private clientAuthenticated(authorization: string | undefined, params: Record<string, string>) {
    if (this.clientPublicKey) {
      const jwt = !authorization && checkClientAssertion(params, {
        clientId: this.clientId,
        audiences: [ this.issuer, this.tokenEndpoint ],
        key: this.clientPublicKey,
        usedIds: this.usedAssertionIds
      });

      return !!jwt && this.clientAssertionAlgorithms.includes(jwt.header.alg);
    } else if (this.clientSecret) {
      const [ id, secret ] = basicCredentials(authorization) || [];

      return id === this.clientId && secret === this.clientSecret;
    } else {
      return !authorization && params.client_id === this.clientId;
    }
  }

  private tokenResponse(user: MockUser, nonce?: string, issueRefreshToken = true) {
    const now = Math.floor(Date.now() / 1000);
    const opaque = () => base64url(randomBytes(32));
    const common = {
      iss: this.issuer,
      sub: user.sub,
      iat: now - 1
    };
    const accessToken = this.opaqueTokens ? opaque() : this.jwt({
      ...common,
      ...user,
      aud: 'account',
      azp: this.clientId,
      exp: now + this.accessTokenTTL,
      jti: randomUUID()
    });
    const refreshToken = this.opaqueTokens ? opaque() : this.jwt({
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
      ...(nonce && { nonce }),
      preferred_username: user.preferred_username
    });

    this.accessTokens.set(accessToken, { expiry: now + this.accessTokenTTL, user });

    if (issueRefreshToken) {
      this.refreshTokens.set(refreshToken, { expiry: now + this.refreshTokenTTL, user });
    }

    return {
      access_token: accessToken,
      token_type: 'Bearer',
      ...(this.sendExpiresIn && { expires_in: this.accessTokenTTL }),
      ...(this.sendRefreshExpiresIn && { refresh_expires_in: this.refreshTokenTTL }),
      ...(issueRefreshToken && { refresh_token: refreshToken }),
      id_token: idToken,
      scope: 'openid'
    };
  }
}
