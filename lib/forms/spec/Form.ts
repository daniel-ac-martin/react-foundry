import type { FormProps } from '../src/index';
import { createElement as h } from 'react';
import { render } from '@react-foundry/component-test-helpers';
import Form from '../src/index';

describe('Form', () => {
  const minimalProps: FormProps<any> = {
    action: '.',
    method: 'get'
  };

  describe('when given minimal valid props', () => {
    let form: HTMLFormElement | null;

    beforeEach(async () => {
      const { container } = render(h(Form, minimalProps, 'Child'));

      form = container.querySelector('form');
    });

    it('renders a form', async () => expect(form).toBeInTheDocument());
    it('with the children provided', async () => expect(form).toHaveTextContent('Child'));
  });
});
