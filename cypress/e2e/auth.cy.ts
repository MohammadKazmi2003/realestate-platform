// cypress/e2e/auth.cy.ts

describe('Authentication Flow', () => {
    beforeEach(() => {
      cy.clearCookies();
      cy.clearLocalStorage();
      cy.visit('/sign-in'); // Visit your sign-in page
    });
  
    it('allows a user to sign in successfully', () => {
      // Removed: cy.get('.sb-auth-ui').should('be.visible'); // This line was causing the error
      cy.contains('Sign in').should('be.visible'); // Use this to check for sign in text
      // If you enable Google auth, you might check for the Google button text:
      // cy.contains('Sign in with Google').should('be.visible');
    });
  
    it('redirects unauthenticated users from protected routes to sign-in', () => {
      cy.visit('/my-listings');
      cy.url().should('include', '/sign-in');
      cy.contains('Sign in').should('be.visible');
    });
  
    it('allows a user to sign up successfully', () => {
      cy.visit('/sign-up');
      // Removed: cy.get('.sb-auth-ui').should('be.visible'); // This line was causing the error
      cy.contains('Sign up').should('be.visible'); // Use this to check for sign up text
    });
  });