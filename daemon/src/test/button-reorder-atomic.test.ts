/**
 * button-reorder-atomic.test.ts — regresión del fix de reordenado.
 * Réplica pura (sin imports de db/action-runner/plugin-loader) del algoritmo
 * de DatabaseService.reorderButtons (daemon/src/db.ts):
 *  - validación previa (ids existentes, misma página, destinos únicos y >= 0)
 *  - dos fases con posiciones temporales negativas (evita colisiones UNIQUE
 *    en swaps 0<->1 y ciclos 0->1->2->0)
 *  - rollback total si algo falla (la BD queda intacta)
 */
import { describe, it, expect } from 'bun:test'

interface Row { id: string; pageId: string; position: number }

function makeDb(seed: Row[]) {
  let rows: Row[] = seed.map(r => ({ ...r }))
  const snapshot = () => rows.map(r => ({ ...r }))
  const byPage = (pageId: string) =>
    rows.filter(r => r.pageId === pageId).sort((a, b) => a.position - b.position)

  // Implementación ingenua (la antigua: N PUTs secuenciales directos).
  // Lanza a mitad si colisiona con UNIQUE(page_id, position).
  function naiveSequential(pageId: string, orders: Array<{ id: string; position: number }>) {
    const occupied = new Map(rows.filter(r => r.pageId === pageId).map(r => [r.position, r.id] as const))
    for (const o of orders) {
      const owner = occupied.get(o.position)
      if (owner !== undefined && owner !== o.id) {
        throw new Error(`UNIQUE constraint failed: buttons.page_id, buttons.position (pos ${o.position})`)
      }
      const row = rows.find(r => r.id === o.id)
      if (!row) throw new Error(`Botón no encontrado: ${o.id}`)
      occupied.delete(row.position)
      row.position = o.position
      occupied.set(o.position, o.id)
    }
  }

  // Réplica de reorderButtons: valida todo, luego dos fases atómicas.
  function reorderAtomic(pageId: string, orders: Array<{ id: string; position: number }>): Row[] {
    if (!Array.isArray(orders) || orders.length === 0) throw new Error('order vacío: nada que reordenar')
    const seen = new Set<number>()
    for (const o of orders) {
      if (!o || typeof o.id !== 'string' || !Number.isInteger(o.position) || o.position < 0) {
        throw new Error(`Orden inválido: ${JSON.stringify(o)}`)
      }
      if (seen.has(o.position)) throw new Error(`Posición destino duplicada: ${o.position}`)
      seen.add(o.position)
    }
    const before = snapshot()
    try {
      for (const o of orders) {
        const row = rows.find(r => r.id === o.id)
        if (!row) throw new Error(`Botón no encontrado: ${o.id}`)
        if (row.pageId !== pageId) throw new Error(`Botón ${o.id} no pertenece a la página ${pageId}`)
      }
      // Colisión con botones estacionarios (no incluidos en orders)
      const stationary = new Set(
        rows.filter(r => r.pageId === pageId && !orders.some(o => o.id === r.id)).map(r => r.position)
      )
      for (const o of orders) {
        if (stationary.has(o.position)) {
          throw new Error(`UNIQUE constraint failed: buttons.page_id, buttons.position (pos ${o.position})`)
        }
      }
      orders.forEach((o, i) => { rows.find(r => r.id === o.id)!.position = -1 - i })
      for (const o of orders) { rows.find(r => r.id === o.id)!.position = o.position }
    } catch (e) {
      rows = before // rollback
      throw e
    }
    return byPage(pageId).filter(r => seen.has(r.position))
  }

  return { snapshot, byPage, naiveSequential, reorderAtomic }
}

describe('button reorder atómico (fix)', () => {
  it('1. swap 0<->1 en una sola llamada atómica', () => {
    const db = makeDb([
      { id: 'a', pageId: 'p1', position: 0 },
      { id: 'b', pageId: 'p1', position: 1 },
    ])
    const updated = db.reorderAtomic('p1', [{ id: 'a', position: 1 }, { id: 'b', position: 0 }])
    expect(updated.find(r => r.id === 'a')!.position).toBe(1)
    expect(updated.find(r => r.id === 'b')!.position).toBe(0)
    expect(db.byPage('p1').map(r => r.position)).toEqual([0, 1])
  })

  it('2. ciclo 0->1->2->0: la vía ingenua rompe UNIQUE, la atómica funciona', () => {
    const seed: Row[] = [
      { id: 'a', pageId: 'p1', position: 0 },
      { id: 'b', pageId: 'p1', position: 1 },
      { id: 'c', pageId: 'p1', position: 2 },
    ]
    const orders = [
      { id: 'a', position: 1 },
      { id: 'b', position: 2 },
      { id: 'c', position: 0 },
    ]
    // La vía ingenua (PUTs secuenciales directos) choca en la PRIMERA op:
    // a->1 colisiona con b, que aún no se ha movido. Por eso el swap necesita
    // endpoint atómico con posiciones temporales.
    const naive = makeDb(seed)
    expect(() => naive.naiveSequential('p1', orders)).toThrow(/UNIQUE constraint/)
    expect(naive.snapshot()).toEqual(seed)

    // La atómica (dos fases con temporales negativos) sí lo resuelve.
    const fixed = makeDb(seed)
    fixed.reorderAtomic('p1', orders)
    expect(fixed.byPage('p1').map(r => `${r.id}@${r.position}`)).toEqual(['c@0', 'a@1', 'b@2'])
  })

  it('2b. fallo a mitad de la vía antigua (allSettled sin transacción) deja el swap a medias', () => {
    // Réplica del bug T1: con N PUTs independientes, si el 2º falla (red, 500…),
    // el 1º ya se aplicó -> posiciones duplicadas / swap incompleto.
    const rows: Row[] = [
      { id: 'a', pageId: 'p1', position: 0 },
      { id: 'b', pageId: 'p1', position: 1 },
    ]
    const put = (id: string, position: number, fail: boolean) => {
      if (fail) throw new Error('network error')
      rows.find(r => r.id === id)!.position = position
    }
    // swap 0<->1 con allSettled donde el 2º PUT falla
    const results: boolean[] = []
    try { put('a', 1, false); results.push(true) } catch { results.push(false) }
    try { put('b', 0, true); results.push(true) } catch { results.push(false) }
    expect(results).toEqual([true, false])
    // a@1 aplicado, b sigue en @1 -> DUPLICADO (sin UNIQUE nada lo impide)
    expect(rows.filter(r => r.position === 1).map(r => r.id).sort()).toEqual(['a', 'b'])

    // Con la atómica, ese mismo escenario haría rollback: todo o nada.
    const db = makeDb([
      { id: 'a', pageId: 'p1', position: 0 },
      { id: 'b', pageId: 'p1', position: 1 },
    ])
    const before = db.snapshot()
    expect(() => db.reorderAtomic('p1', [{ id: 'a', position: 1 }, { id: 'zzz', position: 0 }])).toThrow()
    expect(db.snapshot()).toEqual(before)
  })

  it('3. id desconocido: lanza y la BD queda intacta (rollback)', () => {
    const db = makeDb([
      { id: 'a', pageId: 'p1', position: 0 },
      { id: 'b', pageId: 'p1', position: 1 },
    ])
    const before = db.snapshot()
    expect(() => db.reorderAtomic('p1', [{ id: 'a', position: 1 }, { id: 'zzz', position: 0 }])).toThrow(/no encontrado/)
    expect(db.snapshot()).toEqual(before)
  })

  it('4. botón de otra página: lanza y la BD queda intacta', () => {
    const db = makeDb([
      { id: 'a', pageId: 'p1', position: 0 },
      { id: 'x', pageId: 'p2', position: 0 },
    ])
    const before = db.snapshot()
    expect(() => db.reorderAtomic('p1', [{ id: 'x', position: 1 }])).toThrow(/no pertenece/)
    expect(db.snapshot()).toEqual(before)
  })

  it('5. destinos duplicados: lanza sin tocar nada', () => {
    const db = makeDb([
      { id: 'a', pageId: 'p1', position: 0 },
      { id: 'b', pageId: 'p1', position: 1 },
    ])
    const before = db.snapshot()
    expect(() => db.reorderAtomic('p1', [{ id: 'a', position: 1 }, { id: 'b', position: 1 }])).toThrow(/duplicada/)
    expect(db.snapshot()).toEqual(before)
  })

  it('6. posiciones inválidas (negativa / no entera) y order vacío lanzan', () => {
    const db = makeDb([{ id: 'a', pageId: 'p1', position: 0 }])
    expect(() => db.reorderAtomic('p1', [{ id: 'a', position: -1 }])).toThrow(/inválido/)
    expect(() => db.reorderAtomic('p1', [{ id: 'a', position: 1.5 }])).toThrow(/inválido/)
    expect(() => db.reorderAtomic('p1', [])).toThrow(/vacío/)
    expect(db.snapshot()).toEqual([{ id: 'a', pageId: 'p1', position: 0 }])
  })

  it('7. colisión con botón estacionario: lanza y no mueve nada', () => {
    const db = makeDb([
      { id: 'a', pageId: 'p1', position: 0 },
      { id: 'b', pageId: 'p1', position: 1 },
      { id: 'quieto', pageId: 'p1', position: 5 },
    ])
    const before = db.snapshot()
    expect(() => db.reorderAtomic('p1', [{ id: 'a', position: 5 }])).toThrow(/UNIQUE constraint/)
    expect(db.snapshot()).toEqual(before)
  })

  it('8. mover a slot vacío solo toca ese botón', () => {
    const db = makeDb([
      { id: 'a', pageId: 'p1', position: 0 },
      { id: 'b', pageId: 'p1', position: 1 },
    ])
    db.reorderAtomic('p1', [{ id: 'a', position: 7 }])
    expect(db.byPage('p1').map(r => `${r.id}@${r.position}`)).toEqual(['b@1', 'a@7'])
  })
})
