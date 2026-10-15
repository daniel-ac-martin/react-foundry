import type { Meta } from '@storybook/react';

import { ComponentType, Context, createContext, useContext } from 'react';

export type DocsContextValue = {
  args: object
  component?: ComponentType<unknown> | undefined
  description?: string | undefined
  meta: Meta
  stories: Record<string, object>
  title?: string | undefined
};

const defaultValue: DocsContextValue = {
  args: {},
  meta: {},
  stories: {}
};

export const DocsContext = createContext(defaultValue);
export const useDocs = () => useContext(DocsContext);
