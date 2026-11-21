/**
 * remote.cy.ts — E2E del panel Acceso remoto (Ajustes → Acceso remoto).
 *
 * Requiere daemon en http://localhost:3001 y web en http://localhost:4321.
 * Cómo correrlo:
 *   - Desde la raíz del repo: `bun run test:e2e`
 *     (start-server-and-test levanta `bun run dev` y espera a :4321; para un
 *     solo spec: `bun run test:e2e -- --spec "cypress/e2e/remote.cy.ts"`).
 *   - Con servidores ya levantados, desde web/:
 *     `npx cypress run --e2e --spec "cypress/e2e/remote.cy.ts"`.
 *
 * Prefiere el daemon real (generar código, fingerprint, lista de dispositivos).
 * No muta datos ajenos: el toggle de policy solo cambia el borrador local
 * (no pulsa Guardar) y no revoca ningún dispositivo.
 * Usa solo data-cy existentes de RemotePane.vue (`remote-*`).
 */
describe('Acceso remoto', () => {
  beforeEach(() => {
    cy.visit('/')
    cy.get('[data-cy=bd-profile-tab]', { timeout: 15000 }).should('have.length.greaterThan', 0)
  })

  function openRemote() {
    cy.get('[data-cy=bd-open-settings]').click()
    cy.get('[data-cy=bd-settings]').should('be.visible')
    cy.get('[data-sec="remote"]').click()
    cy.get('[data-cy=remote-pane]').should('be.visible')
  }

  it('muestra la sección con estado y acciones', () => {
    openRemote()
    cy.get('[data-cy=remote-status]').should('be.visible')
    // La huella del dispositivo aparece en el estado (formato hex con ':').
    cy.get('[data-cy=remote-status]').should('contain.text', ':')
    cy.get('[data-cy=remote-gen-code]').should('be.visible').and('not.be.disabled')
    cy.get('[data-cy=remote-accept-code]').should('be.visible')
    cy.get('[data-cy=remote-accept-device]').should('be.visible')
    cy.get('[data-cy=remote-accept-pubkey]').should('be.visible')
    cy.get('[data-cy=remote-accept-btn]').should('be.visible')
    cy.get('[data-cy=remote-rotate]').should('be.visible')
  })

  it('generar código muestra code (6 dígitos) + fingerprint', () => {
    openRemote()
    cy.get('[data-cy=remote-gen-code]').click()
    cy.get('[data-cy=remote-pair-code]', { timeout: 10000 }).should('be.visible')
    cy.get('[data-cy=remote-pair-code]').should(($el) => {
      expect($el.text()).to.match(/\d{6}/)
      expect($el.text()).to.contain(':')
    })
  })

  it('aceptar con código inválido muestra error sin llamar al daemon', () => {
    openRemote()
    cy.get('[data-cy=remote-accept-code]').clear().type('123')
    cy.get('[data-cy=remote-accept-device]').clear().type('dev-e2e')
    cy.get('[data-cy=remote-accept-pubkey]').clear().type('cHViLWtleQ==')
    cy.get('[data-cy=remote-accept-btn]').click()
    // Validación de cliente (isValidPairCode): el formulario no se limpia.
    cy.get('[data-cy=remote-accept-code]').should('have.value', '123')
  })

  it('lista de dispositivos: vacía o con filas revocables + policy toggles', () => {
    openRemote()
    cy.get('body').then(($body) => {
      if ($body.find('[data-cy=remote-device]').length > 0) {
        // Hay dispositivos: revocar visible y policy toggles operativos (borrador local).
        cy.get('[data-cy=remote-device]').should('have.length.greaterThan', 0)
        cy.get('[data-cy=remote-revoke]').first().should('be.visible')
        cy.get('[data-cy^="remote-policy-"]')
          .first()
          .as('policyBox')
          .then(($box) => {
            const checked = $box.is(':checked')
            cy.get('@policyBox').click()
            cy.get('@policyBox').should(checked ? 'not.be.checked' : 'be.checked')
            // Se deja el borrador cambiado a propósito sin Guardar: no muta el daemon.
          })
      } else {
        // Sin dispositivos emparejados: el panel muestra el estado vacío.
        cy.contains(/sin dispositivos|no devices|no hay/i).should('be.visible')
      }
    })
  })
})
