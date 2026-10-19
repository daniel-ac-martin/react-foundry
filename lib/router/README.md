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

`RouteAnnouncer` restores this behaviour. Render it once, inside your router,
alongside `<ScrollRestoration />`:

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
start of the document, or to the element targeted by the URL's hash, and
announces the new page's title via a live region.

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
