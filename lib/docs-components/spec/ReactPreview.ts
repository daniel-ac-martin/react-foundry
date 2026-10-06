import type { FC } from 'react';

import { createElement as h } from 'react';
import { renderToSource } from '../src/ReactPreview';

const Component: FC<any> = () => null;
Component.displayName = 'Component';

describe('renderToSource', () => {
  const source = (props: object) => renderToSource(h(Component, props));

  it('renders a prop set to a string', async () => expect(source({ name: 'x' })).toEqual('<Component name="x" />'));
  it('drops a prop set to false', async () => expect(source({ day: false })).toEqual('<Component />'));
  it('shortens a prop set to true', async () => expect(source({ start: true })).toEqual('<Component start />'));
  it('omits a prop set to undefined, but keeps its place in the layout', async () => expect(source({ hint: undefined, name: 'x' })).toEqual('<Component\n  name="x"\n/>'));
  it('omits only the first prop set to undefined', async () => expect(source({ a: undefined, b: undefined, name: 'x' })).toEqual('<Component\n  b={undefined}\n  name="x"\n/>'));
});
