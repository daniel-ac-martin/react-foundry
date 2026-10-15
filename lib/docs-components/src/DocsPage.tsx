import { ComponentType, FC, createElement as h } from 'react';
import { StandardProps, classBuilder } from '@react-foundry/component-helpers';
import { DocsContext } from './context';

export type StoriesModule = Record<string, unknown> & {
  default: ComponentType<unknown>
  meta?: {
    component?: ComponentType<unknown> | undefined
    includeStories?: string[] | undefined
    parameters?: {
      description?: string | undefined
      image?: string | undefined
    } | undefined
    title?: string | undefined
  } | undefined
};

export type DocsPageProps = StandardProps & {
  stories: StoriesModule
};

export const DocsPage: FC<DocsPageProps> = ({
  classBlock,
  classModifiers,
  className,
  stories,
  ...attrs
}) => {
  const classes = classBuilder('penultimate-docs-page', classBlock, classModifiers, className);
  const Content = stories.default;
  const contextValue = {
    args: {},
    meta: {},
    stories: {}
  };

  return (
    <div {...attrs} className={classes()}>
      <DocsContext.Provider value={contextValue}>
        <Content />
      </DocsContext.Provider>
    </div>
  );
};
