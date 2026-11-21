import { describe, it, expect } from 'vitest'

// Lógica pura extraída de web/src/composables/useStreamDeck.ts (handleSwap).
// Real: newMap = event.slotItemMap?.asObject || event.newSlotItemMap?.asObject || event.map
// Si newMap falta o no es objeto → return temprano (0 updates, sin throw).
// Para cada botón busca en qué slot está ahora (`item-<buttonId>`) y si cambió
// calcula newPosition = parseInt(slot.replace('slot-', '')).
// Los slots vacíos tienen item `empty-N` y se ignoran (ningún botón mapea a ellos).

interface TestButton {
  id: string
  position: number
}

interface PositionUpdate {
  button: TestButton
  newPosition: number
}

/** Resuelve el mapa desde un evento Swapy (las 3 variantes soportadas). */
function resolveSwapMap(event: any): Record<string, string> | null {
  const newMap = event?.slotItemMap?.asObject ?? event?.newSlotItemMap?.asObject ?? event?.map
  return newMap ?? null
}

/** Calcula los updates de posición puros a partir del mapa ya resuelto. */
function parseSwapMap(newMap: unknown, buttons: TestButton[]): PositionUpdate[] {
  // Early return: mapa ausente o no-objeto → 0 updates sin throw
  if (!newMap || typeof newMap !== 'object' || Array.isArray(newMap)) {
    return []
  }
  const map = newMap as Record<string, string>
  const positionUpdates: PositionUpdate[] = []
  for (const button of buttons) {
    const newSlot = Object.keys(map).find((slot) => map[slot] === `item-${button.id}`)
    if (newSlot) {
      const newPosition = parseInt(newSlot.replace('slot-', ''), 10)
      if (button.position !== newPosition) {
        positionUpdates.push({ button, newPosition })
      }
    }
    // Sin newSlot → botón huérfano (p. ej. slot fuera del grid tras resize):
    // no genera update, se documenta en el test 7.
  }
  return positionUpdates
}

/** Punto de entrada completo: evento → updates (equivalente a handleSwap sin BD). */
function updatesFromEvent(event: any, buttons: TestButton[]): PositionUpdate[] {
  return parseSwapMap(resolveSwapMap(event), buttons)
}

const btn = (id: string, position: number): TestButton => ({ id, position })

describe('ButtonSwapMap (lógica pura de handleSwap)', () => {
  it('1. swap simple 0↔1 con 2 botones genera 2 updates con posiciones cruzadas', () => {
    const buttons = [btn('a', 0), btn('b', 1)]
    const event = { slotItemMap: { asObject: { 'slot-0': 'item-b', 'slot-1': 'item-a' } } }
    const updates = updatesFromEvent(event, buttons)
    expect(updates).toHaveLength(2)
    expect(updates).toContainEqual({ button: buttons[0], newPosition: 1 })
    expect(updates).toContainEqual({ button: buttons[1], newPosition: 0 })
  })

  it('2. mover botón a slot vacío genera 1 update (el otro botón no se toca)', () => {
    const buttons = [btn('a', 0), btn('b', 1)]
    // a se mueve al slot-2 (vacío antes); b se queda en slot-1.
    // slot-0 queda vacío (empty-0).
    const newMap = { 'slot-0': 'empty-0', 'slot-1': 'item-b', 'slot-2': 'item-a' }
    const updates = parseSwapMap(newMap, buttons)
    expect(updates).toHaveLength(1)
    expect(updates[0]).toEqual({ button: buttons[0], newPosition: 2 })
  })

  it('3. sin cambios genera 0 updates', () => {
    const buttons = [btn('a', 0), btn('b', 1)]
    const newMap = { 'slot-0': 'item-a', 'slot-1': 'item-b' }
    expect(parseSwapMap(newMap, buttons)).toEqual([])
  })

  it('4. newMap null/undefined/no-objeto → 0 updates sin throw (early return)', () => {
    const buttons = [btn('a', 0)]
    expect(parseSwapMap(null, buttons)).toEqual([])
    expect(parseSwapMap(undefined, buttons)).toEqual([])
    expect(parseSwapMap('slot-0', buttons)).toEqual([])
    expect(parseSwapMap(42, buttons)).toEqual([])
    expect(parseSwapMap(['item-a'], buttons)).toEqual([])
    // Eventos sin mapa válido tampoco lanzan
    expect(updatesFromEvent({}, buttons)).toEqual([])
    expect(updatesFromEvent(null, buttons)).toEqual([])
    expect(updatesFromEvent({ slotItemMap: null, map: 'no-objeto' }, buttons)).toEqual([])
  })

  it('5. slots `empty-N` se ignoran (ningún botón mapea a ellos)', () => {
    const buttons = [btn('a', 0), btn('b', 1)]
    const newMap = {
      'slot-0': 'item-a',
      'slot-1': 'item-b',
      'slot-2': 'empty-0',
      'slot-3': 'empty-1'
    }
    const updates = parseSwapMap(newMap, buttons)
    expect(updates).toEqual([])
    // Ningún update apunta a un slot vacío
    for (const u of updates) {
      expect((newMap as Record<string, string>)[`slot-${u.newPosition}`]).not.toMatch(/^empty-/)
    }
  })

  it('6. ciclo de 3 (0→1, 1→2, 2→0) genera 3 updates correctos', () => {
    const buttons = [btn('a', 0), btn('b', 1), btn('c', 2)]
    const newMap = { 'slot-0': 'item-c', 'slot-1': 'item-a', 'slot-2': 'item-b' }
    const updates = parseSwapMap(newMap, buttons)
    expect(updates).toHaveLength(3)
    expect(updates).toContainEqual({ button: buttons[0], newPosition: 1 })
    expect(updates).toContainEqual({ button: buttons[1], newPosition: 2 })
    expect(updates).toContainEqual({ button: buttons[2], newPosition: 0 })
  })

  it('7. botón en BD pero ausente del mapa (slot fuera de grid tras resize) no genera update (huérfano)', () => {
    const buttons = [btn('a', 0), btn('b', 1), btn('ghost', 14)]
    // Tras reducir el grid, el mapa solo cubre slot-0..slot-1; ghost ya no aparece.
    const newMap = { 'slot-0': 'item-a', 'slot-1': 'item-b' }
    const updates = parseSwapMap(newMap, buttons)
    expect(updates).toEqual([])
    // Se documenta como huérfano: está en BD pero sin slot en el mapa
    const orphans = buttons.filter(
      (b) => !Object.values(newMap).includes(`item-${b.id}`)
    )
    expect(orphans).toEqual([buttons[2]])
  })

  it('extra: acepta las variantes newSlotItemMap.asObject y map', () => {
    const buttons = [btn('a', 0), btn('b', 1)]
    const swapped = { 'slot-0': 'item-b', 'slot-1': 'item-a' }
    expect(updatesFromEvent({ newSlotItemMap: { asObject: swapped } }, buttons)).toHaveLength(2)
    expect(updatesFromEvent({ map: swapped }, buttons)).toHaveLength(2)
  })
})
