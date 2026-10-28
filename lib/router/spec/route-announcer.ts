import type { ReactNode } from 'react';
import type { Root } from 'react-dom/client';
import { StrictMode, act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { Link, MemoryRouter, Outlet, RouterProvider, createMemoryRouter } from 'react-router';
import { screen, userEvent } from '@react-foundry/component-test-helpers';
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
    h(Link, { to: '/other#paragraph' }, 'Paragraph'),
    h(Link, { to: '/form' }, 'Form'),
    h(Link, { to: '/no-heading' }, 'No heading'),
    h(Link, { to: '/no-heading?page=2' }, 'No heading, page 2'),
    h(Link, { to: '/no-main' }, 'No main'),
    h(Link, { to: '/nothing' }, 'Nothing'),
    h(Link, { to: '/untitled' }, 'Untitled'),
    h(Link, { to: '/untitled-without-heading' }, 'Untitled without heading')
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
        Component: page('Other page', h('h2', { id: 'target' }, 'Target'), h('p', { id: 'paragraph' }, 'Paragraph'))
      },
      {
        path: 'form',
        Component: page('Form page', h('input', { 'aria-label': 'Name', autoFocus: true }))
      },
      {
        path: 'no-heading',
        Component: () => h('main', {}, h('title', {}, 'No heading page'), h('p', {}, 'Content'))
      },
      {
        path: 'no-main',
        Component: () => h('div', {}, h('title', {}, 'No main page'), h('h1', {}, 'No main page'))
      },
      {
        path: 'nothing',
        Component: () => h('div', {}, h('title', {}, 'Nothing page'), h('p', {}, 'Content'))
      },
      {
        path: 'untitled',
        Component: () => h('div', {}, h('h1', {}, 'Untitled page'), h('main', {}, h('p', {}, 'Content')))
      },
      {
        path: 'untitled-without-heading',
        Component: () => h('main', {}, h('p', {}, 'Content'))
      }
    ]
  }
];

describe('RouteAnnouncer', () => {
  const user = userEvent.setup();
  const liveRegion = () => document.querySelector('[aria-live]')!;
  let root: Root | undefined;
  let router: ReturnType<typeof createMemoryRouter>;

  const renderAt = async (url: string, strict: boolean = false) => {
    const container = document.body.appendChild(document.createElement('div'));
    router = createMemoryRouter(routes, { initialEntries: [ url ] });
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

    it('renders a live region once mounted', async () => expect(liveRegion()).toHaveAttribute('aria-live', 'polite'));
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
    it('moves focus to the main heading', async () => expect(screen.getByRole('heading', { level: 1 })).toHaveFocus());
    it('does NOT announce anything (as the heading will be read out)', async () => expect(liveRegion()).toBeEmptyDOMElement());

    describe('and then moving focus elsewhere', () => {
      beforeEach(async () => {
        await act(async () => screen.getByRole('link', { name: 'Home' }).focus());
      });

      it('does NOT leave the heading focusable', async () => expect(screen.getByRole('heading', { level: 1 })).not.toHaveAttribute('tabindex'));
    });

    describe('and then going back', () => {
      beforeEach(async () => {
        await act(async () => router.navigate(-1));
      });

      it('returns to the previous page', async () => expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Home page'));
      it('moves focus to the main heading', async () => expect(screen.getByRole('heading', { level: 1 })).toHaveFocus());
    });
  });

  describe('when following a link to the same page with a different query string', () => {
    beforeEach(async () => {
      await renderAt('/');
      await follow('Next page');
    });

    it('moves focus to the main heading', async () => expect(screen.getByRole('heading', { level: 1 })).toHaveFocus());
    it('does NOT announce anything', async () => expect(liveRegion()).toBeEmptyDOMElement());
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

  describe('when following a link to a heading on a new page', () => {
    beforeEach(async () => {
      await renderAt('/');
      await follow('Target');
    });

    it('moves focus to the heading', async () => expect(screen.getByRole('heading', { name: 'Target' })).toHaveFocus());
    it('does NOT announce anything (as the heading will be read out)', async () => expect(liveRegion()).toBeEmptyDOMElement());

    describe('and then moving focus elsewhere', () => {
      beforeEach(async () => {
        await user.tab();
      });

      it('does NOT leave the target focusable', async () => expect(screen.getByRole('heading', { name: 'Target' })).not.toHaveAttribute('tabindex'));
    });
  });

  describe('when following a link to another part of a new page', () => {
    beforeEach(async () => {
      await renderAt('/');
      await follow('Paragraph');
    });

    it('moves focus to the target', async () => expect(screen.getByText('Paragraph', { selector: 'p' })).toHaveFocus());
    it('announces the title of the new page', async () => expect(liveRegion()).toHaveTextContent('Other page'));
  });

  describe('when following a link to a missing part of a new page', () => {
    beforeEach(async () => {
      await renderAt('/');
      await follow('Missing target');
    });

    it('moves focus to the main heading', async () => expect(screen.getByRole('heading', { level: 1 })).toHaveFocus());
    it('does NOT announce anything (as the heading will be read out)', async () => expect(liveRegion()).toBeEmptyDOMElement());
  });

  describe('when following a link to a page without a main heading', () => {
    beforeEach(async () => {
      await renderAt('/');
      await follow('No heading');
    });

    it('moves focus to the main content', async () => expect(screen.getByRole('main')).toHaveFocus());
    it('announces the title of the new page', async () => expect(liveRegion()).toHaveTextContent('No heading page'));

    describe('and then following a link to the same page with a different query string', () => {
      beforeEach(async () => {
        await follow('No heading, page 2');
      });

      it('moves focus to the main content', async () => expect(screen.getByRole('main')).toHaveFocus());
      it('announces the title again, even though it has not changed', async () => expect(liveRegion().textContent).not.toEqual('No heading page'));
      it('in a way that reads the same', async () => expect(liveRegion()).toHaveTextContent('No heading page'));
    });
  });

  describe('when following a link to a page without a main element', () => {
    beforeEach(async () => {
      await renderAt('/');
      await follow('No main');
    });

    it('moves focus to the main heading', async () => expect(screen.getByRole('heading', { level: 1 })).toHaveFocus());
    it('does NOT announce anything (as the heading will be read out)', async () => expect(liveRegion()).toBeEmptyDOMElement());
  });

  describe('when following a link to a page without a main element or a main heading', () => {
    beforeEach(async () => {
      await renderAt('/');
      await follow('Nothing');
    });

    it('moves focus off the link that was followed', async () => expect(screen.getByRole('link', { name: 'Nothing' })).not.toHaveFocus());
    it('moves focus to the start of the document', async () => expect(document.activeElement).toBe(document.body));
    it('announces the title of the new page', async () => expect(liveRegion()).toHaveTextContent('Nothing page'));
  });

  describe('when following a link to a page that moves focus itself', () => {
    beforeEach(async () => {
      await renderAt('/');
      await follow('Form');
    });

    it('leaves focus where the page put it', async () => expect(screen.getByRole('textbox', { name: 'Name' })).toHaveFocus());
    it('does NOT announce anything', async () => expect(liveRegion()).toBeEmptyDOMElement());
  });

  describe('when following a link to a page that has no title', () => {
    beforeEach(async () => {
      await renderAt('/');
      await follow('Untitled');
    });

    it('moves focus to the main content', async () => expect(screen.getByRole('main')).toHaveFocus());
    it('announces the main heading instead', async () => expect(liveRegion()).toHaveTextContent('Untitled page'));
  });

  describe('when following a link to a page that has no title or main heading', () => {
    beforeEach(async () => {
      await renderAt('/');
      await follow('Untitled without heading');
    });

    it('moves focus to the main content', async () => expect(screen.getByRole('main')).toHaveFocus());
    it('announces the path instead', async () => expect(liveRegion()).toHaveTextContent('/untitled-without-heading'));
  });
});
