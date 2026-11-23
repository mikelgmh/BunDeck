import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { useStreamDeck } from '../composables/useStreamDeck'
import { resolvePageSize } from '../composables/useDevices'

/**
 * Regresión: el tamaño de grid es POR PÁGINA (pages.grid_cols/grid_rows,
 * NULL = hereda del perfil). Cambiar filas/columnas en una página no debe
 * tocar a las demás ni al perfil.
 *
 * Cubre:
 * 1. resolvePageSize respeta el grid propio de la página (y hereda si NULL).
 * 2. selectPage aplica el tamaño de la página seleccionada.
 * 3. changeGridSize persiste en la PÁGINA (PUT /pages/:id con grid_cols/
 *    grid_rows), nunca en el perfil, y no altera a la otra página.
 */

function okJson(payload: any) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(payload),
    json: async () => payload,
  } as any
}

describe('grid por página (regresión Deck 5x3)', () => {
  const origFetch = globalThis.fetch
  let puts: Array<{ path: string; body: any }> = []

  // Estado "servidor" en memoria.
  const profile = {
    id: 'p1',
    name: 'default',
    data: { isDefault: true, gridCols: 5, gridRows: 3 },
  }
  const pages: Record<string, any> = {}

  beforeEach(() => {
    puts = []
    pages['deck'] = {
      id: 'deck', profile_id: 'p1', name: 'Deck 5x3',
      order_idx: 0, is_folder: 0, grid_cols: 5, grid_rows: 3, data: {},
    }
    pages['mini'] = {
      id: 'mini', profile_id: 'p1', name: 'Mini 3x2',
      order_idx: 1, is_folder: 0, grid_cols: 3, grid_rows: 2, data: {},
    }

    globalThis.fetch = (async (input: any, init: any = {}) => {
      const url = new URL(String(input))
      const method = (init.method ?? 'GET').toUpperCase()
      const path = url.pathname
      const body = init.body ? JSON.parse(String(init.body)) : undefined

      if (path === '/config') return okJson({ wsPort: 3003, apiPort: 3001, frontendPort: 3002 })
      if (path === '/api/v1/profiles' && method === 'GET') return okJson([profile])
      if (path === '/api/v1/profiles/p1' && method === 'GET') return okJson(profile)
      if (path === '/api/v1/profiles/p1' && method === 'PUT') {
        puts.push({ path, body })
        return okJson(profile)
      }
      if (path === '/api/v1/pages' && method === 'GET') return okJson(Object.values(pages))
      if (path === '/api/v1/plugins/actions' && method === 'GET') return okJson([])
      if (path === '/api/v1/plugins' && method === 'GET') return okJson({ detailed: [] })
      if (path === '/api/v1/settings' && method === 'POST') return okJson({})
      if (path === '/api/v1/settings' && method === 'GET') {
        const key = url.searchParams.get('key')
        if (key === 'current.profile_id') return okJson({ value: 'p1' })
        if (key === 'current.page_id') return okJson({ value: 'deck' })
        return okJson({ value: null })
      }
      if (path === '/api/v1/buttons' && method === 'GET') return okJson([])
      const mPage = path.match(/^\/api\/v1\/pages\/([^/]+)$/)
      if (mPage && method === 'PUT') {
        puts.push({ path, body })
        const pg = pages[mPage[1]]
        if (body.grid_cols !== undefined) pg.grid_cols = body.grid_cols
        if (body.grid_rows !== undefined) pg.grid_rows = body.grid_rows
        return okJson({ ...pg })
      }
      return okJson({})
    }) as any
  })

  afterEach(() => {
    globalThis.fetch = origFetch
  })

  it('resolvePageSize: el grid propio manda, NULL hereda del perfil', () => {
    expect(resolvePageSize({ grid_cols: 5, grid_rows: 3 }, { gridCols: 3, gridRows: 2 }))
      .toEqual({ cols: 5, rows: 3 })
    expect(resolvePageSize({ grid_cols: 3, grid_rows: 2 }, { gridCols: 5, gridRows: 3 }))
      .toEqual({ cols: 3, rows: 2 })
    expect(resolvePageSize({ grid_cols: null, grid_rows: null }, { gridCols: 5, gridRows: 3 }))
      .toEqual({ cols: 5, rows: 3 })
  })

  it('navegar entre páginas restaura el tamaño de cada una', async () => {
    const store = useStreamDeck()
    await store.loadProfiles()
    // Arranca en Deck 5x3 (current.page_id = deck).
    expect(store.currentPage.value?.id).toBe('deck')
    expect(store.gridCols.value).toBe(5)
    expect(store.gridRows.value).toBe(3)

    await store.selectPage('mini')
    expect(store.gridCols.value).toBe(3)
    expect(store.gridRows.value).toBe(2)

    await store.selectPage('deck')
    expect(store.gridCols.value).toBe(5)
    expect(store.gridRows.value).toBe(3)
    store.cleanup()
  })

  it('changeGridSize guarda en la página actual, sin tocar perfil ni otras páginas', async () => {
    const store = useStreamDeck()
    await store.loadProfiles()
    await store.selectPage('mini')

    await store.changeGridSize(1, 0) // Mini 3x2 -> 4x2

    const pagePuts = puts.filter((p) => p.path.startsWith('/api/v1/pages/'))
    const profilePuts = puts.filter((p) => p.path.startsWith('/api/v1/profiles/'))
    // El tamaño vive en la página: un solo PUT a la página, ninguno al perfil.
    expect(profilePuts).toHaveLength(0)
    expect(pagePuts).toHaveLength(1)
    expect(pagePuts[0].path).toBe('/api/v1/pages/mini')
    expect(pagePuts[0].body.grid_cols).toBe(4)
    expect(pagePuts[0].body.grid_rows).toBe(2)
    // Reflejo local inmediato.
    expect(store.gridCols.value).toBe(4)
    expect(store.gridRows.value).toBe(2)

    // La otra página sigue intacta en el "servidor" y al volver se restaura.
    expect(pages['deck'].grid_cols).toBe(5)
    expect(pages['deck'].grid_rows).toBe(3)
    await store.selectPage('deck')
    expect(store.gridCols.value).toBe(5)
    expect(store.gridRows.value).toBe(3)
    store.cleanup()
  })
})
