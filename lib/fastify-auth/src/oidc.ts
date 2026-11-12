import type { AuthBagger, Deserialize, Maybe, SubRouteHandlerMethod, Serialize, UserProfile } from './common.js';

import type { FastifyBaseLogger } from 'fastify';
import type { FastifyError } from '@fastify/error';
import type { DiscoveryRequestOptions, TokenEndpointResponse } from 'openid-client';
import type { PrivateKeyJwtOptions } from './oidc/private-key-jwt.js';

import {
  AuthorizationResponseError,
  ClientError,
  ClientSecretBasic,
  Configuration,
  ResponseBodyError,
  None,
  allowInsecureRequests,
  authorizationCodeGrant,
  buildAuthorizationUrl,
  buildEndSessionUrl,
  calculatePKCECodeChallenge,
  discovery,
  fetchUserInfo,
  randomNonce,
  randomPKCECodeVerifier,
  randomState,
  refreshTokenGrant
} from 'openid-client';
import { createError } from '@fastify/error';
import { id } from './common.js';
import { privateKeyJwt } from './oidc/private-key-jwt.js';

// OpenID Connect

export type Options = {
  issuer: string
  clientId: string
  clientSecret?: string
  // PEM; authenticates the client with `private_key_jwt` instead of a secret
  clientPrivateKey?: string
  // PEM; identifies the key by the certificate's thumbprint, as Entra ID requires
  clientCertificate?: string
  clientKeyId?: string
  // Entra ID documents only the token endpoint
  clientAssertionAudience?: PrivateKeyJwtOptions['audience']
  redirectUri: string
  // Defaults to `openid`, plus `profile` and `email` where the provider supports them
  scope?: string
  // Adds `offline_access` to the default scopes, for a refresh token from providers such as Entra ID
  offlineAccess?: boolean
  claims?: ClaimNames
};

// The claims that hold the user's ID and username
export type ClaimNames = {
  id?: string
  username?: string
};

// Token expiry times are in seconds since the epoch, like a JWT's `exp`
type Tokens = {
  accessToken?: string
  accessTokenExp?: number
  refreshToken?: string
  refreshTokenExp?: number
  idToken?: string
};

export type AuthInfo = UserProfile & Tokens & {
  accessTokenValid?: boolean
  refreshTokenValid?: boolean
  idTokenValid?: boolean
  userinfo?: object
};

type JWT = {
  iss?: string
  sub?: string
  aud?: string | string[]
  exp?: number
  nbf?: number
  iat?: number
  jti?: string
};

type SessionObj = {
  codeVerifier?: string
  nonce?: string
  state?: string
};

type Reducer<A, B> = (acc: B, cur: A) => B;
const resourceToRoles: Reducer<any[], string[]> = (acc, [x, y]) => ([
  ...acc,
  ...(y.roles?.map((e: string) => `${x}:${e}`) || [])
]);

const BadSession = createError('FST_BAD_SESSION', 'Unable to verify session', 409);
const NotSignedIn = createError('FST_OIDC_NOT_SIGNED_IN', 'The identity provider did not sign the user in: %s', 401);
const BadCallback = createError('FST_OIDC_BAD_CALLBACK', 'The sign-in response does not match the sign-in request', 400);
const ProviderError = createError('FST_OIDC_PROVIDER_ERROR', 'The identity provider rejected a request: %s', 502);

// The claim that failed a comparison, which openid-client nests two causes deep
const failedClaim = (err: ClientError) => {
  const detail = err.cause instanceof Error && err.cause.cause;

  return (
    typeof detail === 'object' && detail !== null && 'claim' in detail
      ? detail.claim
      : undefined
  );
};

// Most callback failures are not server errors
const callbackError = <T>(err: T): T | FastifyError => {
  const code = err instanceof ClientError ? err.code : undefined;
  const notSignedIn = err instanceof AuthorizationResponseError;
  const codeRejected = err instanceof ResponseBodyError && err.error === 'invalid_grant';
  const responseInvalid = code === 'OAUTH_INVALID_RESPONSE';
  const nonceMismatch = err instanceof ClientError && code === 'OAUTH_JWT_CLAIM_COMPARISON_FAILED' && failedClaim(err) === 'nonce';
  const providerRejected = err instanceof ResponseBodyError;

  if (notSignedIn) {
    return new NotSignedIn(err.error, { cause: err });
  } else if (codeRejected || responseInvalid || nonceMismatch) {
    return new BadCallback({ cause: err });
  } else if (providerRejected) {
    return new ProviderError(err.error, { cause: err });
  } else {
    return err;
  }
};

// Keycloak puts realm roles in `realm_access`, and client roles in `resource_access`
const extractRoles = ({
  roles = [],
  realm_access,
  resource_access = {}
}: Record<string, any>): string[] => [
  ...roles,
  ...(realm_access?.roles || []),
  ...Object.entries(resource_access).reduce(resourceToRoles, [])
];

const unique = <T>(v: T[]): T[] => [ ...new Set(v) ];

// The standard scopes for the user's profile claims
const desiredScopes = [ 'profile', 'email' ];

const base64UrlDecode = (v: string): string => (
  Buffer.from(v, 'base64url').toString('utf8')
);

const now = () => Math.floor(Date.now() / 1000);

// Reads tokens as at a single moment, so that a request sees one consistent time
const tokenReader = (now: number, log: FastifyBaseLogger, claimNames: ClaimNames = {}) => {
  const { id: idClaim, username: usernameClaim } = claimNames;

  // Access and refresh tokens may be opaque. Only ID tokens are always JWTs.
  const jwtClaims = (token?: string): Record<string, any> => {
    try {
      return token && JSON.parse(base64UrlDecode(token.split('.')[1])) || {};
    } catch {
      return {};
    }
  };

  const tokens = (
    {
      access_token: accessToken,
      expires_in: expiresIn,
      refresh_token: refreshToken,
      refresh_expires_in: refreshExpiresIn,
      id_token: idToken
    }: TokenEndpointResponse,
    previous: Tokens = {}
  ): Tokens => {
    const accessTokenExp = (
      expiresIn !== undefined
        ? now + expiresIn
        : jwtClaims(accessToken).exp
    );
    // Keycloak gives offline tokens a `refresh_expires_in` of 0
    const refreshTokenExp = (
      typeof refreshExpiresIn === 'number' && refreshExpiresIn > 0
        ? now + refreshExpiresIn
        : jwtClaims(refreshToken).exp
    );

    if (accessTokenExp === undefined) {
      log.warn('Identity provider did not say when the access token expires; treating it as expired');
    }

    return {
      accessToken,
      accessTokenExp,
      refreshToken: refreshToken || previous.refreshToken,
      refreshTokenExp: refreshToken ? refreshTokenExp : previous.refreshTokenExp,
      idToken: idToken || previous.idToken
    };
  };

  const authInfo = (tokens: Tokens, userinfo: Record<string, any> = {}): AuthInfo => {
    const {
      accessToken,
      accessTokenExp,
      refreshToken,
      refreshTokenExp,
      idToken
    } = tokens;
    const accessClaims = jwtClaims(accessToken);
    const idClaims = jwtClaims(idToken);
    const data: Record<string, any> = {
      ...accessClaims,
      ...idClaims,
      ...userinfo,
      accessToken,
      refreshToken,
      idToken,
      userinfo
    };
    // An unknown refresh token lifetime leaves the session's expiry unknown
    const sessionExp = (
      refreshToken
        ? refreshTokenExp
        : accessTokenExp
    );
    const expiry = (
      sessionExp === undefined
        ? undefined
        : new Date(sessionExp * 1000)
    );

    const isValid = ({
      nbf = 0,
      exp = 0
    }: JWT) => (
      ( nbf <= now ) && ( now < exp )
    );

    // An access token without a known expiry is treated as expired
    const accessTokenValid = accessTokenExp !== undefined && now < accessTokenExp;
    // A refresh token without a known expiry is usable until the provider refuses it
    const refreshTokenValid = !!refreshToken && (refreshTokenExp === undefined || now < refreshTokenExp);
    const idTokenValid = isValid(idClaims);

    // Roles and groups can be spread across the tokens and userinfo, so combine them
    const roles = unique([
      ...extractRoles(accessClaims),
      ...extractRoles(idClaims),
      ...extractRoles(userinfo)
    ]).filter(id);
    const groups = unique([
      ...(accessClaims.groups || []),
      ...(idClaims.groups || []),
      ...(userinfo.groups || [])
    ]);

    return {
      provider: 'oidc',
      // Entra ID's `oid` is the same in every app, whereas its `sub` differs between apps
      id: (
        idClaim
          ? data[idClaim]
          : data.oid || data.sub
      ),
      displayName: data.displayName || data.name,
      name: {
        familyName: data.familyName || data.family_name,
        givenName: data.givenName || data.given_name,
        middleName: data.middleName || data.middle_name
      },
      emails: (
        data.email
          ? [{ value: data.email }]
          : undefined
      ),
      photos: (
        data.photo
          ? [{ value: data.photo }]
          : undefined
      ),
      // A configured claim is used alone; otherwise fall back to whatever identifies the user
      username: (
        usernameClaim
          ? data[usernameClaim]
          : data.username || data.preferred_username || data.email || data.sub
      ),
      groups,
      roles,
      accessToken: data.accessToken,
      accessTokenExp,
      accessTokenValid,
      refreshToken: data.refreshToken,
      refreshTokenExp,
      refreshTokenValid,
      idToken: data.idToken,
      idTokenValid,
      userinfo: data.userinfo,
      expiry
    };
  };

  return { tokens, authInfo };
};

export const oidc: AuthBagger<Options> = async ({
  clientId,
  clientSecret,
  clientPrivateKey,
  clientCertificate,
  clientKeyId,
  clientAssertionAudience,
  issuer,
  redirectUri: _redirectUri,
  scope: _scope,
  offlineAccess,
  claims
}, fullSessions, log) => {
  const redirectUri = _redirectUri + '/auth/callback'
  const server = new URL(issuer);
  const execute: DiscoveryRequestOptions['execute'] = [];

  if (server.protocol === 'http:') {
    // Permit plain HTTP when explicitly configured (e.g. a local Keycloak)
    log.warn('OIDC issuer is not using HTTPS; credentials and tokens could be intercepted!');
    execute.push(allowInsecureRequests);
  }

  if (clientPrivateKey && clientSecret) {
    log.warn('OIDC client has both a private key and a secret; using the private key');
  }

  const discoveryOptions: DiscoveryRequestOptions = {
    execute,
    timeout: 5 // seconds
  };
  // Client authentication can depend on the provider's metadata, so build the configuration after discovery
  const discovered = await discovery(server, clientId, undefined, None(), discoveryOptions);
  const metadata = discovered.serverMetadata();
  const clientAuth = (
    clientPrivateKey
      ? await privateKeyJwt(clientPrivateKey, metadata, {
        certificate: clientCertificate,
        kid: clientKeyId,
        audience: clientAssertionAudience
      })
      : (
        clientSecret
          ? ClientSecretBasic(clientSecret)
          : None()
      )
  );
  const config = new Configuration(metadata, clientId, undefined, clientAuth);

  config.timeout = discoveryOptions.timeout;
  execute.forEach(extension => extension(config));

  // Ask for the standard profile claims where the provider supports them, or doesn't say
  const scopesSupported = metadata.scopes_supported;
  const extraScopes = desiredScopes.filter(v => (
    !scopesSupported || scopesSupported.includes(v)
  ));
  const scope = _scope || [
    'openid',
    ...extraScopes,
    ...(
      offlineAccess
        ? [ 'offline_access' ]
        : []
    )
  ].join(' ');

  const serialize: Serialize<AuthInfo> = (user, req) => {
    if (fullSessions) {
      return user
    } else {
      // We need to see what we can fit inside the cookie
      // There are some challenges with this:
      //   1. We don't know what else is in the session
      //   2. Subsequent encryption will increase the size of the data
      const cookieLimit = 4096;
      const encryptionCost = 1.5; // This is an estimate!
      const smallEnough = (v: object) => (
        JSON.stringify(v).length * encryptionCost <= cookieLimit
      );
      const payload = {
        accessToken: user.accessToken,
        accessTokenExp: user.accessTokenExp,
        refreshToken: user.refreshToken,
        refreshTokenExp: user.refreshTokenExp,
        idToken: user.idToken,
        userinfo: user.userinfo
      };

      if (smallEnough(payload)) {
        return payload;
      } else {
        delete payload.userinfo; // Probably fine

        if (smallEnough(payload)) {
          return payload;
        } else {
          delete payload.idToken; // Probably fine

          if (smallEnough(payload)) {
            return payload;
          } else {
            // This will cut short the user's session
            delete payload.refreshToken;
            delete payload.refreshTokenExp;

            req.log.warn('Cannot fit refresh token in session; session will expire early');
            return payload;
          }
        }
      }
    }
  };

  const deserialize: Deserialize<AuthInfo> = async (
    {
      accessToken,
      accessTokenExp,
      refreshToken,
      refreshTokenExp,
      idToken,
      userinfo
    },
    req
  ) => {
    const { tokens, authInfo } = tokenReader(now(), req.log, claims);
    const currentTokens = {
      accessToken,
      accessTokenExp,
      refreshToken,
      refreshTokenExp,
      idToken
    };
    const user: AuthInfo = authInfo(currentTokens, userinfo || {});

    if (user.username && user.accessTokenValid) {
      return user;
    } else if (!user.accessTokenValid && refreshToken && user.refreshTokenValid) {
      // The access token has expired, let's try to get a new one
      try {
        const tokenSet = await refreshTokenGrant(config, refreshToken);

        req.log.info('Obtained new access token');
        const newTokens = tokens(tokenSet, currentTokens);
        const newUser: AuthInfo = authInfo(newTokens, userinfo || {});

        if (newUser.username && newUser.accessTokenValid) {
          return newUser;
        } else {
          req.log.error('Access token was invalid');
          return undefined;
        }
      } catch (_err) {
        req.log.error('Failed to obtain new access token');
        return undefined;
      }
    } else {
      req.log.info('Access token has expired and cannot renew');
      return undefined;
    }
  };

  // Loosely inspired by openid-client's Passport strategy: https://github.com/panva/openid-client/blob/81c48ef33e10b42caa3a3d33349172a9904fb999/lib/passport_strategy.js#L78
  const authenticate: SubRouteHandlerMethod = async (req, reply) => {
    const codeVerifier = randomPKCECodeVerifier();
    const codeChallenge = await calculatePKCECodeChallenge(codeVerifier);
    const state = randomState();
    const nonce = randomNonce();
    const redirectTo = buildAuthorizationUrl(config, {
      redirect_uri: redirectUri,
      scope,
      state,
      nonce,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256'
    });
    const sessionObj: SessionObj = {
      codeVerifier,
      nonce,
      state
    };

    req.session.oidc = sessionObj;

    return reply.redirect(redirectTo.href);
  };

  // Loosely inspired by openid-client's Passport strategy: https://github.com/panva/openid-client/blob/81c48ef33e10b42caa3a3d33349172a9904fb999/lib/passport_strategy.js#L78
  const callback: SubRouteHandlerMethod = async (req, reply) => {
    const { tokens, authInfo } = tokenReader(now(), req.log, claims);
    const sessionObj = (req.session.oidc || {}) as SessionObj;
    delete req.session.oidc;

    const {
      codeVerifier,
      nonce,
      state
    } = sessionObj;

    if (!(codeVerifier && state)) {
      throw new BadSession();
    }

    // Use our configured URL rather than trusting the Host header
    const currentUrl = new URL(redirectUri);
    currentUrl.search = new URL(req.url, currentUrl).search;

    try {
      const tokenSet = await authorizationCodeGrant(config, currentUrl, {
        expectedNonce: nonce,
        expectedState: state,
        idTokenExpected: true,
        pkceCodeVerifier: codeVerifier
      });
      const userinfo = await fetchUserInfo(config, tokenSet.access_token, tokenSet.claims()!.sub);
      const newTokens = tokens(tokenSet);
      const user: AuthInfo = authInfo(newTokens, userinfo);

      if (user.username) {
        req.user = user;
      }
    } catch (err) {
      if (err instanceof AuthorizationResponseError) {
        req.log.info({ error: err.error, description: err.error_description }, 'Identity provider did not sign the user in');
      }

      throw callbackError(err);
    }
  };

  const terminate: SubRouteHandlerMethod = async (_req, reply, user) => {
    const idToken = (user as Maybe<AuthInfo>)?.idToken;
    const redirectTo = buildEndSessionUrl(config, {
      post_logout_redirect_uri: _redirectUri,
      ...(idToken && { id_token_hint: idToken })
    });

    return reply.redirect(redirectTo.href);
  };

  return {
    authenticate,
    callback,
    deserialize,
    serialize,
    terminate,
    wantSession: true
  };
};

export default oidc;
