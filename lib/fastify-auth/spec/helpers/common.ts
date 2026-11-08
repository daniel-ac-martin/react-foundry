import type { KeyObject } from 'node:crypto';

import { createHash, sign, verify } from 'node:crypto';
import Fastify from 'fastify';

export const base64url = (v: Buffer | string) => Buffer.from(v).toString('base64url');

export const sha256 = (v: Buffer | string) => base64url(createHash('sha256').update(v).digest());

// Client credentials are form-urlencoded before being base64 encoded
// See: https://www.rfc-editor.org/rfc/rfc6749#section-2.3.1
const formUrlDecode = (v: string) => decodeURIComponent(v.replace(/\+/g, ' '));

export const basicCredentials = (authorization?: string) => {
  const match = authorization?.match(/^Basic (.+)$/);

  return match && Buffer.from(match[1], 'base64').toString().split(':').map(formUrlDecode);
};

export const bearerToken = (authorization?: string) => authorization?.match(/^Bearer (.+)$/)?.[1];

export const createServer = () => {
  const httpd = Fastify();

  httpd.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_req, body, done) => done(null, Object.fromEntries(new URLSearchParams(body as string)))
  );

  return httpd;
};

const algorithm = (key: KeyObject) => key.asymmetricKeyType === 'ec' ? 'ES256' : 'RS256';

export const signJwt = (claims: object, key: KeyObject, header: object = {}) => {
  const encodedHeader = base64url(JSON.stringify({ alg: algorithm(key), typ: 'JWT', ...header }));
  const encodedPayload = base64url(JSON.stringify(claims));
  const signature = sign('sha256', Buffer.from(`${encodedHeader}.${encodedPayload}`), { key, dsaEncoding: 'ieee-p1363' });

  return `${encodedHeader}.${encodedPayload}.${base64url(signature)}`;
};

export const decodeJwt = (jwt: string) => {
  const [ header, payload ] = jwt.split('.').slice(0, 2).map(v => JSON.parse(Buffer.from(v, 'base64url').toString()));

  return { header, payload };
};

export const verifyJwt = (jwt: string, key: KeyObject) => {
  const [ header, payload, signature ] = jwt.split('.');
  const decoded = decodeJwt(jwt);
  const valid = (
    decoded.header.alg === algorithm(key)
      && verify('sha256', Buffer.from(`${header}.${payload}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url'))
  );

  return valid ? decoded : undefined;
};

export type ClientAssertionChecks = {
  clientId: string
  audiences: string[]
  key: KeyObject
  usedIds: Set<string>
};

// Checks a private_key_jwt (or federated) client assertion
// See: https://www.rfc-editor.org/rfc/rfc7523#section-3
export const checkClientAssertion = (params: Record<string, string>, { clientId, audiences, key, usedIds }: ClientAssertionChecks) => {
  if (params.client_assertion_type !== 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer' || !params.client_assertion) {
    return undefined;
  }

  const jwt = verifyJwt(params.client_assertion, key);
  const claims = jwt?.payload;
  const aud = [ claims?.aud ].flat();
  const now = Math.floor(Date.now() / 1000);
  const valid = (
    claims
      && claims.iss === clientId
      && claims.sub === clientId
      && aud.some(v => audiences.includes(v))
      && claims.exp > now
      && claims.jti
      && !usedIds.has(claims.jti)
  );

  if (valid) {
    usedIds.add(claims.jti);
    return jwt;
  } else {
    return undefined;
  }
};
