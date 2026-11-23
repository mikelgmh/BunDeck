import { describe, it, expect, afterEach } from 'vitest'
import {
  parseLayoutMode,
  resolvePageSize,
  resolveDeckSize,
  checkPageCompatibility,
  guessDeckModel,
  firstCompatibleRoot,
  useDevices,
  DECK_MODELS,
  type LogicalDevice,
  type CompatView,
} from '../composables/useDevices'

function mkDeck(patch?: Partial<LogicalDevice>): LogicalDevice {
  return {
    id: 'd1', name: 'Deck', kind: 'deck', model: 'mk2', cols: 5, rows: 3, hw_path: null,
    ...patch,
  }
}

function mkPhone(patch?: Partial<LogicalDevice>): LogicalDevice {
  return {
    id: 'm1', name: 'Movil', kind: 'phone', model: null, cols: null, rows: null, hw_path: null,
    ...patch,
  }
}

function mkPage(patch?: Partial<CompatView>): CompatView {
  return {
    id: 'g1', name: 'Inicio', is_folder: 0, parent_id: null,
    grid_cols: 5, grid_rows: 3, data: {},
    ...patch,
  }
}

describe('useDevices: compatibilidad pagina-dispositivo', () => {
  it('deck acepta cuadricula con su tamano exacto', () => {
    expect(checkPageCompatibility(mkPage(), mkDeck()).ok).toBe(true)
  })

  it('deck rechaza modo libre', () => {
    const res = checkPageCompatibility(mkPage({ data: { layoutMode: 'gridstack' } }), mkDeck())
    expect(res.ok).toBe(false)
    expect(res.short).toBe('free-mode')
  })

  it('deck rechaza otro tamano', () => {
    const res = checkPageCompatibility(mkPage({ grid_cols: 8, grid_rows: 4 }), mkDeck())
    expect(res.ok).toBe(false)
    expect(res.short).toBe('size 8×4')
  })

  it('movil y tablet aceptan todo', () => {
    const free = mkPage({ data: { layoutMode: 'gridstack' }, grid_cols: 8, grid_rows: 4 })
    expect(checkPageCompatibility(free, mkPhone()).ok).toBe(true)
    const tablet = mkPhone({ kind: 'tablet' })
    expect(checkPageCompatibility(free, tablet).ok).toBe(true)
  })

  it('hwGrid manda sobre el modelo configurado', () => {
    const p = mkPage({ grid_cols: 3, grid_rows: 2 })
    expect(checkPageCompatibility(p, mkDeck(), undefined, { cols: 3, rows: 2 }).ok).toBe(true)
    expect(checkPageCompatibility(p, mkDeck(), undefined, { cols: 5, rows: 3 }).ok).toBe(false)
  })

  it('parseLayoutMode y resolvePageSize heredan del perfil', () => {
    expect(parseLayoutMode({ layoutMode: 'gridstack' })).toBe('gridstack')
    expect(parseLayoutMode(JSON.stringify({ layoutMode: 'gridstack' }))).toBe('gridstack')
    expect(parseLayoutMode({})).toBe('classic')
    expect(resolvePageSize({}, { gridCols: 8, gridRows: 4 })).toEqual({ cols: 8, rows: 4 })
    expect(resolvePageSize({ grid_cols: 3, grid_rows: 2 }, { gridCols: 8, gridRows: 4 })).toEqual({ cols: 3, rows: 2 })
    expect(resolvePageSize({}, {})).toEqual({ cols: 5, rows: 3 })
  })

  it('resolveDeckSize usa modelo o medidas propias', () => {
    expect(resolveDeckSize(mkDeck())).toEqual({ cols: 5, rows: 3 })
    expect(resolveDeckSize(mkDeck({ cols: 8, rows: 4 }))).toEqual({ cols: 8, rows: 4 })
    expect(resolveDeckSize(mkDeck({ model: 'xl', cols: null, rows: null }))).toEqual({ cols: 8, rows: 4 })
    expect(resolveDeckSize(mkPhone())).toBeNull()
  })

  it('guessDeckModel y catalogo DPRE', () => {
    expect(guessDeckModel({ cols: 5, rows: 3 })).toBe('mk2')
    expect(guessDeckModel({ cols: 9, rows: 9 })).toBeNull()
    expect(DECK_MODELS.map((m) => m.id).sort()).toEqual(['mini', 'mk2', 'neo', 'xl'])
  })

  it('firstCompatibleRoot solo propone raices compatibles', () => {
    const pages: CompatView[] = [
      mkPage({ id: 'g1' }),
      mkPage({ id: 'g2', name: 'Libre', data: { layoutMode: 'gridstack' } }),
      mkPage({ id: 'f1', name: 'Carpeta', is_folder: 1 }),
    ]
    const dRoot = firstCompatibleRoot(pages, mkDeck())
    expect(dRoot ? dRoot.id : null).toBe('g1')
    const mRoot = firstCompatibleRoot(pages, mkPhone())
    expect(mRoot ? mRoot.id : null).toBe('g1')
    const none = firstCompatibleRoot(pages.filter((p) => p.id === 'g2'), mkDeck())
    expect(none).toBeNull()
  })

  it('parseLayoutMode tolera doble/triple codificación histórica', () => {
    const double = JSON.stringify(JSON.stringify({ layoutMode: 'gridstack' }))
    expect(parseLayoutMode(double)).toBe('gridstack')
    const triple = JSON.stringify(double)
    expect(parseLayoutMode(triple)).toBe('gridstack')
  })

  it('una libre doblemente codificada sigue siendo incompatible con deck', () => {
    const double = JSON.stringify(JSON.stringify({ layoutMode: 'gridstack' }))
    expect(checkPageCompatibility(mkPage({ data: double as any }), mkDeck()).ok).toBe(false)
  })
})

describe('saveAssignments propaga details del 422', () => {
  const origFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = origFetch
  })

  it('conserva details para el toast (qué dispositivo/página/motivo)', async () => {
    const details = [{ deviceId: 'd1', pageId: 'g9', reason: 'página no existe en este perfil' }]
    globalThis.fetch = (async () => ({
      ok: false,
      status: 422,
      text: async () => JSON.stringify({ error: 'Asignaciones incompatibles', details }),
    })) as any
    const store = useDevices(() => '')
    let err: any = null
    try {
      await store.saveAssignments('p1', { d1: 'g1' })
    } catch (e) {
      err = e
    }
    expect(err?.status).toBe(422)
    expect(err?.details).toEqual(details)
  })
})
