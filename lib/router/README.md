React Foundry - Router
======================

An abstraction layer over the routers from react-router and Next.js.


Using this package
------------------

First install the package into your project:

```shell
npm install -S @react-foundry/router
```

Then use it in your code as follows:

```js
import router from '@react-foundry/router';

// WRITEME

```


### Accessible client-side navigation

When JavaScript is unavailable, following a link loads a new document, so
screen readers announce the new page and start reading from the top, and
keyboard focus starts again from the top of the page. Client-side navigation
does none of this by default; focus stays on the link that was followed and
nothing is announced.

`RouteAnnouncer` restores this behaviour, and goes a little further. Render it
once, inside your router, alongside `<ScrollRestoration />`:

```jsx
import { RouteAnnouncer } from '@react-foundry/router';

// ...
<body>
  {children}
  <RouteAnnouncer />
  <ScrollRestoration />
  <Scripts />
</body>
```

After each navigation (but not on the initial page load) it moves focus to the
first of the following that it finds:
1. the element targeted by the URL's hash;
2. the first `<h1>` inside `<main>`;
3. `<main>`;
4. the first `<h1>` anywhere in the document;
5. the start of the document, as a full page load would.

Screen readers read out a heading when it receives focus, so that is enough to
tell the user where they are. Otherwise, it also announces the new page's title
via a (polite) live region.

Moving focus to the main heading means that screen reader users start reading
the new content straight away, rather than hearing the header and navigation
again. User testing by Gatsby found that this worked well; see
[What we learned from user testing of accessible client-side routing
techniques](https://www.gatsbyjs.com/blog/2019-07-11-user-testing-accessible-client-routing/).
One consequence is that the next press of Tab moves to the first focusable
element after the heading, skipping any skip link and the site navigation.

This works best when every page has a `<main>` element containing an `<h1>`.
Without `<main>` we cannot tell whether the first `<h1>` is the page's heading,
so if, for example, your site's header puts the site name in an `<h1>`, focus
will land there instead.

It does nothing when:
- only the URL's hash changed (e.g. a link within the page);
- the navigation used `preventScrollReset`, which we take to mean an update to
  the current page (such as sorting or filtering) rather than a new page; or
- something else, such as an `autoFocus` field, has already moved focus.

With Next.js, `RouteAnnouncer` renders nothing, as Next.js provides its own
route announcer.


Working on this package
-----------------------

Before working on this package you must install its dependencies using
the following command:

```shell
pnpm install
```


### Building

```shell
npm run build
```


### Clean-up

```shell
npm run clean
```
