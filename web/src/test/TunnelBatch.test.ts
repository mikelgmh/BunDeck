import { describe, expect, it } from 'vitest'
import {
  applyButtonDeleted,
  applyButtonPayload,
  applyButtonsReordered,
  applyPageDeleted,
  applyPagePayload,
  buildExecuteManyBody,
  dynamicIntervalScale,
  isBatchUnsupported,
  isDynamicDue,
  reloadDebounceMs,
  removeButton,
  upsertButton,
  upsertPage,
} from '../utils/wsIncremental'

const btn = (id: string, position: number, page_id = 'p1', label = '') => ({
  id,
  page_id,
  position,
  data: { label, actions: [] },
})

describe('wsIncremental: ritmo en túnel', () => {
  it('debounce 200 ms local → ~1 s en túnel', () => {
    expect(reloadDebounceMs(false)).toBe(200)
    expect(reloadDebounceMs(true)).toBe(1000)
  })

  it('intervalo dinámico ×4 en túnel, ×1 local', () => {
    expect(dynamicIntervalScale(false)).toBe(1)
    expect(dynamicIntervalScale(true)).toBe(4)
  })

  it('isDynamicDue respeta el intervalo individual y la escala', () => {
    // Local: 1000 ms base.
    expect(isDynamicDue(2000, 0, 1000, false)).toBe(true)
    expect(isDynamicDue(500, 0, 1000, false)).toBe(false)
    // Túnel: 1000 ms base → 4000 ms efectivos.
    expect(isDynamicDue(3500, 0, 1000, true)).toBe(false)
    expect(isDynamicDue(4000, 0, 1000, true)).toBe(true)
    // Intervalo personalizado (p. ej. 500 ms → 2000 ms en túnel).
    expect(isDynamicDue(1500, 0, 500, true)).toBe(false)
    expect(isDynamicDue(2000, 0, 500, true)).toBe(true)
  })
})

describe('wsIncremental: botones sin refetch', () => {
  it('upsertButton inserta y sustituye por id', () => {
    const list = [btn('b1', 0), btn('b2', 1)]
    expect(upsertButton(list, btn('b3', 2))).toHaveLength(3)
    const next = upsertButton(list, { ...btn('b1', 0), data: { label: 'nuevo', actions: [] } })
    expect(next).toHaveLength(2)
    expect(next[0].data.label).toBe('nuevo')
  })

  it('removeButton quita por id', () => {
    const list = [btn('b1', 0), btn('b2', 1)]
    const { list: next, removed } = removeButton(list, 'b1')
    expect(removed).toBe(true)
    expect(next.map((b) => b.id)).toEqual(['b2'])
    expect(removeButton(list, 'zzz').removed).toBe(false)
  })

  it('applyButtonPayload aplica el objeto del evento (pulsar no refetchea)', () => {
    const list = [btn('b1', 0, 'p1', 'viejo')]
    const { list: next, handled } = applyButtonPayload(list, 'p1', {
      buttonId: 'b1',
      button: btn('b1', 0, 'p1', 'nuevo'),
      pageId: 'p1',
    })
    expect(handled).toBe(true)
    expect(next[0].data.label).toBe('nuevo')
  })

  it('applyButtonPayload de otra página queda manejado sin tocar la vista', () => {
    const list = [btn('b1', 0, 'p1')]
    const { list: next, handled } = applyButtonPayload(list, 'p1', {
      buttonId: 'b9',
      button: btn('b9', 3, 'p2'),
      pageId: 'p2',
    })
    expect(handled).toBe(true)
    expect(next).toBe(list)
  })

  it('applyButtonPayload sin botón → no manejado (fallback a recarga)', () => {
    const list = [btn('b1', 0, 'p1')]
    expect(applyButtonPayload(list, 'p1', { buttonId: 'b1' }).handled).toBe(false)
  })

  it('applyButtonDeleted quita por id del evento', () => {
    const list = [btn('b1', 0, 'p1'), btn('b2', 1, 'p1')]
    const { list: next, handled } = applyButtonDeleted(list, 'p1', { buttonId: 'b1', pageId: 'p1' })
    expect(handled).toBe(true)
    expect(next.map((b) => b.id)).toEqual(['b2'])
  })

  it('applyButtonsReordered aplica la lista del evento', () => {
    const list = [btn('b1', 0, 'p1'), btn('b2', 1, 'p1')]
    const reordered = [btn('b2', 0, 'p1'), btn('b1', 1, 'p1')]
    const { list: next, handled } = applyButtonsReordered(list, 'p1', {
      pageId: 'p1',
      buttons: reordered,
    })
    expect(handled).toBe(true)
    expect(next.map((b) => b.id)).toEqual(['b2', 'b1'])
    // Sin array → recarga.
    expect(applyButtonsReordered(list, 'p1', { pageId: 'p1' }).handled).toBe(false)
    // Otra página → manejado sin tocar nada.
    expect(applyButtonsReordered(list, 'p1', { pageId: 'p2', buttons: [] }).handled).toBe(true)
  })
})

describe('wsIncremental: páginas sin refetch', () => {
  it('upsertPage inserta y actualiza por id', () => {
    const list = [{ id: 'p1', name: 'A' }]
    expect(upsertPage(list as any, { id: 'p2', name: 'B' })).toHaveLength(2)
    const next = upsertPage(list as any, { id: 'p1', name: 'A2' })
    expect(next[0].name).toBe('A2')
  })

  it('applyPagePayload aplica el objeto del evento', () => {
    const list = [{ id: 'p1', name: 'A' }]
    const { list: next, handled } = applyPagePayload(list as any, {
      page: { id: 'p1', name: 'A renombrada' },
    })
    expect(handled).toBe(true)
    expect(next[0].name).toBe('A renombrada')
  })

  it('applyPageDeleted quita sin refetch', () => {
    const list = [{ id: 'p1', name: 'A' }, { id: 'p2', name: 'B' }]
    const { list: next, removed } = applyPageDeleted(list as any, 'p1')
    expect(removed).toBe(true)
    expect(next.map((p) => p.id)).toEqual(['p2'])
  })
})

describe('wsIncremental: batch de ejecución/sondeo', () => {
  it('buildExecuteManyBody empaqueta items con su contexto', () => {
    const body = buildExecuteManyBody([
      { action: { type: 'a' }, context: { buttonId: 'b1', position: 0, quiet: true } },
      { action: { type: 'b' }, context: { buttonId: 'b2', position: 1, quiet: true } },
    ])
    expect(body.items).toHaveLength(2)
    expect(body.items[0].context.buttonId).toBe('b1')
    expect(body.items[1].action.type).toBe('b')
  })

  it('isBatchUnsupported detecta daemon viejo (404 / endpoint not found)', () => {
    expect(isBatchUnsupported(new Error('API Error: 404'))).toBe(true)
    expect(isBatchUnsupported(new Error('API endpoint not found'))).toBe(true)
    expect(isBatchUnsupported(new Error('boom'))).toBe(false)
  })
})
