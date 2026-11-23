import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import { useStreamDeck } from '../composables/useStreamDeck'

// Regresión: el arranque hacía ~8 RTT en cascada estricta
// (/config → /profiles → settings → perfil+páginas → settings → botones
// → plugins en último lugar). Ahora plugins va en segundo plano desde el
// inicio y los settings viajan en paralelo con su lista correspondiente.
// Este test falla si loadProfiles vuelve a ser secuencial: exige que haya
// al menos 2 fetches en vuelo a la vez y que se toquen todos los endpoints.

const DELAY_MS = 40

function json(data: unknown) {
  return { ok: true, status: 200, json: async () => data } as Response
}

describe('bootstrap paralelo (loadProfiles)', () => {
  let inFlight = 0
  let maxInFlight = 0
  let seen: string[] = []
  let realFetch: typeof fetch | undefined

  const route = (url: string): unknown => {
    if (url.endsWith('/config')) return { wsPort: 3003, apiPort: 3001, frontendPort: 3002 }
    if (url.includes('/api/v1/profiles/')) return { id: 'p1', name: 'P', data: {} }
    if (url.includes('/api/v1/profiles')) return [{ id: 'p1', name: 'P', data: {} }]
    if (url.includes('/api/v1/pages')) return [{ id: 'pg1', profile_id: 'p1', name: 'X', is_folder: 0, data: {} }]
    if (url.includes('/api/v1/buttons')) return [{ id: 'b1', page_id: 'pg1', position: 0, data: {} }]
    if (url.includes('/api/v1/plugins/actions')) {
      return [['shell', { manifest: { id: 'shell' }, enabled: true, actions: [['shell', { dynamic: false }]] }]]
    }
    if (url.includes('/api/v1/plugins')) return { installed: [], loaded: [], detailed: [] }
    if (url.includes('/api/v1/settings')) {
      if (url.includes('current.profile_id')) return { key: 'current.profile_id', value: 'p1' }
      return { key: 'current.page_id', value: 'pg1' }
    }
    if (url.includes('/devices/streamdeck/status')) return { isConnected: false }
    throw new Error(`ruta no mockeada: ${url}`)
  }

  beforeEach(() => {
    inFlight = 0
    maxInFlight = 0
    seen = []
    realFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async (input: any) => {
      const url = String(typeof input === 'string' ? input : input?.url ?? input)
      seen.push(url)
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      try {
        await new Promise((r) => setTimeout(r, DELAY_MS))
        return json(route(url))
      } finally {
        inFlight -= 1
      }
    }) as any
    window.localStorage.clear()
  })

  afterEach(() => {
    if (realFetch) globalThis.fetch = realFetch
    vi.restoreAllMocks()
  })

  it('carga perfil, página, botones y acciones con peticiones en paralelo', async () => {
    const sd = useStreamDeck()
    await sd.loadProfiles()

    // Estado final completo pese al paralelismo.
    expect(sd.profiles.value).toHaveLength(1)
    expect(sd.currentProfile.value?.id).toBe('p1')
    expect(sd.currentPage.value?.id).toBe('pg1')
    expect(sd.currentButtons.value).toHaveLength(1)
    expect(sd.plugins.value.length).toBeGreaterThan(0)

    // Todos los endpoints del arranque se tocaron (sin contar el repintado
    // diferido del HW, que va con setTimeout de 1 s y no se espera aquí).
    const has = (frag: string) => seen.some((u) => u.includes(frag))
    for (const frag of [
      '/config',
      '/api/v1/profiles',
      '/api/v1/pages',
      '/api/v1/buttons',
      '/api/v1/plugins/actions',
      '/api/v1/plugins',
      'current.profile_id',
      'current.page_id',
    ]) {
      expect(has(frag), `falta endpoint: ${frag}`).toBe(true)
    }

    // Hubo solape real: plugins en segundo plano + settings en Promise.all.
    expect(maxInFlight).toBeGreaterThanOrEqual(2)

    sd.cleanup()
  })
})
