/**
 * catalog.cy.ts — E2E del Catálogo de plugins (Ajustes → Plugins → Catálogo).
 *
 * Requiere daemon en http://localhost:3001 y web en http://localhost:4321.
 * Cómo correrlo:
 *   - Desde la raíz del repo: `bun run test:e2e`
 *     (start-server-and-test levanta `bun run dev` y espera a :4321; para un
 *     solo spec: `bun run test:e2e -- --spec "cypress/e2e/catalog.cy.ts"`).
 *   - Con servidores ya levantados, desde web/:
 *     `npx cypress run --e2e --spec "cypress/e2e/catalog.cy.ts"`.
 *
 * Usa solo data-cy existentes de PluginCatalog.vue (`bd-catalog*`) y de
 * SettingsDialog/PluginsPane para navegar ([data-sec], [data-cy=bd-plugins]).
 * No asume idioma: acepta etiquetas en es/en (Catálogo/Catalog).
 */
describe('Catálogo de plugins', () => {
  beforeEach(() => {
    cy.visit('/')
    // La app cargó cuando hay pestañas de perfil.
    cy.get('[data-cy=bd-profile-tab]', { timeout: 15000 }).should('have.length.greaterThan', 0)
  })

  function openCatalog() {
    cy.get('[data-cy=bd-open-settings]').click()
    cy.get('[data-cy=bd-settings]').should('be.visible')
    // Ajustes → Plugins (nav lateral con data-sec).
    cy.get('[data-sec="plugins"]').click()
    cy.get('[data-cy=bd-plugins]').should('be.visible')
    // PluginsPane: pestaña Catálogo (sin data-cy propio: por texto es/en).
    cy.get('[data-cy=bd-plugins]').contains(/Catálogo|Catalog/).click()
    cy.get('[data-cy=bd-catalog]').should('be.visible')
  }

  it('lista los plugins del catálogo del daemon', () => {
    openCatalog()
    cy.get('[data-cy=bd-catalog-search]').should('be.visible')
    cy.get('[data-cy=bd-catalog-category]').should('be.visible')
    cy.get('[data-cy=bd-catalog-item]', { timeout: 10000 }).should('have.length.greaterThan', 0)
  })

  it('buscar filtra la lista y limpiar restaura', () => {
    openCatalog()
    cy.get('[data-cy=bd-catalog-item]', { timeout: 10000 }).should('have.length.greaterThan', 0)

    cy.get('[data-cy=bd-catalog-item]').its('length').then((total) => {
      cy.get('[data-cy=bd-catalog-search]').clear().type('obs')
      // Al menos el plugin OBS sigue visible…
      cy.get('[data-cy=bd-catalog-item]').should('have.length.greaterThan', 0)
      cy.get('[data-cy=bd-catalog-item]').should('have.length.lessThan', Number(total) + 1)
      cy.contains('[data-cy=bd-catalog-item]', /OBS/i).should('be.visible')
      // …y al limpiar vuelve la lista completa.
      cy.get('[data-cy=bd-catalog-search]').clear()
      cy.get('[data-cy=bd-catalog-item]').should('have.length', Number(total))
    })
  })

  it('el toggle de categoría filtra y "todas" restaura', () => {
    openCatalog()
    cy.get('[data-cy=bd-catalog-item]', { timeout: 10000 }).should('have.length.greaterThan', 0)
    cy.get('[data-cy=bd-catalog-item]').its('length').then((total) => {
      // 'system' es una categoría conocida del catálogo (CATALOG_CATEGORIES).
      cy.get('[data-cy=bd-catalog-category]').select('system')
      cy.get('[data-cy=bd-catalog-item]').should('have.length.greaterThan', 0)
      cy.get('[data-cy=bd-catalog-item]').should('have.length.lessThan', Number(total) + 1)
      // Volver a "todas" restaura el total.
      cy.get('[data-cy=bd-catalog-category]').select('all')
      cy.get('[data-cy=bd-catalog-item]').should('have.length', Number(total))
    })
  })

  it('el botón Activar/Desactivar cambia el estado (y se revierte)', () => {
    openCatalog()
    // Solo plugins instalados tienen botón toggle (data-cy bd-catalog-toggle-<id>).
    cy.get('[data-cy^="bd-catalog-toggle-"]', { timeout: 10000 })
      .first()
      .as('toggleBtn')
      .should('be.visible')
      .and('not.be.disabled')
      .invoke('text')
      .then((before) => {
        const label = String(before).trim()
        cy.get('@toggleBtn').click()
        // El estado cambia: el texto del botón debe cambiar tras el toggle.
        cy.get('@toggleBtn', { timeout: 10000 }).should(($btn) => {
          expect($btn.text().trim()).not.to.eq(label)
        })
        // Revertir para dejar el daemon como estaba.
        cy.get('@toggleBtn').click()
        cy.get('@toggleBtn', { timeout: 10000 }).should(($btn) => {
          expect($btn.text().trim()).to.eq(label)
        })
      })
  })
})
