describe('Client-side navigation', () => {
  before(() => {
    cy.visitReady('/');
  });

  describe('when following a link to another page', () => {
    before(() => {
      cy.contains('a', 'Forms').focus().click();
    });

    it('navigates to the page', () => {
      cy.location('pathname').should('eq', '/forms');
    });

    // We can't check that focus moves to the start of the document here, as
    // Cypress's replacement for HTMLElement.focus() ignores calls on <body>.
    // This is covered by the unit tests in @react-foundry/router instead.

    it('announces the title of the new page', () => {
      cy.title().then(title => {
        cy.get('[aria-live]').should('have.text', title);
      });
    });
  });
});
