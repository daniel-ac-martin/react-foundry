import type { FC } from 'react';
import { Fragment, createElement as h } from 'react';
import { render, screen, userEvent } from '@react-foundry/component-test-helpers';
import { useLocation } from '@react-foundry/router';
import Form, { Page, withForm } from '../src/index';
import { required } from '../src/validators';

const parts = ['day', 'month', 'year'] as const;

const RawField: FC<any> = ({ day, error, month, name, value, year, ...attrs }) => {
  const asked = { day, month, year };

  return h(
    Fragment,
    {},
    ...parts
      .filter(part => asked[part] !== false)
      .map(part => h('input', {
        ...attrs,
        key: part,
        'aria-label': part,
        name: `${name}[${part}]`,
        value: (value && value[part]) || ''
      })),
    h('output', {}, JSON.stringify(error || null))
  );
};

const Field = withForm(RawField, [], {
  day: [required('Enter a day')],
  month: [required('Enter a month')],
  year: [required('Enter a year')]
});

const Destination: FC<{}> = () => h('data', { 'aria-label': 'destination' }, useLocation().pathname);

describe('withForm', () => {
  const renderField = (props: object = {}) => render(
    h(Fragment, {},
      h(Destination),
      h(Form, { action: '/done', method: 'get' } as any,
        h(Page, {},
          h(Field, { name: 'date', ...props } as any),
          h('button', { type: 'submit' }, 'Continue')
        )
      )
    )
  );
  const enter = (part: string, value: string) =>
    userEvent.type(screen.getByLabelText(part), value);
  const submit = () => userEvent.click(screen.getByRole('button'));
  const errors = () => screen.getByRole('status');
  const destination = () => screen.getByLabelText('destination');

  describe('when nothing has been entered', () => {
    beforeEach(async () => {
      renderField();
      await submit();
    });

    it('does not ask for any of the parts', async () => expect(destination()).toHaveTextContent('/done'));
  });

  describe('when only some of the parts have been entered', () => {
    beforeEach(async () => {
      renderField();
      await enter('month', '11');
      await enter('year', '2007');
      await submit();
    });

    it('asks for the part that is missing', async () => expect(errors()).toHaveTextContent('Enter a day'));
    it('does not ask for the parts that are present', async () => expect(errors()).not.toHaveTextContent('Enter a month'));
    it('does not submit', async () => expect(destination()).toHaveTextContent('/current'));
  });

  describe('when a part has been switched off', () => {
    beforeEach(async () => {
      renderField({ day: false });
      await enter('month', '11');
      await enter('year', '2007');
      await submit();
    });

    it('does not render it', async () => expect(screen.queryByLabelText('day')).not.toBeInTheDocument());
    it('does not ask for it', async () => expect(destination()).toHaveTextContent('/done'));
  });

  describe('when every part has been entered', () => {
    beforeEach(async () => {
      renderField();
      await enter('day', '12');
      await enter('month', '11');
      await enter('year', '2007');
      await submit();
    });

    it('asks for nothing', async () => expect(destination()).toHaveTextContent('/done'));
  });
});
