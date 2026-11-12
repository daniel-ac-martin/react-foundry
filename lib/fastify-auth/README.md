React Foundry - Fastify-Auth
============================

Authentication plugin for Fastify. Allows you to authenticate uses by a variety
of methods and obtain identity information and roles for use on each request.
Also provides a session when requested or when required by the authentication
method.


Using this package
------------------

First install the package into your project:

```shell
npm install -S @react-foundry/fastify-auth
```

Then use it in your code as follows:

```ts
import Fastify from 'fastify';
import { AuthMethod, fastifyAuth } from '@react-foundry/fastify-auth';

const httpd = Fastify();

httpd.register(fastifyAuth, {
  privacy: false,
  session: {
    cookies: {
      secret: 'changeme' // Change this to a secret string that is shared across instances of your application
    }
  },
  method: AuthMethod.OIDC,
  issuer: 'https://keycloak/realms/my-realm',  // Change this to your OIDC provider's issuer (exactly as it advertises it)
  clientId: 'my-client',                       // Change this to your client ID
  clientSecret: 'my-client-secret',            // Change this to your client secret
  redirectUri: 'https://my-website/'           // Change this to the base URL that the OIDC provider should redirect back to
});

httpd.get('/', async (req, _reply) => {
  const user = req.user.username || 'guest';
  const message = `Hello ${user}`;

  return message;
});

await httpd.listen({
  host: '::'
  port: 8080
});
```


### `fastifyAuth`

A Fastify plugin which can be 'registered' with the following options.

Options object:

- **`method: 'none' | 'dummy' | 'headers' | 'basic' | 'oidc'`**
  The method to use to authenticate users.
  - `'none'`: No authentication (you might want this if you just want a
              session).
  - `'dummy'`: Dummy authentication; useful for testing.
  - `'headers'`: Trusts auth information provided on HTTP headers (such as by a
                 reverse proxy). **WARNING:** This is insecure when not behind a
                 reverse authentication proxy.
  - `'basic'`: HTTP [Basic authentication].
  - `'oidc'`: [OpenID Connect]. (Such as [Keycloak] etc.)
- **`privacy: boolean`**
  When `true`, user must be authenticated to access any part of the website.
  When `false`, users can still access the website but may not have access to
  all features when those features require certain roles. Users can typically
  choose to log-in to acquire extra permissions.
- **`session: object`**
  See: https://www.npmjs.com/package/@react-foundry/fastify-session


### `req.user: object`

An object representing the user data. Includes the `username` and `roles`. When
using OIDC, it should also contain the `accessToken` for making requests to
other services on behalf of the user.


### OIDC client authentication

The OIDC method authenticates to the identity provider's token endpoint in
one of three ways, depending on which options are set.

- **`clientPrivateKey`:** Signs a short-lived assertion with a private key
  (`private_key_jwt`). We recommend this. The provider only holds the public
  key, so there is no shared secret to leak or rotate. GOV.UK One Login
  requires it.
- **`clientSecret`:** Sends a shared secret (`client_secret_basic`).
- **Neither:** Sends only the client ID, for a public client.

`clientPrivateKey` is a PEM-encoded RSA or EC (P-256, P-384 or P-521) private
key. RSA keys sign with PS256, or with RS256 when the provider only supports
that. These options adjust the assertion:

- **`clientCertificate`:** A PEM-encoded certificate for the key. The
  assertion carries its SHA-256 thumbprint in an `x5t#S256` header, which
  Microsoft Entra ID uses to find the key.
- **`clientKeyId`:** Sent as the assertion's `kid` header, for providers that
  hold more than one of the client's keys.
- **`clientAssertionAudience: 'issuer' | 'token-endpoint'`:** Who the
  assertion is addressed to. The default, `'issuer'`, follows current
  guidance. Microsoft Entra ID only documents `'token-endpoint'`.

For Microsoft Entra ID, upload the certificate to the app registration and
configure:

```ts
{
  clientPrivateKey: process.env.OIDC_CLIENT_PRIVATE_KEY,
  clientCertificate: process.env.OIDC_CLIENT_CERTIFICATE,
  clientAssertionAudience: 'token-endpoint'
}
```


### OIDC scopes and claims

By default, the OIDC method requests the `openid` scope, plus `profile` and
`email` where the provider's discovery document lists them (or doesn't list
any scopes).

- **`offlineAccess`:** Also requests `offline_access`. Microsoft Entra ID only
  issues a refresh token with it. In Keycloak it asks for an offline token,
  which outlives the user's session with Keycloak.
- **`scope`:** Requests exactly these scopes instead, ignoring
  `offlineAccess`.

The user's details are read from the access token (when it's a JWT), the ID
token and the userinfo response, in that order, with later ones taking
precedence. **`claims`** says which claims hold the user's ID and username:

- **`id`:** Defaults to `oid` where present, otherwise `sub`. When set, only
  that claim is used.
- **`username`:** Defaults to the first of `username`, `preferred_username`,
  `email` and `sub`. When set, only that claim is used, and a user without it
  isn't signed in. Set it explicitly if you use the username for
  authorisation, as the default can differ between providers.

`roles` combines `roles`, `realm_access.roles` and `resource_access.*.roles`
(prefixed with the client's ID), and `groups` combines `groups`, from all of
these sources.

For Microsoft Entra ID, the default ID is `oid`, which is the same in every
app and is the user's ID in Microsoft Graph. `sub` differs between apps, so set
`claims.id` to `'sub'` if you don't want apps to be able to correlate users.
Entra only sends `oid` with the `profile` scope, so keep `profile` if you set
`scope`, or the ID quietly becomes `sub`. `preferred_username` can change, so
use the ID rather than the username for authorisation. To get a refresh token:

```ts
{
  offlineAccess: true
}
```

GOV.UK One Login needs no configuration. It doesn't support the `profile`
scope, so the default is `openid email`, and as it has no username, the
username falls back to the email address.


### OIDC sign-in errors

When an OIDC sign-in fails, the callback responds with one of the following
errors, which your application's error handler can turn into a suitable page.

- **`FST_OIDC_NOT_SIGNED_IN` (401):** The identity provider did not sign the
  user in, such as when they cancel.
- **`FST_OIDC_BAD_CALLBACK` (400):** The response does not match the sign-in
  that started it, such as after using the back button, or when the
  authorization code has expired or already been used.
- **`FST_BAD_SESSION` (409):** The sign-in session has gone.
- **`FST_OIDC_PROVIDER_ERROR` (502):** The identity provider rejected one of
  our requests, such as when the client credentials are wrong.


Working on this package
-----------------------

Before working on this package you must install its dependencies using
the following command:

```shell
pnpm install
```


### Building

Build the package by compiling the source code.

```shell
npm run build
```


### Clean-up

Remove any previously built files.

```shell
npm run clean
```

[Basic authentication]: https://en.wikipedia.org/wiki/Basic_access_authentication
[OpenID Connect]: https://en.wikipedia.org/wiki/OpenID#OpenID_Connect_(OIDC)
[Keycloak]: https://www.keycloak.org/
