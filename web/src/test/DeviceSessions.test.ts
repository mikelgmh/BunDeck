import { describe, it, expect } from 'vitest'
import { getOrCreateDeviceId, isNavigationForMe, describeNavTarget } from '../utils/sessionRouting'

function memStorage(): Pick<Storage, 'getItem' | 'setItem'> & { data: Record<string, string> } {
  const data: Record<string, string> = {}
  return {
    data,
    getItem: (k: string) => (k in data ? data[k] : null),
    setItem: (k: string, v: string) => { data[k] = v },
  }
}

describe('sessionRouting: deviceId estable', () => {
  it('persiste el mismo deviceId entre llamadas', () => {
    const s = memStorage()
    const a = getOrCreateDeviceId(s)
    const b = getOrCreateDeviceId(s)
    expect(a).toBe(b)
    expect(a.length).toBeGreaterThan(0)
  })

  it('cada almacenamiento tiene su propio id (aislamiento por browser)', () => {
    const a = getOrCreateDeviceId(memStorage())
    const b = getOrCreateDeviceId(memStorage())
    expect(a).not.toBe(b)
  })

  it('respeta un id preexistente', () => {
    const s = memStorage()
    s.setItem('libredeck_device_id', 'dev-fijo-123')
    expect(getOrCreateDeviceId(s)).toBe('dev-fijo-123')
  })
})

describe('sessionRouting: isNavigationForMe', () => {
  it('broadcast antiguo sin destino aplica a todos (compat)', () => {
    expect(isNavigationForMe({ pageId: 'p1' }, 'dev-A')).toBe(true)
    expect(isNavigationForMe({}, 'dev-A')).toBe(true)
    expect(isNavigationForMe(null, 'dev-A')).toBe(true)
    expect(isNavigationForMe({ target: 'all' }, 'dev-A')).toBe(true)
    expect(isNavigationForMe({ targetDeviceId: 'all' }, 'dev-A')).toBe(true)
  })

  it('dirigido a otro dispositivo se ignora', () => {
    expect(isNavigationForMe({ pageId: 'p1', targetDeviceId: 'dev-B' }, 'dev-A')).toBe(false)
    expect(isNavigationForMe({ target: 'dev-B' }, 'dev-A')).toBe(false)
    expect(isNavigationForMe({ deviceId: 'dev-B' }, 'dev-A')).toBe(false)
  })

  it('dirigido al propio se aplica', () => {
    expect(isNavigationForMe({ pageId: 'p1', targetDeviceId: 'dev-A' }, 'dev-A')).toBe(true)
    expect(isNavigationForMe({ target: 'dev-A' }, 'dev-A')).toBe(true)
  })

  it('targets[] con mezcla respeta inclusión', () => {
    expect(isNavigationForMe({ targets: ['dev-B', 'dev-A'] }, 'dev-A')).toBe(true)
    expect(isNavigationForMe({ targets: ['dev-B', 'dev-C'] }, 'dev-A')).toBe(false)
    expect(isNavigationForMe({ targets: [] }, 'dev-A')).toBe(true)
    expect(isNavigationForMe({ targets: ['all'] }, 'dev-A')).toBe(true)
  })

  it('clientId propio también vale como destino', () => {
    expect(isNavigationForMe({ target: 'c-123' }, 'dev-A', 'c-123')).toBe(true)
    expect(isNavigationForMe({ target: 'c-999' }, 'dev-A', 'c-123')).toBe(false)
  })

  it('profile.navigate usa las mismas reglas', () => {
    expect(isNavigationForMe({ profileId: 'p', targetDeviceId: 'dev-B' }, 'dev-A')).toBe(false)
    expect(isNavigationForMe({ profileId: 'p' }, 'dev-A')).toBe(true)
  })
})

describe('sessionRouting: describeNavTarget', () => {
  it('describe el destino para depuración', () => {
    expect(describeNavTarget({ targetDeviceId: 'dev-B' })).toBe('dev-B')
    expect(describeNavTarget({ target: 'dev-C' })).toBe('dev-C')
    expect(describeNavTarget({ broadcast: true })).toBe('all')
    expect(describeNavTarget({ pageId: 'p' })).toBe('all')
  })
})

// Réplica mínima del filtrado que hace useStreamDeck ante page.navigate:
// dos "clientes" con distinto deviceId; solo el objetivo cambia de página.
describe('sessionRouting: aislamiento de 2 clientes (integración lógica)', () => {
  function deliver(payload: any, clients: Array<{ device: string; page: string }>): void {
    for (const c of clients) {
      if (isNavigationForMe(payload, c.device)) c.page = payload.pageId
    }
  }

  it('navegación dirigida solo mueve al objetivo', () => {
    const clients = [
      { device: 'dev-A', page: 'p1' },
      { device: 'dev-B', page: 'p1' },
    ]
    deliver({ pageId: 'p2', targetDeviceId: 'dev-B' }, clients)
    expect(clients[0].page).toBe('p1')
    expect(clients[1].page).toBe('p2')
  })

  it('broadcast mueve a todos', () => {
    const clients = [
      { device: 'dev-A', page: 'p1' },
      { device: 'dev-B', page: 'p1' },
    ]
    deliver({ pageId: 'p2' }, clients)
    expect(clients.map((c) => c.page)).toEqual(['p2', 'p2'])
  })
})
