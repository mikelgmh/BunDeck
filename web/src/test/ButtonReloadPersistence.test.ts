import { describe, it, expect } from 'vitest'

// W3: persistencia de posiciones tras recarga (F5).
// Simula BD + API + estado web con funciones locales.
// - loadButtons: GET /buttons?pageId → currentButtons = respuesta
//   (daemon ordena ORDER BY position, daemon/src/db.ts getButtonsByPage).
// - Tras F5 todo el estado Vue se pierde y se reconstruye con
//   loadProfiles→loadProfile→loadButtons; las posiciones vienen de la BD.

interface Row {
  id: string
  pageId: string
  position: number
  label: string
}

interface WebState {
  currentButtons: Row[]
}

// --- simulación local ---

function makeDb(rows: Row[]): Row[] {
  return rows.map((r) => ({ ...r }))
}

// GET /buttons?pageId — daemon: SELECT * WHERE page_id ORDER BY position
function apiGetButtons(db: Row[], pageId: string): Row[] {
  return db
    .filter((r) => r.pageId === pageId)
    .sort((a, b) => a.position - b.position)
    .map((r) => ({ ...r })) // respuesta JSON = copias
}

// PUT /buttons/:id — actualiza posición/data; puede fallar silenciosamente
function apiPutButton(
  db: Row[],
  id: string,
  patch: Partial<Row>,
  opts: { failIds?: string[]; putCount?: { n: number } } = {},
): { success: boolean } {
  if (opts.putCount) opts.putCount.n += 1
  if (opts.failIds?.includes(id)) return { success: false }
  const row = db.find((r) => r.id === id)
  if (!row) return { success: false }
  Object.assign(row, patch)
  return { success: true }
}

// loadButtons web: currentButtons = respuesta del GET
function loadButtons(state: WebState, db: Row[], pageId: string): void {
  state.currentButtons = apiGetButtons(db, pageId)
}

// F5: se vacía todo el estado Vue y se recarga desde la BD
function reloadPage(state: WebState, db: Row[], pageId: string): void {
  state.currentButtons = [] // estado perdido
  // reconstrucción: loadProfiles→loadProfile→loadButtons
  loadButtons(state, db, pageId)
}

// Swap de dos botones: construye newMap id→nueva posición, valida y envía PUTs.
// Devuelve earlyReturn:true si el mapa es inválido (0 PUTs, sin error visible).
function swapButtons(
  state: WebState,
  db: Row[],
  idA: string,
  idB: string,
  opts: { failIds?: string[]; putCount?: { n: number } } = {},
): { sent: number; earlyReturn: boolean } {
  const a = state.currentButtons.find((b) => b.id === idA)
  const b = state.currentButtons.find((b) => b.id === idB)
  const newMap = new Map<string, number>()
  if (a && b) {
    newMap.set(idA, b.position)
    newMap.set(idB, a.position)
  }
  // validación: mapa inválido → early return sin error visible
  const positions = [...newMap.values()]
  const valid =
    newMap.size === 2 &&
    positions.every((p) => Number.isInteger(p) && p >= 0) &&
    new Set(positions).size === 2
  if (!valid) return { sent: 0, earlyReturn: true }

  // envío: actualiza BD vía PUT y estado local de forma optimista
  // (el bug documentado: no se comprueba success → fallo silencioso)
  for (const [id, position] of newMap) {
    apiPutButton(db, id, { position }, opts)
    const local = state.currentButtons.find((x) => x.id === id)
    if (local) local.position = position
  }
  // reordena vista local como haría el grid tras el swap
  state.currentButtons.sort((x, y) => x.position - y.position)
  return { sent: newMap.size, earlyReturn: false }
}

function getButtonAt(state: WebState, position: number): Row | undefined {
  return state.currentButtons.find((b) => b.position === position)
}

function renderGrid(buttons: Row[], slots: number): {
  visible: Row[]
  hidden: Row[]
} {
  const visible = buttons.filter((b) => b.position < slots)
  const hidden = buttons.filter((b) => b.position >= slots)
  return { visible, hidden }
}

function seedPage(n: number, pageId = 'p1'): Row[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `btn-${i}`,
    pageId,
    position: i,
    label: `btn-${i}`,
  }))
}

describe('ButtonReloadPersistence (W3)', () => {
  it('1. swap OK + reload → posiciones nuevas persisten', () => {
    const db = makeDb(seedPage(4))
    const state: WebState = { currentButtons: [] }
    loadButtons(state, db, 'p1')

    const res = swapButtons(state, db, 'btn-0', 'btn-1')
    expect(res.earlyReturn).toBe(false)
    expect(res.sent).toBe(2)

    reloadPage(state, db, 'p1') // F5

    expect(getButtonAt(state, 0)?.id).toBe('btn-1')
    expect(getButtonAt(state, 1)?.id).toBe('btn-0')
  })

  it('2. PUT fallido silencioso + reload → la posición vieja "resucita"', () => {
    const db = makeDb(seedPage(4))
    const state: WebState = { currentButtons: [] }
    loadButtons(state, db, 'p1')

    // un update falla pero el código no comprueba success: la vista local
    // muestra el swap mientras la BD conserva la posición vieja
    const res = swapButtons(state, db, 'btn-0', 'btn-1', {
      failIds: ['btn-1'],
    })
    expect(res.sent).toBe(2)
    // vista optimista (stale): parece movido
    expect(getButtonAt(state, 0)?.id).toBe('btn-1')

    reloadPage(state, db, 'p1') // F5: la BD manda

    // btn-1 nunca se persistió → vuelve a position 1, btn-0 sigue en 0
    // (o queda duplicado/inconsistente según qué PUT falló; lo que el
    // usuario percibe como "no se guardan las posiciones")
    const pos0 = db.find((r) => r.id === 'btn-0')!.position
    const pos1 = db.find((r) => r.id === 'btn-1')!.position
    expect(pos1).toBe(1) // no se movió en BD
    expect(pos0).toBe(1) // el otro sí se movió → colisión tras fallo parcial
    // tras F5 el orden ya no es el swap deseado [btn-1, btn-0]:
    // hay dos filas en position 1 y la vieja "resucita"
    expect(state.currentButtons.map((b) => b.id)).not.toEqual([
      'btn-1',
      'btn-0',
      'btn-2',
      'btn-3',
    ])
    expect(
      state.currentButtons.filter((b) => b.position === 1).map((b) => b.id),
    ).toEqual(expect.arrayContaining(['btn-0', 'btn-1']))
  })

  it('3. newMap inválido (early return, 0 PUTs) + reload → nada cambió', () => {
    const db = makeDb(seedPage(4))
    const state: WebState = { currentButtons: [] }
    loadButtons(state, db, 'p1')
    const putCount = { n: 0 }

    // id destino inexistente → mapa inválido → early return sin error visible
    const res = swapButtons(state, db, 'btn-0', 'btn-inexistente', {
      putCount,
    })
    expect(res.earlyReturn).toBe(true)
    expect(res.sent).toBe(0)
    expect(putCount.n).toBe(0)

    reloadPage(state, db, 'p1') // F5

    // "muevo y al recargar todo igual": la BD nunca recibió nada
    expect(state.currentButtons.map((b) => b.id)).toEqual([
      'btn-0',
      'btn-1',
      'btn-2',
      'btn-3',
    ])
    expect(state.currentButtons.map((b) => b.position)).toEqual([0, 1, 2, 3])
  })

  it('4. doble fila con misma position → getButton devuelve siempre la primera', () => {
    const db = makeDb([
      { id: 'btn-a', pageId: 'p1', position: 0, label: 'A' },
      { id: 'btn-b', pageId: 'p1', position: 0, label: 'B (duplicada)' },
      { id: 'btn-c', pageId: 'p1', position: 1, label: 'C' },
    ])
    const state: WebState = { currentButtons: [] }
    reloadPage(state, db, 'p1')

    // ORDER BY position devuelve ambas con igual position (orden ambiguo)
    const atZero = state.currentButtons.filter((b) => b.position === 0)
    expect(atZero).toHaveLength(2)

    // find/l lookup por posición devuelve siempre la primera:
    // la segunda queda invisible/huérfana aunque existe en BD
    expect(getButtonAt(state, 0)?.id).toBe(atZero[0].id)
    expect(state.currentButtons.map((b) => b.id)).toContain('btn-b')
    expect(getButtonAt(state, 0)?.id).not.toBe('btn-b')
  })

  it('5. resize que encoge el grid (15→6) + reload: 4 botones "perdidos" visualmente', () => {
    const db = makeDb(seedPage(10))
    const state: WebState = { currentButtons: [] }
    reloadPage(state, db, 'p1') // F5 trae los 10 de la BD

    expect(state.currentButtons).toHaveLength(10)

    const { visible, hidden } = renderGrid(state.currentButtons, 6)
    expect(visible).toHaveLength(6)
    expect(hidden).toHaveLength(4)
    // existen en BD pero el grid no los renderiza
    expect(db).toHaveLength(10)
    expect(hidden.map((b) => b.position)).toEqual([6, 7, 8, 9])
  })

  it('6. edición sin guardar + swap pisa la edición con la data vieja', () => {
    const db = makeDb(seedPage(3))
    const state: WebState = { currentButtons: [] }
    loadButtons(state, db, 'p1')

    // usuario edita el label de btn-0 pero selectButton aún no hizo
    // saveButtonConfig del botón anterior: el draft solo vive en memoria
    const unsavedDraft = { label: 'NUEVO LABEL (sin guardar)' }
    expect(db.find((r) => r.id === 'btn-0')!.label).toBe('btn-0')

    // el swap construye el PUT desde currentButtons (data stale, label viejo)
    const stale = state.currentButtons.find((b) => b.id === 'btn-0')!
    const putPayload = { position: 1, label: stale.label }
    expect(putPayload.label).toBe('btn-0') // lleva la data vieja, no el draft
    apiPutButton(db, 'btn-0', putPayload)
    stale.position = 1

    reloadPage(state, db, 'p1') // F5

    // la edición nunca llegó a la BD y el PUT del swap la pisó: se pierde
    expect(db.find((r) => r.id === 'btn-0')!.label).toBe('btn-0')
    expect(db.find((r) => r.id === 'btn-0')!.label).not.toBe(
      unsavedDraft.label,
    )
  })
})
