import type { Route } from "./+types/search";
import { Form } from '@react-foundry/components';
import { Link, useLocation } from '@react-foundry/router';
import { siteTitle } from '../config';

export const title = 'Search';
const description = 'Example of a search form.';

const prettyPrint = (obj: object) => JSON.stringify(obj, undefined, 2);

export function meta({}: Route.MetaArgs) {
  return [
    { title: `${title} - ${siteTitle}` },
    { name: 'description', content: description },
    { name: 'og:title', content: title },
    { name: 'og:description', content: description },
  ];
}

export default function Search() {
  const location = useLocation();

  return (
    <>
      <div className="grid-row">
        <div className="grid-column-two-thirds">
          <h1>{title}</h1>
          <Form action="?" method="get" initialValues={{ q: location.query['q'] }}>
            <Form.Input type="text" name="q" />
            <Form.Submit>Search</Form.Submit>
          </Form>
          <p>
            {/* These update the results in place, rather than loading a new page */}
            Try searching for <Link to="?q=react" preventScrollReset>react</Link> or <Link to="?q=foundry" preventScrollReset>foundry</Link>.
          </p>
          <h2>Result</h2>
        </div>
      </div>
      <div className="grid-row">
        <div className="grid-column-one-half">
          <h3>GET</h3>
          <pre>
            {prettyPrint(location.query)}
          </pre>
        </div>
        <div className="grid-column-one-half">
          <h3>POST</h3>
          <pre>
            {prettyPrint(location.state)}
          </pre>
        </div>
      </div>
    </>
  );
}
