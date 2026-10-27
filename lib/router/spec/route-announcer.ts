import type { ReactNode } from 'react';
import type { Root } from 'react-dom/client';
import { StrictMode, act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { Link, MemoryRouter, Outlet, RouterProvider, createMemoryRouter } from 'react-router';
import { screen, userEvent, waitFor } from '@react-foundry/component-test-helpers';
import { RouteAnnouncer } from '../src/index';

const page = (title: string, ...children: ReactNode[]) => () => h('main', {},
  h('title', {}, title),
  h('h1', {}, title),
  ...children
);

const Layout = () => h('div', {},
  h('nav', {},
    h(Link, { to: '/' }, 'Home'),
    h(Link, { to: '/other' }, 'Other'),
    h(Link, { to: '/?page=2' }, 'Next page'),
    h(Link, { to: '/?sort=name', preventScrollReset: true }, 'Sort'),
    h(Link, { to: '/#section' }, 'Section'),
    h(Link, { to: '/other#target' }, 'Target'),
    h(Link, { to: '/other#missing' }, 'Missing target'),
    h(Link, { to: '/form' }, 'Form')
  ),
  h(Outlet),
  h(RouteAnnouncer)
);

const routes = [
  {
    path: '/',
    Component: Layout,
    children: [
      {
        index: true,
        Component: page('Home page', h('h2', { id: 'section' }, 'Section'))
      },
      {
        path: 'other',
        Component: page('Other page', h('h2', { id: 'target' }, 'Target'))
      },
      {
        path: 'form',
        Component: page('Form page', h('input', { 'aria-label': 'Name', autoFocus: true }))
      }
    ]
  }
];

describe('RouteAnnouncer', () => {
  const user = userEvent.setup();
  const liveRegion = () => document.querySelector('[aria-live]')!;
  let root: Root | undefined;

  const renderAt = async (url: string, strict: boolean = false) => {
    const container = document.body.appendChild(document.createElement('div'));
    const router = createMemoryRouter(routes, { initialEntries: [ url ] });
    const app = h(RouterProvider, { router });

    root = createRoot(container);
    await act(async () => root!.render(strict ? h(StrictMode, {}, app) : app));
  };

  const follow = async (text: string) => {
    await user.click(screen.getByRole('link', { name: text }));
  };

  afterEach(async () => {
    await act(async () => root?.unmount());
    document.body.innerHTML = '';
    document.head.innerHTML = '';
    document.body.removeAttribute('tabindex');
  });

  describe('when rendered on the server', () => {
    const html = renderToString(h(MemoryRouter, {}, h(RouteAnnouncer)));

    it('renders nothing (so that no inline styles are needed)', async () => expect(html).toEqual(''));
  });

  describe('on the initial render', () => {
    beforeEach(async () => {
      await renderAt('/', true);
    });

    it('renders a live region once mounted', async () => expect(liveRegion()).toHaveAttribute('aria-live', 'assertive'));
    it('that is atomic', async () => expect(liveRegion()).toHaveAttribute('aria-atomic', 'true'));
    it('that is empty', async () => expect(liveRegion()).toBeEmptyDOMElement());
    it('does NOT move focus', async () => expect(document.activeElement).toBe(document.body));
    it('does NOT make the body focusable', async () => expect(document.body).not.toHaveAttribute('tabindex'));
  });

  describe('when following a link to a new page', () => {
    beforeEach(async () => {
      await renderAt('/');
      await follow('Other');
    });

    it('navigates', async () => expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Other page'));
    it('moves focus off the link that was followed', async () => expect(screen.getByRole('link', { name: 'Other' })).not.toHaveFocus());
    it('moves focus to the start of the document', async () => expect(document.activeElement).toBe(document.body));
    it('announces the title of the new page', async () => expect(liveRegion()).toHaveTextContent('Other page'));

    describe('and then moving focus elsewhere', () => {
      beforeEach(async () => {
        await act(async () => screen.getByRole('link', { name: 'Home' }).focus());
      });

      it('does NOT leave the body focusable', async () => expect(document.body).not.toHaveAttribute('tabindex'));
    });

    describe('and then going back', () => {
      beforeEach(async () => {
        await user.click(screen.getByRole('link', { name: 'Other' }));
        await act(async () => { window.history.back(); });
        await follow('Home');
      });

      it('announces the title of the page', async () => expect(liveRegion()).toHaveTextContent('Home page'));
    });
  });

  describe('when following a link to the same page with a different query string', () => {
    beforeEach(async () => {
      await renderAt('/');
      await follow('Other');
      await follow('Home');
      await follow('Next page');
    });

    it('moves focus to the start of the document', async () => expect(document.activeElement).toBe(document.body));
    it('announces the title again, even though it has not changed', async () => expect(liveRegion().textContent).not.toEqual('Home page'));
    it('in a way that reads the same', async () => expect(liveRegion()).toHaveTextContent('Home page'));
  });

  describe('when following a link that prevents the scroll position from being reset', () => {
    beforeEach(async () => {
      await renderAt('/');
      await follow('Sort');
    });

    it('leaves focus on the link', async () => expect(screen.getByRole('link', { name: 'Sort' })).toHaveFocus());
    it('does NOT announce anything', async () => expect(liveRegion()).toBeEmptyDOMElement());
  });

  describe('when following a link to a different part of the same page', () => {
    beforeEach(async () => {
      await renderAt('/');
      await follow('Section');
    });

    it('leaves focus on the link', async () => expect(screen.getByRole('link', { name: 'Section' })).toHaveFocus());
    it('does NOT announce anything', async () => expect(liveRegion()).toBeEmptyDOMElement());
  });

  describe('when following a link to a specific part of a new page', () => {
    beforeEach(async () => {
      await renderAt('/');
      await follow('Target');
    });

    it('moves focus to the target', async () => expect(screen.getByRole('heading', { name: 'Target' })).toHaveFocus());
    it('announces the title of the new page', async () => expect(liveRegion()).toHaveTextContent('Other page'));

    describe('and then moving focus elsewhere', () => {
      beforeEach(async () => {
        await user.tab();
      });

      it('does NOT leave the target focusable', async () => expect(screen.getByRole('heading', { name: 'Target' })).not.toHaveAttribute('tabindex'));
    });
  });

  describe('when following a link to a missing part of a new page', () => {
    beforeEach(async () => {
      await renderAt('/');
      await follow('Missing target');
    });

    it('moves focus to the start of the document', async () => expect(document.activeElement).toBe(document.body));
    it('announces the title of the new page', async () => expect(liveRegion()).toHaveTextContent('Other page'));
  });

  describe('when following a link to a page that moves focus itself', () => {
    beforeEach(async () => {
      await renderAt('/');
      await follow('Form');
    });

    it('leaves focus where the page put it', async () => expect(screen.getByRole('textbox', { name: 'Name' })).toHaveFocus());
    it('does NOT announce anything', async () => expect(liveRegion()).toBeEmptyDOMElement());
  });

  describe('when the page has no title', () => {
    beforeEach(async () => {
      await renderAt('/');
      await follow('Other');
      await act(async () => { document.title = ''; });
      await follow('Home');
    });

    it('announces the main heading instead', async () => waitFor(() => expect(liveRegion()).toHaveTextContent('Home page')));
  });
});
