import { describe, it, expect } from 'vitest'

// W5: mover + editar sin rebote (swap optimista seriado + edición por ID).
// Réplica pura del flujo web (useStreamDeck.ts):
//  - los botones llevan ACCIONES (shell/http/hotkey) y se pintan en el grid;
//  - mover = drag & drop (slotItemMap de Swapy) con persistencia en cadena
//    FIFO; la selección sigue al botón por ID;
//  - editar tras mover resuelve el botón POR ID (no por posición vieja);
//  - el eco WS propio (mutationId) se ignora para no "rebotar" al sitio viejo.

interface Action {
  id: string
  type: string
  parameters: Record<string, unknown>
}

interface Btn {
  id: string
  position: number
  label: string
  actions: Action[]
}

interface WebState {
  currentButtons: Btn[]
  selectedPos: number | null
  selectedId: string | null
}

const shellAction = (command: string): Action => ({ id: `a-${command}`, type: 'shell.shell', parameters: { command } })
const httpAction = (url: string): Action => ({ id: `a-${url}`, type: 'http.http', parameters: { url, method: 'GET' } })
const hotkeyAction = (keys: string): Action => ({ id: `a-${keys}`, type: 'hotkey.hotkey', parameters: { keys } })

function seed(): Btn[] {
  return [
    { id: 'A', position: 0, label: 'Shell', actions: [shellAction('notepad.exe')] },
    { id: 'B', position: 1, label: 'HTTP', actions: [httpAction('http://luz/salon')] },
    { id: 'C', position: 2, label: 'Hotkey', actions: [hotkeyAction('ctrl+s')] },
  ]
}

// --- réplicas del frontend fixed ---

function getButton(state: WebState, position: number): Btn | undefined {
  return state.currentButtons.find((b) => b.position === position)
}

// Grid visible: slot -> "label[nAcciones]" (así se VE que se mueven en el grid)
function renderGrid(state: WebState, slots: number): string[] {
  return Array.from({ length: slots }, (_, i) => {
    const b = getButton(state, i)
    return b ? `${b.label}[${b.actions.length}]` : '·'
  })
}

function selectButton(state: WebState, position: number): void {
  state.selectedPos = position
  state.selectedId = getButton(state, position)?.id ?? null
}

// slotItemMap de Swapy: { 'slot-N': 'item-<id>' | 'empty-N' }
function computeUpdates(state: WebState, map: Record<string, string>): Array<{ id: string; newPosition: number }> {
  const updates: Array<{ id: string; newPosition: number }> = []
  for (const b of state.currentButtons) {
    const slot = Object.keys(map).find((s) => map[s] === `item-${b.id}`)
    if (slot) {
      const pos = parseInt(slot.replace('slot-', ''), 10)
      if (Number.isInteger(pos) && b.position !== pos) updates.push({ id: b.id, newPosition: pos })
    }
  }
  return updates
}

// Swap optimista: aplica en local + la selección sigue al botón por ID
function applyOptimistic(state: WebState, updates: Array<{ id: string; newPosition: number }>): void {
  for (const u of updates) {
    const b = state.currentButtons.find((x) => x.id === u.id)
    if (b) b.position = u.newPosition
  }
  if (state.selectedId) {
    const sel = state.currentButtons.find((b) => b.id === state.selectedId)
    if (sel) state.selectedPos = sel.position
  }
}

// Guardado por ID: el PUT va al botón editado aunque cambiara de posición
function saveById(state: WebState, db: Map<string, Btn>, patch: Partial<Btn>): { putId: string | null } {
  const editing = state.selectedId
    ? state.currentButtons.find((b) => b.id === state.selectedId)
    : state.selectedPos !== null
      ? getButton(state, state.selectedPos)
      : undefined
  if (!editing) return { putId: null }
  const row = db.get(editing.id)
  if (!row) return { putId: null }
  Object.assign(row, JSON.parse(JSON.stringify(patch)))
  const local = state.currentButtons.find((b) => b.id === editing.id)
  if (local) Object.assign(local, JSON.parse(JSON.stringify(patch)))
  return { putId: editing.id }
}

// --- servidor fake con latencia controlable ---

function makeServer(initial: Btn[]) {
  const db = new Map(initial.map((r) => [r.id, JSON.parse(JSON.stringify(r))]))
  const applied: Array<{ order: Array<{ id: string; position: number }>; mutationId: string }> = []
  const broadcasts: Array<{ pageId: string; mutationId: string }> = []
  return {
    db,
    // Cada reorder devuelve un deferred: el test decide el orden de llegada
    sendReorder(order: Array<{ id: string; position: number }>, mutationId: string) {
      let resolve!: () => void
      const done = new Promise<void>((res) => { resolve = res })
      return {
        done,
        complete() {
          for (const o of order) {
            const row = db.get(o.id)
            if (row) row.position = o.position
          }
          applied.push({ order, mutationId })
          broadcasts.push({ pageId: 'p1', mutationId })
          resolve()
        },
      }
    },
    applied,
    broadcasts,
  }
}

// Eco WS: si el mutationId es nuestro pendiente, se ignora (sin reload)
function handleReorderBroadcast(
  state: WebState,
  server: ReturnType<typeof makeServer>,
  payload: { pageId: string; mutationId: string },
  pending: Set<string>,
  reloads: { n: number },
): void {
  if (pending.has(payload.mutationId)) {
    pending.delete(payload.mutationId)
    return // eco propio: el estado optimista ya está al día
  }
  reloads.n += 1
  state.currentButtons = [...server.db.values()].map((b) => JSON.parse(JSON.stringify(b)))
}

describe('ButtonSwapFollowEdit (W5)', () => {
  it('1. muevo A(0)→slot 5 con acciones y el grid lo muestra allí', () => {
    const state: WebState = { currentButtons: seed(), selectedPos: null, selectedId: null }
    expect(renderGrid(state, 6)).toEqual(['Shell[1]', 'HTTP[1]', 'Hotkey[1]', '·', '·', '·'])

    const map = { 'slot-0': 'empty-0', 'slot-1': 'item-B', 'slot-2': 'item-C', 'slot-5': 'item-A' }
    const updates = computeUpdates(state, map)
    expect(updates).toEqual([{ id: 'A', newPosition: 5 }])
    applyOptimistic(state, updates)

    // Se VE moverse en el grid, con sus acciones intactas
    expect(renderGrid(state, 6)).toEqual(['·', 'HTTP[1]', 'Hotkey[1]', '·', '·', 'Shell[1]'])
    const moved = getButton(state, 5)
    expect(moved?.id).toBe('A')
    expect(moved?.actions).toEqual([{ id: 'a-notepad.exe', type: 'shell.shell', parameters: { command: 'notepad.exe' } }])
  })

  it('2. muevo A y lo edito: el PUT va al ID de A, no a la posición vieja', () => {
    const server = makeServer(seed())
    const state: WebState = { currentButtons: seed(), selectedPos: null, selectedId: null }

    selectButton(state, 0) // estoy editando A
    expect(state.selectedId).toBe('A')

    // Arrastro A al slot 5
    applyOptimistic(state, computeUpdates(state, {
      'slot-0': 'empty-0', 'slot-1': 'item-B', 'slot-2': 'item-C', 'slot-5': 'item-A',
    }))
    // …y el swap persiste en el servidor (A queda en 5 en la BD)
    server.sendReorder([{ id: 'A', position: 5 }], 'mid-move').complete()
    // La selección SIGUE al botón: ahora está en 5
    expect(state.selectedPos).toBe(5)
    expect(state.selectedId).toBe('A')

    // Edito (cambio label + añado acción): debe ir al ID de A
    const { putId } = saveById(state, server.db, {
      label: 'Shell v2',
      actions: [shellAction('notepad.exe'), httpAction('http://backup')],
    } as Partial<Btn>)
    expect(putId).toBe('A')
    // La BD conserva A en su NUEVA posición con la edición y sus acciones
    const rowA = server.db.get('A')!
    expect(rowA.position).toBe(5)
    expect(rowA.label).toBe('Shell v2')
    expect(rowA.actions).toHaveLength(2)
    // Y el grid lo muestra editado en el slot 5, no en el 0
    expect(renderGrid(state, 6)[5]).toBe('Shell v2[2]')
    expect(renderGrid(state, 6)[0]).toBe('·')
  })

  it('3. doble movimiento rápido del mismo botón: sin cola el último intent se pierde (rebote)', async () => {
    const server = makeServer(seed())
    // Sin cola: cada swap dispara su POST y la red los invierte (llega antes el 2º)
    const r1 = server.sendReorder([{ id: 'A', position: 5 }], 'mid-1')
    const r2 = server.sendReorder([{ id: 'A', position: 2 }], 'mid-2')
    r2.complete() // la red entrega primero el ÚLTIMO intent…
    r1.complete() // …y después el PRIMERO (stale) lo pisa
    await Promise.all([r1.done, r2.done])

    // La BD dice A@5 pero el usuario dejó A en el slot 2 → al recargar, "vuelve"
    expect(server.db.get('A')!.position).toBe(5)
    const reloaded: WebState = {
      currentButtons: [...server.db.values()].map((b) => ({ ...b })),
      selectedPos: null,
      selectedId: null,
    }
    expect(renderGrid(reloaded, 6)).toEqual(['·', 'HTTP[1]', 'Hotkey[1]', '·', '·', 'Shell[1]'])
    expect(renderGrid(reloaded, 6)[2]).toBe('Hotkey[1]') // C intacta…
    expect(renderGrid(reloaded, 6)[5]).toBe('Shell[1]') // …pero A rebotó al 5
  })

  it('4. con cola FIFO el último movimiento gana y el grid queda como el usuario', async () => {
    const server = makeServer(seed())
    const state: WebState = { currentButtons: seed(), selectedPos: null, selectedId: null }

    // Cadena seriada (como el swapChain del fix): el 2º no se envía hasta
    // que el 1º termina → el orden de llegada es el orden de inicio
    let chain: Promise<void> = Promise.resolve()
    const completions: string[] = []
    const queue = (order: Array<{ id: string; position: number }>, mid: string) => {
      chain = chain.then(async () => {
        const req = server.sendReorder(order, mid)
        req.complete() // red instantánea pero EN ORDEN
        await req.done
        completions.push(mid)
      })
      return chain
    }

    // Dos drags rápidos del MISMO botón con acciones: 0→5 y luego 5→2
    applyOptimistic(state, computeUpdates(state, { 'slot-5': 'item-A', 'slot-1': 'item-B', 'slot-2': 'item-C' }))
    const p1 = queue([{ id: 'A', position: 5 }], 'mid-1')
    applyOptimistic(state, computeUpdates(state, { 'slot-2': 'item-A', 'slot-1': 'item-B', 'slot-5': 'empty-5' }))
    const p2 = queue([{ id: 'A', position: 2 }], 'mid-2')
    await Promise.all([p1, p2])

    expect(completions).toEqual(['mid-1', 'mid-2'])
    expect(server.db.get('A')!.position).toBe(2) // último intent gana
    // Acciones intactas tras los dos movimientos
    expect(server.db.get('A')!.actions).toEqual([shellAction('notepad.exe')])
    // El grid coincide con lo que ve el usuario
    expect(renderGrid(state, 6)).toEqual(['·', 'HTTP[1]', 'Shell[1]', '·', '·', '·'])
  })

  it('5. eco WS propio se ignora (sin rebote); eco ajeno sí recarga', () => {
    const server = makeServer(seed())
    const state: WebState = { currentButtons: seed(), selectedPos: null, selectedId: null }
    const pending = new Set<string>()
    const reloads = { n: 0 }

    // Muevo A→5 en local (optimista) y el daemon me devuelve mi eco
    applyOptimistic(state, [{ id: 'A', newPosition: 5 }])
    const mid = 'mid-propio'
    pending.add(mid)
    handleReorderBroadcast(state, server, { pageId: 'p1', mutationId: mid }, pending, reloads)
    expect(reloads.n).toBe(0) // sin recarga: no rebota
    expect(renderGrid(state, 6)[5]).toBe('Shell[1]')

    // Otro cliente mueve B→4: su broadcast (sin mi mutationId) sí recarga
    server.db.get('B')!.position = 4
    handleReorderBroadcast(state, server, { pageId: 'p1', mutationId: 'mid-ajeno' }, pending, reloads)
    expect(reloads.n).toBe(1)
  })

  it('6. GET viejo que resuelve tras un swap optimista se descarta (guarda de época)', async () => {
    // Réplica de loadButtons con época: la respuesta solo se aplica si no
    // hubo mutaciones optimistas locales mientras volaba. Sin esto, el grid
    // "vuelve donde estaba" aunque la BD ya tenga el movimiento.
    let epoch = 0
    const bump = () => { epoch += 1 }
    const state: WebState = { currentButtons: seed(), selectedPos: null, selectedId: null }

    // GET lanzado ANTES del drag (p.ej. eco tardío o recarga ajena en vuelo)
    const capturedEpoch = epoch
    let resolveGet!: (rows: Btn[]) => void
    const getPromise = new Promise<Btn[]>((res) => { resolveGet = res })

    // El usuario arrastra A 0→5: optimista inmediato + bump de época
    applyOptimistic(state, [{ id: 'A', newPosition: 5 }])
    bump()
    expect(renderGrid(state, 6)[5]).toBe('Shell[1]') // se VE movido al instante

    // Resuelve el GET viejo (con las posiciones PRE-drag): debe descartarse
    resolveGet(seed().map((b) => ({ ...b, actions: [...b.actions] })))
    const staleRows = await getPromise
    const applied = capturedEpoch === epoch ? staleRows : null
    expect(applied).toBeNull() // descartado: no rebota
    expect(renderGrid(state, 6)[5]).toBe('Shell[1]') // sigue donde lo dejó
    expect(getButton(state, 5)?.actions).toEqual([shellAction('notepad.exe')])

    // Una recarga posterior (época al día) sí se aplica
    const epoch2 = epoch
    const fresh: Btn[] = [
      { id: 'A', position: 5, label: 'Shell', actions: [shellAction('notepad.exe')] },
      { id: 'B', position: 1, label: 'HTTP', actions: [httpAction('http://luz/salon')] },
      { id: 'C', position: 2, label: 'Hotkey', actions: [hotkeyAction('ctrl+s')] },
    ]
    if (epoch2 === epoch) {
      state.currentButtons = fresh
      if (state.selectedId) {
        const sel = state.currentButtons.find((b) => b.id === state.selectedId)
        state.selectedPos = sel ? sel.position : null
      }
    }
    expect(renderGrid(state, 6)[5]).toBe('Shell[1]')
  })

  it('7. tras recargar, la selección sigue al botón por su ID', () => {
    const state: WebState = { currentButtons: seed(), selectedPos: 0, selectedId: 'A' }
    // El botón se movió (o la recarga lo trae en otra posición)
    const fresh: Btn[] = [
      { id: 'B', position: 0, label: 'HTTP', actions: [httpAction('http://luz/salon')] },
      { id: 'A', position: 5, label: 'Shell', actions: [shellAction('notepad.exe')] },
    ]
    state.currentButtons = fresh
    if (state.selectedId) {
      const sel = state.currentButtons.find((b) => b.id === state.selectedId)
      state.selectedPos = sel ? sel.position : null
      if (!sel) state.selectedId = null
    }
    // La edición posterior irá a A (posición 5), no al ocupante del slot 0
    expect(state.selectedPos).toBe(5)
    expect(state.selectedId).toBe('A')
    expect(getButton(state, 0)?.id).toBe('B')
  })
})
