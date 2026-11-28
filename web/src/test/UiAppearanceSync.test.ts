import { describe, it, expect, vi, beforeEach } from 'vitest'

function stubMatchMedia(light: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: vi.fn().mockImplementation((q: string) => ({
      matches: String(q).includes('prefers-color-scheme: light') ? light : false,
      media: q,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    }))
  })
}

async function loadUi(pathname: string, light: boolean) {
  vi.resetModules()
  localStorage.clear()
  window.history.pushState({}, '', pathname)
  stubMatchMedia(light)
  return await import('../composables/useBunDeckUi')
}

describe('ui appearance sync host → remote', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('el host es localhost', async () => {
    const ui = await loadUi('/', false)
    expect(ui.isHostClient()).toBe(true)
  })

  it('el túnel (/t/<token>/) no es host', async () => {
    const ui = await loadUi('/t/abc123/', false)
    expect(ui.isHostClient()).toBe(false)
  })

  it('remoto en claro sigue al host en oscuro con auto', async () => {
    const ui = await loadUi('/t/abc123/', true) // iPad con el sistema en claro
    expect(ui.bdPalette.value).toBe('auto')
    const ok = ui.applyRemoteAppearance({
      palette: 'auto',
      labelMode: 'a',
      keySize: 76,
      radius: 16,
      brightness: 80,
      animations: true,
      longPressMs: 500,
      systemLight: false, // el `auto` del host resolvió oscuro
      updatedAt: 1000,
      updatedBy: 'host'
    })
    expect(ok).toBe(true)
    // Aunque el sistema local sea claro, manda el del host.
    expect(ui.bdResolvedPalette.value).toBe('grafito')
  })

  it('ignora broadcasts obsoletos (no pisa cambios más recientes)', async () => {
    const ui = await loadUi('/', false)
    expect(ui.applyRemoteAppearance({ palette: 'papel', updatedAt: 2000 })).toBe(true)
    expect(ui.bdPalette.value).toBe('papel')
    expect(ui.applyRemoteAppearance({ palette: 'grafito', updatedAt: 1000 })).toBe(false)
    expect(ui.bdPalette.value).toBe('papel')
  })

  it('la paleta explícita manda sobre el sistema local', async () => {
    const ui = await loadUi('/', false)
    ui.applyRemoteAppearance({ palette: 'medianoche', updatedAt: 5 })
    expect(ui.bdResolvedPalette.value).toBe('medianoche')
  })
})

describe('re-sync de apariencia tras desconexión (sin recarga)', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  function stubSettingsGet(serverValue: unknown) {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(init?.method ?? 'GET').toUpperCase() === 'POST') {
        return { ok: true, json: async () => ({}) }
      }
      return { ok: true, json: async () => ({ key: 'ui.appearance', value: serverValue }) }
    })
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  it('refresh aplica el snapshot del servidor cuando es más nuevo', async () => {
    const ui = await loadUi('/', false)
    expect(ui.applyRemoteAppearance({ palette: 'papel', updatedAt: 2000 })).toBe(true)
    stubSettingsGet(JSON.stringify({ palette: 'medianoche', updatedAt: 3000 }))
    await ui.refreshAppearanceFromServer()
    expect(ui.bdPalette.value).toBe('medianoche')
  })

  it('refresh ignora el snapshot obsoleto (no pisa cambios locales)', async () => {
    const ui = await loadUi('/', false)
    expect(ui.applyRemoteAppearance({ palette: 'papel', updatedAt: 5000 })).toBe(true)
    stubSettingsGet(JSON.stringify({ palette: 'grafito', updatedAt: 1000 }))
    await ui.refreshAppearanceFromServer()
    expect(ui.bdPalette.value).toBe('papel')
  })

  it('refresh descarta el push local encolado (el servidor manda)', async () => {
    vi.useFakeTimers()
    const ui = await loadUi('/', false)
    expect(ui.applyRemoteAppearance({ palette: 'papel', updatedAt: 2000 })).toBe(true)
    const fetchMock = stubSettingsGet(JSON.stringify({ palette: 'medianoche', updatedAt: 3000 }))
    // Cambio local que encola un push con la foto vieja (dispara a los 400 ms).
    ui.bdSetPalette('grafito')
    // Antes de que dispare, reconecta: el snapshot del host debe ganar y el
    // push obsoleto no debe emitirse (cero POST).
    await ui.refreshAppearanceFromServer()
    expect(ui.bdPalette.value).toBe('medianoche')
    await vi.advanceTimersByTimeAsync(800)
    const posts = fetchMock.mock.calls.filter((c) => String(c[1]?.method ?? '').toUpperCase() === 'POST')
    expect(posts).toHaveLength(0)
    vi.useRealTimers()
  })

  it('bdSetPanels no emite nada al servidor (layout local de cada pantalla)', async () => {
    vi.useFakeTimers()
    const ui = await loadUi('/', false)
    const fetchMock = stubSettingsGet(null)
    ui.bdSetPanels(false, true)
    await vi.advanceTimersByTimeAsync(800)
    expect(fetchMock).not.toHaveBeenCalled()
    // Sanidad: un cambio de tema real sí sigue emitiéndose.
    ui.bdSetPalette('papel')
    await vi.advanceTimersByTimeAsync(800)
    const posts = fetchMock.mock.calls.filter((c) => String(c[1]?.method ?? '').toUpperCase() === 'POST')
    expect(posts.length).toBeGreaterThan(0)
    vi.useRealTimers()
  })

  it('throttle: dos refresh seguidos → un solo GET (sin bucles)', async () => {
    const ui = await loadUi('/', false)
    const fetchMock = stubSettingsGet(JSON.stringify({ palette: 'medianoche', updatedAt: 3000 }))
    await ui.refreshAppearanceFromServer()
    await ui.refreshAppearanceFromServer()
    const gets = fetchMock.mock.calls.filter((c) => String(c[1]?.method ?? 'GET').toUpperCase() !== 'POST')
    expect(gets).toHaveLength(1)
    expect(ui.bdPalette.value).toBe('medianoche')
  })
})
