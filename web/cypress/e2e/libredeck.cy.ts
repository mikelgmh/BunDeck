describe('BunDeck E2E Tests', () => {
  beforeEach(() => {
    // Assuming the daemon is running on port 3001
    // and the frontend on port 4321
    cy.visit('/')
  })

  it('should load the main page', () => {
    cy.get('.bd-brand', { timeout: 10000 }).should('be.visible')
    cy.get('.bd-brand').should('contain.text', 'BunDeck')
  })

  it('should load the application interface', () => {
    cy.get('body').should('be.visible')

    // Profile tabs must appear once profiles load
    cy.get('[data-cy=bd-profile-tab]', { timeout: 10000 }).should('have.length.greaterThan', 0)

    // Header buttons
    cy.get('[data-cy=bd-open-plugins]').should('be.visible')
    cy.get('[data-cy=bd-open-qr]').should('be.visible')
    cy.get('[data-cy=bd-open-settings]').should('be.visible')
  })

  it('should allow profile selection', () => {
    cy.get('[data-cy=bd-profile-tab]', { timeout: 10000 }).should('have.length.greaterThan', 0)

    // Click the first profile tab: it becomes the selected tab
    cy.get('[data-cy=bd-profile-tab]').first().click()
    cy.get('[data-cy=bd-profile-tab]').first().should('have.attr', 'aria-selected', 'true')
  })

  it('should allow creating a new button', () => {
    cy.get('[data-cy=bd-profile-tab]', { timeout: 10000 }).should('have.length.greaterThan', 0)

    // Select a key slot: the inspector shows the title field
    cy.get('[data-cy=bd-key]').first().click()
    cy.get('[data-cy=bd-key-title]', { timeout: 5000 }).should('be.visible')

    // Fill in the key title (inspector autosaves via debounce, no save button)
    cy.get('[data-cy=bd-key-title]').clear().type('Test Button')

    // Key label should be visible on the board (might take a moment to update)
    cy.contains('Test Button', { timeout: 10000 }).should('be.visible')
  })

  it('should allow adding actions to buttons', () => {
    cy.get('[data-cy=bd-profile-tab]', { timeout: 10000 }).should('be.visible')

    // Select a key
    cy.get('[data-cy=bd-key]').first().click()
    cy.get('[data-cy=bd-key-title]', { timeout: 5000 }).should('be.visible')

    // Clicking a library action adds it to the selected key
    cy.get('[data-cy=bd-action-item]').first().click()

    // Action should appear in the inspector list
    cy.get('[data-cy=bd-action-row]', { timeout: 5000 }).should('have.length.greaterThan', 0)
  })

  it('should switch between edit and use mode', () => {
    cy.get('[data-cy=bd-profile-tab]', { timeout: 10000 }).should('be.visible')

    // Use mode shows the "use mode" empty state in the inspector
    cy.contains('Usar').click()
    cy.contains('Modo uso').should('be.visible')

    // Back to edit mode
    cy.contains('Editar').click()
    cy.contains('Elige una tecla').should('be.visible')
  })

  it('should support multiple pages', () => {
    cy.get('[data-cy=bd-profile-tab]', { timeout: 10000 }).should('be.visible')

    // Add a new page (created with a default name)
    cy.get('[data-cy=bd-page-add]').click()

    // The new page chip appears and becomes active
    cy.contains('Página', { timeout: 10000 }).should('be.visible')
  })

  it('should rename a page from its context menu', () => {
    cy.get('[data-cy=bd-profile-tab]', { timeout: 10000 }).should('be.visible')

    // Open the per-page menu (three dots) on the first page
    cy.get('.bd-pagemenu-btn').first().click()
    cy.contains('Renombrar').click()

    // Inline input appears: rename and confirm with Enter
    cy.get('[data-cy=bd-page-rename-input]').clear().type('Principal{enter}')

    // The chip shows the new name
    cy.contains('Principal').should('be.visible')
  })

  it('should support language switching', () => {
    cy.get('[data-cy=bd-profile-tab]', { timeout: 10000 }).should('be.visible')

    // Inspector empty state in Spanish
    cy.contains('Elige una tecla').should('be.visible')

    // Language lives in Settings → General
    cy.get('[data-cy=bd-open-settings]').click()
    cy.get('[data-cy=bd-language-select]').select('en')

    // UI text should re-render in English inside the dialog
    cy.get('[data-cy=bd-settings]').contains('Settings').should('be.visible')
  })

  it('should open plugins, QR and icon dialogs', () => {
    cy.get('[data-cy=bd-profile-tab]', { timeout: 10000 }).should('be.visible')

    // Plugins vive ahora en Ajustes → Plugins (debajo de Apariencia)
    cy.get('[data-cy=bd-open-plugins]').click()
    cy.get('[data-cy=bd-settings]').should('be.visible')
    cy.get('[data-cy=bd-plugins]').should('be.visible')
    cy.get('[data-cy=bd-settings]').contains('Instalados').should('be.visible')
    cy.get('body').type('{esc}')

    cy.get('[data-cy=bd-open-qr]').click()
    cy.contains('Abrir en el móvil').should('be.visible')
  })
})
