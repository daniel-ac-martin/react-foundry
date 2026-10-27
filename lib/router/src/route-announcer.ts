'use client';

import type { CSSProperties, FC } from 'react';
import { createElement as h, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { UNSAFE_DataRouterStateContext, useLocation } from 'react-router';
import { useIsMounted } from '@react-foundry/client-component-helpers';

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

// Where a screen reader user would want to start reading a new page. User
// testing by Gatsby found that focusing the main heading after a client-side
// navigation worked better for screen reader users than going back to the top
// of the page, which made them listen to the header and navigation again:
// https://www.gatsbyjs.com/blog/2019-07-11-user-testing-accessible-client-routing/
// Failing that we use the main content, then the first main heading on the page
// (which may not be in the content, but usually is), and failing that the
// start of the document, as a full page load would.
const getStartOfContent = (): HTMLElement => {
  const main = document.querySelector('main');

  return (
    main?.querySelector('h1') ||
    main ||
    document.querySelector('h1') ||
    document.body
  );
};

const isHeading = (el: HTMLElement): boolean => /^H[1-6]$/.test(el.tagName);

// Moves focus to an element that may not normally be focusable, without
// scrolling, in the same way as the GOV.UK skip link. This also moves the
// 'sequential focus navigation starting point', so that the next Tab press
// starts from here.
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
 * - moves focus to the element targeted by the URL's hash or, failing that,
 *   to the start of the content (the main heading, the main element, any
 *   main heading or the start of the document), so that screen readers and
 *   keyboard users start from the new content; and
 * - announces the new page's title via a (polite) live region, unless focus
 *   moved to a heading, which screen readers will read out instead.
 *
 * It leaves things alone when:
 * - only the hash has changed (the browser handles in-page links);
 * - the navigation asked for the scroll position to be preserved (i.e.
 *   `preventScrollReset`), as this suggests an update to the current page
 *   rather than a new one; or
 * - something else, such as an `autoFocus` field, has already moved focus.
 */
export const RouteAnnouncer: FC = () => {
  const { key, pathname, search, hash } = useLocation();
  // Only available in data routers; this is what <ScrollRestoration> uses
  const routerState = useContext(UNSAFE_DataRouterStateContext);
  const preventScrollReset = !!routerState?.preventScrollReset;
  const previous = useRef({ key, pathname, search });
  const isMounted = useIsMounted();
  const [ message, setMessage ] = useState('');
  // Record what had focus before the new page is committed to the DOM, so that
  // we can tell whether anything moved focus while rendering it.
  const focusedBefore = useMemo(
    () => typeof document === 'undefined' ? null : document.activeElement,
    [ key ]
  );

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

    if (!target && preventScrollReset) {
      return;
    }

    const focusTarget = target || getStartOfContent();

    // If React Router adopts the Navigation API, the browser's own focus reset
    // (to <body>) could undo this, unless it uses `focusReset: 'manual'`.
    moveFocus(focusTarget);

    // Screen readers read out a heading when it receives focus, which tells
    // the user where they now are, so announcing the title as well would only
    // repeat it. (And it would be read out after the heading, rather than
    // before it, as it would be after a full page load.)
    if (isHeading(focusTarget)) {
      return;
    }

    const title = (
      document.title ||
      document.querySelector('h1')?.textContent ||
      pathname
    );

    setMessage(prevMessage => nextMessage(title, prevMessage));
  }, [ key ]);

  // We only render the live region in the browser, where React applies its
  // styles via the CSSOM, as a strict Content Security Policy would block an
  // inline style attribute in server-rendered markup.
  // Polite, so that the announcement does not interrupt the screen reader
  // reading out the element that we moved focus to.
  return isMounted && h('div', {
    'aria-live': 'polite',
    'aria-atomic': true,
    style: visuallyHidden
  }, message);
};
