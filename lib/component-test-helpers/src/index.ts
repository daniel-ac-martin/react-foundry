import { FC, ReactElement, ReactNode, createElement as h } from 'react';
import { MemoryRouter } from 'react-router';
import { render as _render, RenderOptions } from '@testing-library/react';

import '@testing-library/jest-dom';

const Providers: FC<{ children?: ReactNode, routerProps?: object }> = ({
  children,
  routerProps
}) => (
  h(MemoryRouter, routerProps || {
    initialEntries: ['/previous', '/current', '/next'],
    initialIndex: 1
  }, children)
);

export const render = (
  ui: ReactElement,
  options?: Omit<RenderOptions, 'wrapper'>,
): ReturnType<typeof _render> => _render(
  ui,
  {
    wrapper: Providers,
    ...options
  }
)

export * from '@testing-library/react';
export * from '@testing-library/user-event';
