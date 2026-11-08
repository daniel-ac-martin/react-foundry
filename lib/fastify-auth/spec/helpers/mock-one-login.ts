import type { FastifyInstance } from 'fastify';
import type { KeyObject } from 'node:crypto';

import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { base64url, bearerToken, checkClientAssertion, createServer, sha256, signJwt } from './common.js';

// A minimal GOV.UK One Login for exercising the OIDC flow
// See: https://docs.sign-in.service.gov.uk/integrate-with-integration-environment/authenticate-your-user/

export type TokenRequest = {
  authorization?: string
  userAgent?: string
  params: Record<string, string>
};

export type MockOneLoginUser = {
  sub: string
  email: string
  phone_number?: string
};

export type MockOneLoginProviderOptions = {
  clientId: string
  // The public half of the client's private_key_jwt key
  clientPublicKey: KeyObject
};

type Grant = {
  codeChallenge?: string
  nonce: string
  redirectUri: string
  scopes: string[]
  user: MockOneLoginUser
};

type AccessGrant = Grant & {
  expiry: number
};

export class MockOneLoginProvider {
  readonly clientId: string;
  readonly clientPublicKey: KeyObject;
  readonly authorizationRequests: URL[] = [];
  readonly tokenRequests: TokenRequest[] = [];
  readonly userinfoRequests: Array<{ authorization?: string }> = [];
  // Seconds
  accessTokenTTL = 180;
  base = '';
  issuer = '';

  private readonly httpd: FastifyInstance;
  private readonly keys = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  private readonly kid = randomUUID();
  private readonly grants = new Map<string, Grant>();
  private readonly accessTokens = new Map<string, AccessGrant>();
  private readonly usedAssertionIds = new Set<string>();

  constructor({ clientId, clientPublicKey }: MockOneLoginProviderOptions) {
    this.clientId = clientId;
    this.clientPublicKey = clientPublicKey;
    this.httpd = createServer();

    this.httpd.get('/.well-known/openid-configuration', async () => ({
      issuer: this.issuer,
      authorization_endpoint: `${this.base}/authorize`,
      token_endpoint: this.tokenEndpoint,
      userinfo_endpoint: `${this.base}/userinfo`,
      end_session_endpoint: `${this.base}/logout`,
      jwks_uri: `${this.base}/.well-known/jwks.json`,
      scopes_supported: [ 'openid', 'email', 'phone', 'wallet-subject-id' ],
      response_types_supported: [ 'code' ],
      grant_types_supported: [ 'authorization_code' ],
      token_endpoint_auth_methods_supported: [ 'private_key_jwt', 'client_secret_post' ],
      token_endpoint_auth_signing_alg_values_supported: [ 'RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512' ],
      ui_locales_supported: [ 'en', 'cy' ],
      request_parameter_supported: true,
      trustmarks: `${this.base}/trustmark`,
      subject_types_supported: [ 'public', 'pairwise' ],
      userinfo_signing_alg_values_supported: [ 'ES256' ],
      id_token_signing_alg_values_supported: [ 'ES256', 'RS256' ],
      request_object_signing_alg_values_supported: [ 'ES256' ],
      code_challenge_methods_supported: [ 'S256' ],
      claim_types_supported: [ 'normal' ],
      claims_supported: [ 'sub', 'email', 'email_verified', 'phone_number', 'phone_number_verified', 'wallet_subject_id' ],
      claims_parameter_supported: true,
      backchannel_logout_supported: true,
      backchannel_logout_session_supported: false
    }));

    this.httpd.get('/.well-known/jwks.json', async () => ({
      keys: [{
        ...this.keys.publicKey.export({ format: 'jwk' }),
        kid: this.kid,
        alg: 'ES256',
        use: 'sig'
      }]
    }));

    this.httpd.post('/token', async (req, reply) => {
      const params = req.body as Record<string, string>;
      const authorization = req.headers.authorization;
      const userAgent = req.headers['user-agent'];

      this.tokenRequests.push({ authorization, userAgent, params });

      if (!userAgent) {
        return reply.code(403).send();
      }

      const authenticated = !authorization && checkClientAssertion(params, {
        clientId: this.clientId,
        audiences: [ this.tokenEndpoint, this.issuer ],
        key: this.clientPublicKey,
        usedIds: this.usedAssertionIds
      });

      if (!authenticated) {
        return reply.code(400).send({ error: 'invalid_client' });
      }

      if (params.grant_type !== 'authorization_code') {
        return reply.code(400).send({ error: 'unsupported_grant_type' });
      }

      const grant = this.grants.get(params.code);
      this.grants.delete(params.code);

      const pkceValid = !grant?.codeChallenge || sha256(params.code_verifier || '') === grant.codeChallenge;

      if (!grant || !pkceValid || params.redirect_uri !== grant.redirectUri) {
        return reply.code(400).send({ error: 'invalid_grant' });
      }

      return this.tokenResponse(grant);
    });

    this.httpd.get('/userinfo', async (req, reply) => {
      const authorization = req.headers.authorization;
      const token = bearerToken(authorization);
      const grant = token && this.accessTokens.get(token);

      this.userinfoRequests.push({ authorization });

      if (!grant || grant.expiry <= Math.floor(Date.now() / 1000)) {
        return reply.code(401).send({ error: 'invalid_token' });
      }

      const { scopes, user } = grant;

      return {
        sub: user.sub,
        ...(scopes.includes('email') && {
          email: user.email,
          email_verified: true
        }),
        ...(scopes.includes('phone') && user.phone_number && {
          phone_number: user.phone_number,
          phone_number_verified: true
        })
      };
    });
  }

  get tokenEndpoint() {
    return `${this.base}/token`;
  }

  async start() {
    this.base = await this.httpd.listen({ host: '127.0.0.1', port: 0 });
    this.issuer = `${this.base}/`;

    return this.issuer;
  }

  async stop() {
    await this.httpd.close();
  }

  // Simulates the user signing in at the authorization endpoint
  authorize(authorizationUrl: string, user: MockOneLoginUser) {
    const url = new URL(authorizationUrl);
    const param = (k: string) => url.searchParams.get(k) || undefined;
    const scopes = (param('scope') || '').split(' ');
    const nonce = param('nonce');
    const state = param('state');
    const redirectUri = param('redirect_uri');
    const code = base64url(randomBytes(32));

    this.authorizationRequests.push(url);

    if (param('client_id') !== this.clientId || param('response_type') !== 'code' || !scopes.includes('openid')) {
      throw new Error('One Login would show an error page for this request');
    } else if (!nonce || !state || !redirectUri) {
      throw new Error('One Login requires a nonce, state and redirect_uri');
    }

    this.grants.set(code, {
      codeChallenge: param('code_challenge'),
      nonce,
      redirectUri,
      scopes,
      user
    });

    return { code, state };
  }

  private tokenResponse(grant: Grant) {
    const now = Math.floor(Date.now() / 1000);
    // One Login's access tokens are opaque, and there are no refresh tokens
    const accessToken = base64url(randomBytes(32));
    const atHash = base64url(createHash('sha256').update(accessToken).digest().subarray(0, 16));
    const idToken = signJwt({
      at_hash: atHash,
      sub: grant.user.sub,
      aud: this.clientId,
      iss: this.issuer,
      vot: 'Cl.Cm',
      exp: now + 120,
      iat: now,
      nonce: grant.nonce,
      vtm: `${this.base}/trustmark`,
      sid: randomUUID(),
      auth_time: now
    }, this.keys.privateKey, { kid: this.kid });

    this.accessTokens.set(accessToken, { ...grant, expiry: now + this.accessTokenTTL });

    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: Math.max(this.accessTokenTTL, 0),
      id_token: idToken
    };
  }
}
