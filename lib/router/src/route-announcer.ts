import type { CSSProperties, FC } from 'react';
import { createElement as h, useEffect, useMemo, useRef, useState } from 'react';

export type RouteChange = {
  key: string,
  pathname: string,
  search: string,
  hash: string,
  preventScrollReset: boolean
};

export type UseRouteChange = () => RouteChange;

const visuallyHidden: CSSProperties = {
  position: 'absolute',
  width: '1px',
  height: '1px',
  margin: '-1px',
  padding: 0,
  border: 0,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  clipPath: 'inset(50%)',
  whiteSpace: 'nowrap'
};

const getHashTarget = (hash: string): HTMLElement | null => {
  try {
    return hash ? document.getElementById(decodeURIComponent(hash.slice(1))) : null;
  } catch {
    return null;
  }
};

// Moves focus to an element that may not normally be focusable, without
// scrolling, in the same way as the GOV.UK skip link. This also moves the
// 'sequential focus navigation starting point', so that the next Tab press
// starts from here, as it would after a full page load.
const moveFocus = (el: HTMLElement): void => {
  if (!el.hasAttribute('tabindex')) {
    el.setAttribute('tabindex', '-1');
    el.addEventListener('blur', () => el.removeAttribute('tabindex'), { once: true });
  }

  el.focus({ preventScroll: true, focusVisible: false } as FocusOptions);
};

// Live regions only announce changes, so we make sure that the text changes
// even when we navigate between pages with the same title.
const nextMessage = (title: string, previous: string): string => (
  title === previous
    ? title + ' '
    : title
);

/**
 * Makes client-side navigation behave more like a full page load for users of
 * assistive technology. After each navigation (but not the first render) it:
 * - moves focus back to the start of the document (or to the element
 *   targeted by the URL's hash), so that screen readers and keyboard users
 *   start from the top of the new page; and
 * - announces the new page's title via a live region.
 *
 * It leaves things alone when:
 * - only the hash has changed (the browser handles in-page links);
 * - the navigation asked for the scroll position to be preserved (i.e.
 *   `preventScrollReset`), as this suggests an update to the current page
 *   rather than a new one; or
 * - something else, such as an `autoFocus` field, has already moved focus.
 */
export const makeRouteAnnouncer = (useRouteChange: UseRouteChange): FC => () => {
  const { key, pathname, search, hash, preventScrollReset } = useRouteChange();
  const previous = useRef({ key, pathname, search });
  const [ mounted, setMounted ] = useState(false);
  const [ message, setMessage ] = useState('');
  // Record what had focus before the new page is committed to the DOM, so that
  // we can tell whether anything moved focus while rendering it.
  const focusedBefore = useMemo(
    () => typeof document === 'undefined' ? null : document.activeElement,
    [ key ]
  );

  // We only render the live region in the browser, where React applies its
  // styles via the CSSOM, as a strict Content Security Policy would block an
  // inline style attribute in server-rendered markup.
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    const prev = previous.current;

    if (key === prev.key) {
      return;
    }

    previous.current = { key, pathname, search };

    if (pathname === prev.pathname && search === prev.search) {
      return;
    }

    const active = document.activeElement;

    if (active && active !== document.body && active !== focusedBefore) {
      return;
    }

    const target = getHashTarget(hash);

    if (target) {
      moveFocus(target);
    } else if (!preventScrollReset) {
      moveFocus(document.body);
    } else {
      return;
    }

    const title = (
      document.title ||
      document.querySelector('h1')?.textContent ||
      pathname
    );

    setMessage(prevMessage => nextMessage(title, prevMessage));
  }, [ key ]);

  return mounted && h('div', {
    'aria-live': 'assertive',
    'aria-atomic': true,
    style: visuallyHidden
  }, message);
};
