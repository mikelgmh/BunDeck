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
