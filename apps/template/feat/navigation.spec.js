// Note: Every page here has a main heading, so focus always moves to a heading
// and nothing is announced. We can't check that focus moves to the start of the
// document (and the title is announced) on pages without one, as Cypress's
// replacement for HTMLElement.focus() ignores calls on <body>. This is covered
// by the unit tests in @react-foundry/router instead.

const focusesHeading = () => {
  it('moves focus to the main heading', () => {
    cy.focused().should('match', 'h1');
  });
};

const announcesNothing = () => {
  it('does NOT announce anything', () => {
    cy.get('[aria-live]').should('be.empty');
  });
};

describe('Client-side navigation', () => {
  describe('when following a link to another page', () => {
    before(() => {
      cy.visitReady('/');
      cy.contains('a', 'Forms').focus().click();
    });

    it('navigates to the page', () => {
      cy.location('pathname').should('eq', '/forms');
    });

    focusesHeading();
    announcesNothing();
  });

  describe('when following a link to a page that shares a layout', () => {
    before(() => {
      cy.visitReady('/sub/one');
      cy.contains('.grid-column-one-third a', 'Two').focus().click();
    });

    it('navigates to the page', () => {
      cy.location('pathname').should('eq', '/sub/two');
    });

    focusesHeading();
    announcesNothing();
  });

  describe('when submitting a search', () => {
    before(() => {
      cy.visitReady('/');
      cy.contains('a', 'Search').click();
      cy.get('input[name="q"]').type('cats');
      cy.contains('button', 'Search').click();
    });

    it('updates the URL', () => {
      cy.location('search').should('eq', '?q=cats');
    });

    focusesHeading();
    announcesNothing();
  });

  describe('when following a link that preserves the scroll position', () => {
    before(() => {
      cy.visitReady('/search');
      cy.contains('a', 'react').focus().click();
    });

    it('updates the URL', () => {
      cy.location('search').should('eq', '?q=react');
    });

    it('leaves focus on the link', () => {
      cy.focused().should('have.text', 'react');
    });

    announcesNothing();
  });

  describe('when following a link to a specific part of another page', () => {
    before(() => {
      cy.visitReady('/');
      cy.contains('a', 'subpages in the sitemap').focus().click();
    });

    it('navigates to the page', () => {
      cy.location('pathname').should('eq', '/sitemap');
      cy.location('hash').should('eq', '#subpages');
    });

    it('moves focus to the target', () => {
      cy.focused().should('have.id', 'subpages');
    });

    announcesNothing();
  });

  describe('when following a link to another part of the same page', () => {
    before(() => {
      cy.visitReady('/sitemap');
      // Links within the page only become router links once hydrated, so we
      // wait for that rather than click the server-rendered one as it is
      // replaced
      cy.contains('a[data-discover]', 'Skip to subpages').focus().click();
    });

    it('updates the URL', () => {
      cy.location('hash').should('eq', '#subpages');
    });

    it('leaves focus on the link', () => {
      cy.focused().should('have.text', 'Skip to subpages');
    });

    announcesNothing();
  });
});
