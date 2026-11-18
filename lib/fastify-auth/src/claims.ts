import type { UserProfile } from './common.js';

import { id } from './common.js';

// Reading the user's details from the claims in tokens and userinfo

// The claims that hold the user's ID and username
export type ClaimNames = {
  id?: string
  username?: string
};

type Claims = Record<string, any>;

type Reducer<A, B> = (acc: B, cur: A) => B;
const resourceToRoles: Reducer<any[], string[]> = (acc, [x, y]) => ([
  ...acc,
  ...(y.roles?.map((e: string) => `${x}:${e}`) || [])
]);

// Keycloak puts realm roles in `realm_access`, and client roles in `resource_access`
const extractRoles = ({
  roles = [],
  realm_access,
  resource_access = {}
}: Claims): string[] => [
  ...roles,
  ...(realm_access?.roles || []),
  ...Object.entries(resource_access).reduce(resourceToRoles, [])
];

const unique = <T>(v: T[]): T[] => [ ...new Set(v) ];

type Profile = Omit<UserProfile, 'provider' | 'expiry' | 'scopes'> & { scopes: string[] };

// The scopes granted to the client, in RFC 9068's `scope` or Entra ID's and Okta's `scp`
const scopesFromClaims = ({ scope, scp }: Claims): string[] => {
  const scopes = scope ?? scp ?? [];

  return (
    typeof scopes === 'string'
      ? scopes.split(' ').filter(id)
      : scopes
  );
};

// The user's profile from one or more sets of claims, with later ones taking precedence
export const profileFromClaims = (sources: Claims[], claimNames: ClaimNames = {}): Profile => {
  const { id: idClaim, username: usernameClaim } = claimNames;
  const data: Claims = Object.assign({}, ...sources);
  // Roles and groups can be spread across the sources, so combine them
  const roles = unique(sources.flatMap(extractRoles)).filter(id);
  const groups = unique(sources.flatMap(v => v.groups || []));

  return {
    id: (
      idClaim
        ? data[idClaim]
        : data.oid || data.sub // Entra ID's `oid` is the same in every app, whereas its `sub` differs between apps
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
    username: (
      usernameClaim
        ? data[usernameClaim]
        : data.username || data.preferred_username || data.email || data.sub
    ),
    groups,
    roles,
    scopes: scopesFromClaims(data)
  };
};
