import type { UseIsActive } from './is-active';
import type { UseLocation } from './location';
import type { UseRouteChange } from './route-announcer';

import { useContext } from 'react';
import { UNSAFE_DataRouterStateContext, useLocation as _useLocation } from 'react-router';
import { makeUseIsActive } from './is-active';
import { makeUseLocation } from './location';
import { makeRouteAnnouncer } from './route-announcer';

export const needSuspense = false;

export const useLocation: UseLocation = makeUseLocation(_useLocation);
export const useIsActive: UseIsActive = makeUseIsActive(useLocation);

const useRouteChange: UseRouteChange = () => {
  const { key, pathname, search, hash } = _useLocation();
  // Only available in data routers; this is what <ScrollRestoration> uses
  const routerState = useContext(UNSAFE_DataRouterStateContext);

  return {
    key,
    pathname,
    search,
    hash,
    preventScrollReset: !!routerState?.preventScrollReset
  };
};

export const RouteAnnouncer = makeRouteAnnouncer(useRouteChange);

export {
  Link,
  useNavigate,
  useParams
} from 'react-router';
export type { LinkProps } from './dummy';
