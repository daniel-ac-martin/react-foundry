import { createElement as h } from 'react';
import { render, screen } from '@react-foundry/component-test-helpers';
import Anchor from '../src/Anchor';

const activeClass = 'penultimate-anchor--active';

describe('Anchor', () => {
  describe('when given a href with a relative URL', () => {
    describe('and the URL is the current page', () => {
      beforeEach(async () => {
        render(h(Anchor, { href: '/current' }, 'My link'));
      });

      it('is a link', async () => expect(screen.getByRole('link')).toBeInTheDocument());
      it('to the HRef provided', async () => expect(screen.getByRole('link')).toHaveAttribute('href', '/current'));
      it('with the text provided', async () => expect(screen.getByRole('link')).toHaveTextContent('My link'));
      it('is marked as active', async () => expect(screen.getByRole('link')).toHaveClass(activeClass));
    });

    describe('and the URL is NOT the current page', () => {
      beforeEach(async () => {
        render(h(Anchor, { href: '/location' }, 'My link'));
      });

      it('is a link', async () => expect(screen.getByRole('link')).toBeInTheDocument());
      it('to the HRef provided', async () => expect(screen.getByRole('link')).toHaveAttribute('href', '/location'));
      it('with the text provided', async () => expect(screen.getByRole('link')).toHaveTextContent('My link'));
      it('is NOT marked as active', async () => expect(screen.getByRole('link')).not.toHaveClass(activeClass));
    });

    describe('and the URL is the parent of the current page', () => {
      describe('and the activeMatching prop is NOT set', () => {
        beforeEach(async () => {
          render(h(Anchor, { href: '/' }, 'My link'));
        });

        it('is a link', async () => expect(screen.getByRole('link')).toBeInTheDocument());
        it('to the HRef provided', async () => expect(screen.getByRole('link')).toHaveAttribute('href', '/'));
        it('with the text provided', async () => expect(screen.getByRole('link')).toHaveTextContent('My link'));
        it('is NOT marked as active', async () => expect(screen.getByRole('link')).not.toHaveClass(activeClass));
      });

      describe('and the activeMatching prop is set to \'strict\'', () => {
        beforeEach(async () => {
          render(h(Anchor, { href: '/', activeMatching: 'strict' }, 'My link'));
        });

        it('is a link', async () => expect(screen.getByRole('link')).toBeInTheDocument());
        it('to the HRef provided', async () => expect(screen.getByRole('link')).toHaveAttribute('href', '/'));
        it('with the text provided', async () => expect(screen.getByRole('link')).toHaveTextContent('My link'));
        it('is NOT marked as active', async () => expect(screen.getByRole('link')).not.toHaveClass(activeClass));
      });

      describe('and the activeMatching prop is set to \'loose\'', () => {
        beforeEach(async () => {
          render(h(Anchor, { href: '/', activeMatching: 'loose' }, 'My link'));
        });

        it('is a link', async () => expect(screen.getByRole('link')).toBeInTheDocument());
        it('to the HRef provided', async () => expect(screen.getByRole('link')).toHaveAttribute('href', '/'));
        it('with the text provided', async () => expect(screen.getByRole('link')).toHaveTextContent('My link'));
        it('is marked as active', async () => expect(screen.getByRole('link')).toHaveClass(activeClass));
      });
    });
  });

  describe('when given the active prop', () => {
    describe('and it is rendered', () => {
      // React warns about an unknown DOM attribute only once per test file, so this needs to be the first render with the active prop.
      const consoleError = console.error;
      let errors: string[] = [];

      beforeEach(async () => {
        errors = [];
        console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
        render(h(Anchor, { href: '/location', active: true }, 'My link'));
      });

      afterEach(() => {
        console.error = consoleError;
      });

      it('does NOT pass the active prop on to the element', async () => {
        expect(errors.filter(e => e.includes('active'))).toEqual([]);
        expect(screen.getByRole('link')).not.toHaveAttribute('active');
      });
    });

    describe('set to true and the URL is NOT the current page', () => {
      beforeEach(async () => {
        render(h(Anchor, { href: '/location', active: true }, 'My link'));
      });

      it('is a link', async () => expect(screen.getByRole('link')).toBeInTheDocument());
      it('to the HRef provided', async () => expect(screen.getByRole('link')).toHaveAttribute('href', '/location'));
      it('is marked as active', async () => expect(screen.getByRole('link')).toHaveClass(activeClass));
      it('is marked as the current page', async () => expect(screen.getByRole('link')).toHaveAttribute('aria-current', 'page'));
    });

    describe('set to false and the URL is the current page', () => {
      beforeEach(async () => {
        render(h(Anchor, { href: '/current', active: false }, 'My link'));
      });

      it('is a link', async () => expect(screen.getByRole('link')).toBeInTheDocument());
      it('to the HRef provided', async () => expect(screen.getByRole('link')).toHaveAttribute('href', '/current'));
      it('is NOT marked as active', async () => expect(screen.getByRole('link')).not.toHaveClass(activeClass));
      it('is NOT marked as the current page', async () => expect(screen.getByRole('link')).not.toHaveAttribute('aria-current'));
    });

    describe('left undefined and the URL is the current page', () => {
      beforeEach(async () => {
        render(h(Anchor, { href: '/current', active: undefined }, 'My link'));
      });

      it('is marked as active', async () => expect(screen.getByRole('link')).toHaveClass(activeClass));
      it('is marked as the current page', async () => expect(screen.getByRole('link')).toHaveAttribute('aria-current', 'page'));
    });

    describe('left undefined and the URL is NOT the current page', () => {
      beforeEach(async () => {
        render(h(Anchor, { href: '/location', active: undefined }, 'My link'));
      });

      it('is NOT marked as active', async () => expect(screen.getByRole('link')).not.toHaveClass(activeClass));
      it('is NOT marked as the current page', async () => expect(screen.getByRole('link')).not.toHaveAttribute('aria-current'));
    });
  });

  describe.skip('when given a href with an absolute URL', () => {
    beforeEach(async () => {
      render(h(Anchor, { href: '//example.com/location' }, 'My link'));
    });

    it('is a link', async () => expect(screen.getByRole('link')).toBeInTheDocument());
    it('to the HRef provided', async () => expect(screen.getByRole('link')).toHaveAttribute('href', '//example.com/location'));
    it('with the text provided', async () => expect(screen.getByRole('link')).toHaveTextContent('My link'));
  });

  describe('when given a href with a hash link', () => {
    beforeEach(async () => {
      render(h(Anchor, { href: '#top' }, 'My link'));
    });

    it('is a link', async () => expect(screen.getByRole('link')).toBeInTheDocument());
    it('to the HRef provided', async () => expect(screen.getByRole('link')).toHaveAttribute('href', '/current#top'));
    it('with the text provided', async () => expect(screen.getByRole('link')).toHaveTextContent('My link'));
  });

  describe('when given a href with a mailto', () => {
    beforeEach(async () => {
      render(h(Anchor, { href: 'mailto:user@example.com' }, 'My link'));
    });

    it('is a link', async () => expect(screen.getByRole('link')).toBeInTheDocument());
    it('to the HRef provided', async () => expect(screen.getByRole('link')).toHaveAttribute('href', 'mailto:user@example.com'));
    it('with the text provided', async () => expect(screen.getByRole('link')).toHaveTextContent('My link'));
  });
});
