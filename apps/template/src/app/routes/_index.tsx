import type { Route } from "./+types/_index";
import {
  A
} from '@react-foundry/components';
import { siteTitle } from '../config';

export const title = 'Home';
const description = 'Our homepage';

export function meta({}: Route.MetaArgs) {
  return [
    { title: `${title} - ${siteTitle}` },
    { name: 'description', content: description },
    { name: 'og:title', content: title },
    { name: 'og:description', content: description },
  ];
}

export default function Home() {
  return (
    <>
      <h1>This is React Foundry!</h1>
      <p>Welcome to React Foundry.</p>
      <A href="/forms">Start</A>
      <p>Or see the <A href="/sitemap#subpages">subpages in the sitemap</A>.</p>
    </>
  );
}
