import type { ClientAuth, ServerMetadata } from 'openid-client';

import { X509Certificate, createHash, createPrivateKey } from 'node:crypto';
import { PrivateKeyJwt, modifyAssertion } from 'openid-client';

export type PrivateKeyJwtOptions = {
  certificate?: string
  kid?: string
  audience?: 'issuer' | 'token-endpoint'
};

const curves: Record<string, string> = {
  prime256v1: 'P-256',
  secp384r1: 'P-384',
  secp521r1: 'P-521'
};

// Authenticates the client with a signed assertion
// See: https://openid.net/specs/openid-connect-core-1_0.html#ClientAuthentication
export const privateKeyJwt = async (
  pem: string,
  metadata: ServerMetadata,
  { certificate, kid, audience = 'issuer' }: PrivateKeyJwtOptions = {}
): Promise<ClientAuth> => {
  const privateKey = createPrivateKey(pem);
  const x509 = certificate && new X509Certificate(certificate);

  if (x509 && !x509.checkPrivateKey(privateKey)) {
    throw new Error('OIDC client certificate does not match the private key');
  }

  const thumbprint = x509 && createHash('sha256').update(x509.raw).digest('base64url');
  const namedCurve = curves[privateKey.asymmetricKeyDetails?.namedCurve || ''];

  if (!(privateKey.asymmetricKeyType === 'rsa' || (privateKey.asymmetricKeyType === 'ec' && namedCurve))) {
    throw new Error('OIDC client private key must be RSA, or EC on P-256, P-384 or P-521');
  }

  const supported = metadata.token_endpoint_auth_signing_alg_values_supported;
  // Newer profiles, such as FAPI 2.0, require PS256 rather than RS256 for RSA keys
  const pss = !supported || supported.includes('PS256') || !supported.includes('RS256');
  const algorithm = (
    namedCurve
      ? { name: 'ECDSA', namedCurve }
      : {
        name: pss ? 'RSA-PSS' : 'RSASSA-PKCS1-v1_5',
        hash: 'SHA-256'
      }
  );
  const der = privateKey.export({ format: 'der', type: 'pkcs8' });
  // The global Web Crypto API, as `node:crypto`'s typings differ from openid-client's
  const key = await crypto.subtle.importKey('pkcs8', der, algorithm, false, ['sign']);

  return PrivateKeyJwt({ key, kid }, {
    [modifyAssertion]: (header, payload) => {
      if (thumbprint) {
        header['x5t#S256'] = thumbprint;
      }
      if (audience === 'token-endpoint') {
        payload.aud = metadata.token_endpoint;
      }
    }
  });
};

export default privateKeyJwt;
