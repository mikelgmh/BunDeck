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
  { id: 'pg-1', profile_id: 'p1', name: 'Una', order_idx: 0, is_folder: 0, data: {} },
  { id: 'pg-2', profile_id: 'p1', name: 'Dos', order_idx: 1, is_folder: 0, data: {} },
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
    if (u.includes('/settings?key=current.page_id')) return ok({ key: 'current.page_id', value: 'pg-1' })
    if (u.includes('/buttons?pageId=')) return ok([])
    if (u.includes('/plugins')) return ok({ detailed: [], plugins: [] })
    return ok({})
  }) as any
}

describe('selectProfile: el cambio de perfil se difunde a todas las pantallas', () => {
  const sent: string[] = []

  beforeEach(() => {
    localStorage.clear()
    sent.length = 0
    vi.stubGlobal('WebSocket', class {
      onopen: null = null
      onclose: null = null
      onmessage: null = null
      send(data: string) { sent.push(String(data)) }
      close() {}
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    localStorage.clear()
  })

  it('emite profile.select broadcast (target all), no solo al propio dispositivo', async () => {
    window.localStorage.setItem('libredeck_device_id', 'dev-1')
    vi.stubGlobal('fetch', mockFetch({ 'dev-1': 'pg-2' }))
    const sd = useStreamDeck()
    sd.connectWebSocket()
    await sd.selectProfile('p1')

    const selects = sent.map((s) => JSON.parse(s)).filter((m) => m.type === 'profile.select')
    expect(selects.length).toBe(1)
    expect(selects[0].payload.profileId).toBe('p1')
    // Difusión global: el daemon resuelve por dispositivo (cada pantalla su página).
    expect(selects[0].payload.target).toBe('all')
    expect(selects[0].payload.deviceId).toBeUndefined()
  })

  it('el propio editor sigue abriendo SU página asignada', async () => {
    window.localStorage.setItem('libredeck_device_id', 'dev-1')
    vi.stubGlobal('fetch', mockFetch({ 'dev-1': 'pg-2', 'dev-2': 'pg-1' }))
    const sd = useStreamDeck()
    sd.connectWebSocket()
    await sd.selectProfile('p1')
    expect(sd.currentPage.value?.id).toBe('pg-2')
  })
})
