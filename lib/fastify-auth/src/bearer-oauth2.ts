import type { DiscoveryRequestOptions } from 'openid-client';
import type { ClaimNames } from './claims.js';
import type { AuthBagger, Reply, UserProfile } from './common.js';

import { createError } from '@fastify/error';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { allowInsecureRequests, discovery } from 'openid-client';
import { profileFromClaims } from './claims.js';

// OAuth 2.0 bearer tokens, issued as JWTs by an OpenID Connect or OAuth 2.0 provider
// See: https://www.rfc-editor.org/rfc/rfc6750 and https://www.rfc-editor.org/rfc/rfc9068

export type Options = {
  issuer: string
  // The API's identifier in the provider, which its access tokens carry in `aud`; Entra ID uses the API's client ID
  // A list accepts a token addressed to any of them, such as an API known by both its client ID and an `api://` URI
  audience: string | string[]
  claims?: ClaimNames
};

export type BearerUser = UserProfile & {
  accessToken: string
  scopes: string[]
};

const NoToken = createError('FST_BEARER_NO_TOKEN', 'An access token is required', 401);
const InvalidToken = createError('FST_BEARER_INVALID_TOKEN', 'The access token is invalid', 401);

// Asymmetric algorithms only, so that a token can't be signed with a key the API holds
const algorithms = [ 'RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512', 'EdDSA' ];
// RFC 9068's type, and the plain JWT that Keycloak and Entra ID use
const tokenTypes = [ undefined, 'JWT', 'at+jwt', 'application/at+jwt' ];
// Seconds, as openid-client allows when checking ID tokens
const clockTolerance = 30;

// A quoted string in a header can't hold an unescaped quote or backslash
const forHeader = (v: string) => v.replace(/["\\]/g, '');

// The kinds of metadata to look for: OpenID Connect discovery, then OAuth 2.0 (RFC 8414)
const metadataKinds: DiscoveryRequestOptions['algorithm'][] = [ 'oidc', 'oauth2' ];

// Finds the provider's keys from its metadata
const discoverJwksUri = async (issuer: URL): Promise<URL> => {
  const execute = (
    issuer.protocol === 'http:'
      ? [ allowInsecureRequests ]
      : []
  );

  for (const algorithm of metadataKinds) {
    try {
      // openid-client needs a client ID, but only the metadata is used, so any ID will do
      const config = await discovery(issuer, 'bearer-oauth2', undefined, undefined, { algorithm, execute });
      const { jwks_uri } = config.serverMetadata();

      if (jwks_uri) {
        return new URL(jwks_uri);
      }
    } catch {
      // Try the next kind of metadata
    }
  }

  throw new Error(`Could not find the keys for the issuer, ${issuer}`);
};

export const bearerOAuth2: AuthBagger<Options & { privacy: boolean }> = async ({
  issuer,
  audience,
  claims,
  privacy
}, _fullSessions, log) => {
  if (!audience || audience.length === 0) {
    throw new Error('The bearer-oauth2 method needs an audience, so that it rejects tokens issued for other APIs');
  }

  const server = new URL(issuer);

  if (server.protocol === 'http:') {
    log.warn('OAuth 2.0 issuer is not using HTTPS; its keys could be tampered with!');
  }

  const jwksUri = await discoverJwksUri(server);
  const jwks = createRemoteJWKSet(jwksUri);

  const challenge = (reply: Reply, error?: string) => {
    reply.header('WWW-Authenticate', (
      error
        ? `Bearer error="invalid_token", error_description="${forHeader(error)}"`
        : 'Bearer'
    ));
  };

  return {
    authenticate: async (req, reply) => {
      const token = req.headers.authorization?.match(/^Bearer +(\S+)$/i)?.[1];

      if (!token) {
        // Without privacy, a request without a token goes through anonymously
        if (privacy) {
          challenge(reply);
          throw new NoToken();
        }
      } else {
        try {
          const { payload, protectedHeader } = await jwtVerify(token, jwks, {
            issuer,
            audience,
            algorithms,
            clockTolerance,
            requiredClaims: [ 'exp' ]
          });

          if (!tokenTypes.includes(protectedHeader.typ)) {
            throw new Error(`unexpected token type, ${protectedHeader.typ}`);
          }

          const user: BearerUser = {
            provider: 'bearer-oauth2',
            ...profileFromClaims([ payload ], claims),
            accessToken: token,
            expiry: (
              payload.exp === undefined
                ? undefined
                : new Date(payload.exp * 1000)
            )
          };

          req.user = user;
        } catch (err) {
          const message = (
            err instanceof Error
              ? err.message
              : String(err)
          );

          req.log.info(`Rejected an access token: ${message}`);
          challenge(reply, message);
          throw new InvalidToken({ cause: err });
        }
      }
    },
    perRequest: true,
    wantSession: false
  };
};

export default bearerOAuth2;
