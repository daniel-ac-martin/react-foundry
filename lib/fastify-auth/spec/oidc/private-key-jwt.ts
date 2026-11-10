/**
 * @jest-environment node
 */

import type { KeyObject } from 'node:crypto';
import type { ServerMetadata } from 'openid-client';
import type { PrivateKeyJwtOptions } from '../../src/oidc/private-key-jwt.js';

import { X509Certificate, generateKeyPairSync } from 'node:crypto';
import { privateKeyJwt } from '../../src/oidc/private-key-jwt.js';
import { checkClientAssertion } from '../helpers/common.js';
import { certificateThumbprint, createCertificate } from '../helpers/mock-entra.js';

const clientId = 'my-client';
const metadata: ServerMetadata = {
  issuer: 'https://idp.example/realms/test',
  token_endpoint: 'https://idp.example/realms/test/protocol/openid-connect/token'
};
const rsaKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = (key: KeyObject) => key.export({ format: 'pem', type: 'pkcs8' }) as string;

// Builds an assertion as openid-client would for a token request
const assertion = async (key: string, publicKey: KeyObject, options?: PrivateKeyJwtOptions, server: ServerMetadata = metadata) => {
  const auth = await privateKeyJwt(key, server, options);
  const body = new URLSearchParams();
  await auth(server, { client_id: clientId }, body, new Headers());
  const params = Object.fromEntries(body);
  const jwt = checkClientAssertion(params, {
    clientId,
    audiences: [ server.issuer, server.token_endpoint! ],
    key: publicKey,
    usedIds: new Set()
  });

  expect(params.client_id).toBe(clientId);
  expect(params.client_assertion_type).toBe('urn:ietf:params:oauth:client-assertion-type:jwt-bearer');
  expect(jwt).toBeDefined();

  return jwt!;
};

describe('privateKeyJwt', () => {
  it('signs an assertion addressed to the issuer, with PS256 and no kid', async () => {
    const { header, payload } = await assertion(pem(rsaKeys.privateKey), rsaKeys.publicKey);

    expect(header.alg).toBe('PS256');
    expect(header.kid).toBeUndefined();
    expect(payload).toMatchObject({ iss: clientId, sub: clientId, aud: metadata.issuer });
  });

  it('signs with PS256 when the provider supports it', async () => {
    const server = { ...metadata, token_endpoint_auth_signing_alg_values_supported: [ 'RS256', 'PS256' ] };

    expect((await assertion(pem(rsaKeys.privateKey), rsaKeys.publicKey, {}, server)).header.alg).toBe('PS256');
  });

  it('signs with RS256 when the provider does not support PS256', async () => {
    const server = { ...metadata, token_endpoint_auth_signing_alg_values_supported: [ 'RS256', 'ES256' ] };

    expect((await assertion(pem(rsaKeys.privateKey), rsaKeys.publicKey, {}, server)).header.alg).toBe('RS256');
  });

  it('signs with ES256 using a P-256 key', async () => {
    const keys = generateKeyPairSync('ec', { namedCurve: 'P-256' });

    expect((await assertion(pem(keys.privateKey), keys.publicKey)).header.alg).toBe('ES256');
  });

  it('accepts a PKCS #1 RSA key', async () => {
    const key = rsaKeys.privateKey.export({ format: 'pem', type: 'pkcs1' }) as string;

    expect((await assertion(key, rsaKeys.publicKey)).header.alg).toBe('PS256');
  });

  it('sends the configured key ID', async () => {
    expect((await assertion(pem(rsaKeys.privateKey), rsaKeys.publicKey, { kid: 'key-1' })).header.kid).toBe('key-1');
  });

  it('can address the assertion to the token endpoint', async () => {
    const { payload } = await assertion(pem(rsaKeys.privateKey), rsaKeys.publicKey, { audience: 'token-endpoint' });

    expect(payload.aud).toBe(metadata.token_endpoint);
  });

  it('identifies the key by the certificate\'s thumbprint', async () => {
    const { privateKey, certificate } = createCertificate();
    const { publicKey } = new X509Certificate(certificate);
    const { header } = await assertion(privateKey, publicKey, { certificate });

    expect(header['x5t#S256']).toBe(certificateThumbprint(certificate));
  });

  it('rejects an unsupported key', async () => {
    const keys = generateKeyPairSync('ed25519');

    await expect(privateKeyJwt(pem(keys.privateKey), metadata)).rejects.toThrow('OIDC client private key must be RSA, or EC on P-256, P-384 or P-521');
  });

  it('rejects a certificate for a different key', async () => {
    const { certificate } = createCertificate();

    await expect(privateKeyJwt(pem(rsaKeys.privateKey), metadata, { certificate })).rejects.toThrow('OIDC client certificate does not match the private key');
  });
});
