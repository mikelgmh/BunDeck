import { describe, it, expect } from 'vitest'
import { planFreeCell } from '../composables/useDeckLayouts'

// Bug: en modo Libre, con un hueco visible de 1×2, "Añadir tecla" no ponía
// nada en el hueco. Causa: la búsqueda consultaba también `position`
// (takenPos), un orden legacy que queda stale al arrastrar widgets en libre
// (mover solo persiste x/y/w/h). El hueco visible se saltaba y la tecla caía
// debajo de la cuadrícula — o el POST chocaba con 409.
// planFreeCell solo mira ocupación geométrica y devuelve position única.

const COLS = 6
const ROWS = 3

/** Página 6×3 llena salvo el hueco 1×2 en (5,0)-(5,1), con geometría = celda. */
function fullExceptGap() {
  const list: any[] = []
  for (let pos = 0; pos < 18; pos++) {
    if (pos === 5 || pos === 11) continue
    list.push({ id: `b${pos}`, position: pos, x: pos % COLS, y: Math.floor(pos / COLS), w: 1, h: 1, data: {} })
  }
  return list
}

describe('planFreeCell (Añadir tecla en Libre)', () => {
  it('repro bug: hueco 1×2 con positions stale → usa el hueco, no debajo del grid', () => {
    // Dos widgets arrastrados fuera del hueco pero con position stale (5 y 11).
    const buttons = [
      ...fullExceptGap(),
      { id: 'moved5', position: 5, x: 0, y: 0, w: 1, h: 1, data: {} },
      { id: 'moved11', position: 11, x: 1, y: 0, w: 1, h: 1, data: {} },
    ]
    const spot = planFreeCell(buttons, COLS, ROWS)
    // El algoritmo viejo devolvía {x:0, y:3, position:18} (debajo del grid).
    expect(spot).not.toBeNull()
    expect(spot!.x).toBe(5)
    expect(spot!.y).toBe(0)
    // El slot 5 lo retiene un widget movido → position desacoplada y única.
    expect(spot!.position).toBe(18)
  })

  it('hueco real sin stale → celda del hueco y position = celda', () => {
    const spot = planFreeCell(fullExceptGap(), COLS, ROWS)
    expect(spot).toEqual({ x: 5, y: 0, position: 5 })
  })

  it('grid lleno → extiende una fila debajo, con position única', () => {
    const full: any[] = []
    for (let pos = 0; pos < 18; pos++) {
      full.push({ id: `b${pos}`, position: pos, x: pos % COLS, y: Math.floor(pos / COLS), w: 1, h: 1, data: {} })
    }
    expect(planFreeCell(full, COLS, ROWS)).toEqual({ x: 0, y: 3, position: 18 })
  })

  it('sin hueco dentro del límite → null (gsNoRoom)', () => {
    const full: any[] = []
    for (let pos = 0; pos < 18; pos++) {
      full.push({ id: `b${pos}`, position: pos, x: pos % COLS, y: Math.floor(pos / COLS), w: 1, h: 1, data: {} })
    }
    expect(planFreeCell(full, COLS, ROWS, 0)).toBeNull()
  })

  it('widget 2×2 bloquea sus 4 celdas', () => {
    const buttons = [
      { id: 'big', position: 0, x: 0, y: 0, w: 2, h: 2, data: {} },
      { id: 'b2', position: 2, x: 2, y: 0, w: 1, h: 1, data: {} },
    ]
    const spot = planFreeCell(buttons, 3, 2)
    // Celdas 0,1,3,4 ocupadas por el 2×2; 2 ocupada → primera libre: (0,1)=celda 3... ocupada → (1,1)=4 ocupada → (2,1)=5.
    expect(spot).toEqual({ x: 2, y: 1, position: 5 })
  })

  it('tecla clásica sin x/y deriva su geometría de position', () => {
    const buttons = [{ id: 'legacy', position: 7, data: {} }]
    const spot = planFreeCell(buttons, COLS, ROWS)
    // Celda 7 ocupada por fallback; primera libre: 0.
    expect(spot).toEqual({ x: 0, y: 0, position: 0 })
  })

  it('página vacía → origen con position 0', () => {
    expect(planFreeCell([], COLS, ROWS)).toEqual({ x: 0, y: 0, position: 0 })
  })

  it('position nunca colisiona aunque el hueco tenga slot tomado', () => {
    const buttons = [
      ...fullExceptGap(),
      { id: 'moved5', position: 5, x: 0, y: 0, w: 1, h: 1, data: {} },
      { id: 'moved11', position: 11, x: 1, y: 0, w: 1, h: 1, data: {} },
    ]
    const taken = new Set(buttons.map((b) => b.position))
    const spot = planFreeCell(buttons, COLS, ROWS)!
    // Con position = celda (5) el POST daría 409; con max+1 no.
    expect(taken.has(spot.position)).toBe(false)
  })
})
