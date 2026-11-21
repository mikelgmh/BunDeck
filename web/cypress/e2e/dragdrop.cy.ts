// E2E: drag & drop real del grid de botones (Swapy + UI optimista).
// - Crea dos botones con acciones vía API (labels únicos E2E-DRAG-A/B).
// - Simula el gesto con pointer events reales (pointerdown/move/up), como
//   haría un dedo/ratón: Swapy escucha pointerdown en el container.
// - Verifica UI optimista (sin recargar) y persistencia (tras recargar).
describe('Grid drag and drop (Swapy)', () => {
  const API = 'http://localhost:3001/api/v1'
  const LABEL_A = 'E2E-DRAG-A'
  const LABEL_B = 'E2E-DRAG-B'
  let pageId = ''
  let posA = -1
  let posB = -1
  const createdIds: string[] = []

  before(() => {
    cy.request('GET', `${API}/profiles`).its('body').then((profiles: any[]) => {
      const profile = profiles[0]
      let gridCols = 5
      let gridRows = 3
      try {
        const data = typeof profile.data === 'string' ? JSON.parse(profile.data) : profile.data
        if (data?.gridCols) gridCols = data.gridCols
        if (data?.gridRows) gridRows = data.gridRows
      } catch {
        /* defaults */
      }
      const total = gridCols * gridRows
      cy.request('GET', `${API}/pages?profileId=${profile.id}`).its('body').then((pages: any[]) => {
        const page = pages.find((p) => p.is_folder === 0) ?? pages[0]
        pageId = page.id
        // Fijar la página actual para que la app la cargue al visitar
        cy.request('POST', `${API}/settings`, { key: 'current.page_id', value: pageId }).then(() => {
          cy.request('GET', `${API}/buttons?pageId=${pageId}`).its('body').then((buttons: any[]) => {
            const taken = new Set(buttons.map((b) => b.position))
            const free: number[] = []
            for (let i = 0; i < total && free.length < 2; i++) {
              if (!taken.has(i)) free.push(i)
            }
            expect(free, 'need two free slots in the grid').to.have.length(2)
            posA = free[0]
            posB = free[1]
            const mk = (position: number, label: string, actions: any[]) =>
              cy
                .request('POST', `${API}/buttons`, {
                  page_id: pageId,
                  position,
                  data: { label, actions, backgroundColor: '#374151', textColor: '#f1f5f9' },
                })
                .its('body')
                .then((b: any) => {
                  createdIds.push(b.id)
                })
            mk(posA, LABEL_A, [
              { id: 'e2e-a1', type: 'shell.shell', pluginId: 'shell', parameters: { command: 'echo a' } },
            ])
            mk(posB, LABEL_B, [
              { id: 'e2e-b1', type: 'http.http', pluginId: 'http', parameters: { url: 'http://localhost/', method: 'GET' } },
            ])
          })
        })
      })
    })
  })

  after(() => {
    createdIds.forEach((id) => {
      cy.request({ method: 'DELETE', url: `${API}/buttons/${id}`, failOnStatusCode: false })
    })
  })

  it('drags a button to another slot: optimistic immediately, persisted after reload', () => {
    cy.intercept('POST', '**/api/v1/buttons/reorder').as('reorder')
    cy.visit('/')
    cy.get('[data-cy=bd-profile-tab]', { timeout: 15000 }).should('have.length.greaterThan', 0)
    cy.contains(LABEL_A, { timeout: 15000 }).should('be.visible')
    cy.contains(LABEL_B).should('be.visible')

    // Gesto de arrastre con PointerEvents NATIVOS del window de la AUT
    // (lo que Swapy escucha: pointerdown en el container, moves + up en
    // document.body). cy.trigger no garantiza un PointerEvent con isPrimary.
    // Los swaps de hover de Swapy se procesan en requestAnimationFrame: hay
    // que ceder el event loop entre movimientos o nunca permutan.
    cy.window().then(async (win) => {
      const doc = win.document
      const srcEl = doc.querySelector(
        `[data-swapy-slot="slot-${posA}"] [data-swapy-item]`,
      ) as HTMLElement
      const tgtEl = doc.querySelector(`[data-swapy-slot="slot-${posB}"]`) as HTMLElement
      expect(srcEl, 'drag source item exists').to.not.be.null
      expect(tgtEl, 'drag target slot exists').to.not.be.null
      const r1 = srcEl.getBoundingClientRect()
      const r2 = tgtEl.getBoundingClientRect()
      const x1 = r1.x + r1.width / 2
      const y1 = r1.y + r1.height / 2
      const x2 = r2.x + r2.width / 2
      const y2 = r2.y + r2.height / 2
      const init = (x: number, y: number, buttons: number): PointerEventInit => ({
        bubbles: true,
        cancelable: true,
        button: 0,
        buttons,
        clientX: x,
        clientY: y,
        pointerId: 1,
        pointerType: 'mouse',
        isPrimary: true,
      })
      const frame = () => new Promise<void>((resolve) => win.requestAnimationFrame(() => resolve()))
      const pause = (ms: number) => new Promise<void>((resolve) => win.setTimeout(resolve, ms))
      srcEl.dispatchEvent(new win.PointerEvent('pointerdown', init(x1, y1, 1)))
      await frame()
      const steps = 10
      for (let i = 1; i <= steps; i++) {
        const x = x1 + ((x2 - x1) * i) / steps
        const y = y1 + ((y2 - y1) * i) / steps
        doc.body.dispatchEvent(new win.PointerEvent('pointermove', init(x, y, 1)))
        await frame()
        await pause(30)
      }
      doc.body.dispatchEvent(new win.PointerEvent('pointerup', init(x2, y2, 0)))
      await frame()
      await pause(50)
    })

    // UI optimista: SIN recargar, A ya está en el slot de B y viceversa.
    // Además el swap disparó la persistencia (POST /buttons/reorder).
    cy.wait('@reorder', { timeout: 10000 })
      .its('request.body.order')
      .should('deep.include', { id: createdIds[0], position: posB })
    cy.get(`[data-swapy-slot="slot-${posB}"]`, { timeout: 10000 }).should('contain.text', LABEL_A)
    cy.get(`[data-swapy-slot="slot-${posA}"]`).should('contain.text', LABEL_B)

    // Persistido en BD: tras recargar sigue igual (no "vuelve donde estaba")
    cy.reload()
    cy.get('[data-cy=bd-profile-tab]', { timeout: 15000 }).should('have.length.greaterThan', 0)
    cy.get(`[data-swapy-slot="slot-${posB}"]`, { timeout: 10000 }).should('contain.text', LABEL_A)
    cy.get(`[data-swapy-slot="slot-${posA}"]`).should('contain.text', LABEL_B)
  })
})
