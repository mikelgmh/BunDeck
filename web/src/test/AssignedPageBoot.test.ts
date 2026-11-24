import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useStreamDeck } from '../composables/useStreamDeck'

vi.mock('../composables/useI18n', () => ({
  useI18nStore: () => ({
    t: (key: string) => key,
    currentLocale: { value: 'es' },
    setLocale: () => {},
    loadSavedLocale: () => {},
  }),
}))

const pages = [
  { id: 'pg-global', profile_id: 'p1', name: 'Global', order_idx: 0, is_folder: 0, data: {} },
  { id: 'pg-asg', profile_id: 'p1', name: 'Asignada', order_idx: 1, is_folder: 0, data: {} },
]

function mockFetch(assignments: Record<string, string>) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url)
    const method = init?.method ?? 'GET'
    const ok = (json: unknown) => ({ ok: true, status: 200, json: async () => json, text: async () => '' })
    if (u.endsWith('/config')) return ok({ apiPort: 3001, wsPort: 3003, frontendPort: 3002 })
    if (method === 'GET' && /\/profiles\/[^/]+\/assignments/.test(u)) {
      return ok({ assignments, repaired: { dropped: [] } })
    }
    if (method === 'GET' && /\/profiles\/[^/]+$/.test(u)) return ok({ id: 'p1', name: 'P', data: {} })
    if (method === 'GET' && u.includes('/profiles')) return ok([{ id: 'p1', name: 'P', data: {} }])
    if (u.includes('/pages?profileId=')) return ok(pages)
    if (u.includes('/settings?key=current.page_id')) return ok({ key: 'current.page_id', value: 'pg-global' })
    if (u.includes('/buttons?pageId=')) return ok([])
    if (u.includes('/plugins')) return ok({ detailed: [], plugins: [] })
    return ok({})
  }) as any
}

describe('loadProfile: la pantalla asignada manda al arrancar', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.stubGlobal('WebSocket', class {
      onopen: null = null
      onclose: null = null
      onmessage: null = null
      send() {}
      close() {}
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    localStorage.clear()
  })

  it('abre la página asignada al dispositivo (kiosco incluido)', async () => {
    window.localStorage.setItem('libredeck_device_id', 'dev-1')
    vi.stubGlobal('fetch', mockFetch({ 'dev-1': 'pg-asg' }))
    const sd = useStreamDeck()
    await sd.selectProfile('p1')
    expect(sd.currentPage.value?.id).toBe('pg-asg')
  })

  it('sin asignación abre la global guardada', async () => {
    window.localStorage.setItem('libredeck_device_id', 'dev-2')
    vi.stubGlobal('fetch', mockFetch({}))
    const sd = useStreamDeck()
    await sd.selectProfile('p1')
    expect(sd.currentPage.value?.id).toBe('pg-global')
  })
})
