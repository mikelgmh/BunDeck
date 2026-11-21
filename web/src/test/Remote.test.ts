import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { isValidPairCode, toggleInList } from '../composables/useRemote'
import RemotePane from '../components/bundeck/RemotePane.vue'

vi.mock('../composables/useI18n', () => ({
  useI18nStore: () => ({
    t: (key: string) => key,
    currentLocale: { value: 'es' },
    setLocale: () => {},
    loadSavedLocale: () => {},
  }),
}))

const statusOk = {
  deviceId: 'dev-local-12345678',
  fingerprint: 'ab12:34cd:56ef:78ab:90cd:12ef:34ab:56cd',
  publicKey: 'cHViLWtleQ==',
  relay: { url: '', status: 'disabled' },
  pending: 0,
  trusted: 0,
  policy: ['page.select', 'button.press'],
}

function mockFetch() {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url)
    const method = init?.method ?? 'GET'
    if (u.endsWith('/config')) return { ok: true, json: async () => ({ apiPort: 3001, wsPort: 3003 }) }
    if (u.includes('/remote/status')) return { ok: true, json: async () => statusOk }
    if (u.includes('/remote/devices') && method === 'GET') return { ok: true, json: async () => ({ devices: [] }) }
    if (u.includes('/remote/pair-code')) {
      return { ok: true, json: async () => ({ code: '482913', fingerprint: statusOk.fingerprint, expiresAt: Date.now() + 600000 }) }
    }
    return { ok: true, json: async () => ({ ok: true }) }
  })
}

describe('useRemote helpers', () => {
  it('isValidPairCode solo acepta 6 dígitos', () => {
    expect(isValidPairCode('482913')).toBe(true)
    expect(isValidPairCode(' 482913 ')).toBe(true)
    expect(isValidPairCode('abc')).toBe(false)
    expect(isValidPairCode('12345')).toBe(false)
    expect(isValidPairCode('')).toBe(false)
  })

  it('toggleInList añade y quita', () => {
    expect(toggleInList(['a'], 'b')).toEqual(['a', 'b'])
    expect(toggleInList(['a', 'b'], 'b')).toEqual(['a'])
  })
})

describe('RemotePane', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    // Evita que el panel abra un WebSocket real (jsdom/undici): mock mínimo.
    vi.stubGlobal(
      'WebSocket',
      class {
        static OPEN = 1
        readyState = 1
        onopen: ((e?: unknown) => void) | null = null
        onmessage: ((e?: unknown) => void) | null = null
        onclose: ((e?: unknown) => void) | null = null
        onerror: ((e?: unknown) => void) | null = null
        send() {}
        close() {}
      }
    )
  })

  it('muestra generar código, aceptar y lista vacía con data-cy', async () => {
    vi.stubGlobal('fetch', mockFetch())
    const wrapper = mount(RemotePane)
    await flushPromises()
    expect(wrapper.find('[data-cy="remote-pane"]').exists()).toBe(true)
    expect(wrapper.find('[data-cy="remote-gen-code"]').exists()).toBe(true)
    expect(wrapper.find('[data-cy="remote-accept-code"]').exists()).toBe(true)
    expect(wrapper.find('[data-cy="remote-accept-device"]').exists()).toBe(true)
    expect(wrapper.find('[data-cy="remote-accept-pubkey"]').exists()).toBe(true)
    expect(wrapper.find('[data-cy="remote-accept-btn"]').exists()).toBe(true)
    expect(wrapper.find('[data-cy="remote-rotate"]').exists()).toBe(true)
  })

  it('Entrar desde internet es la primera tarjeta (vía principal)', async () => {
    vi.stubGlobal('fetch', mockFetch())
    const wrapper = mount(RemotePane)
    await flushPromises()
    const html = wrapper.html()
    expect(html.indexOf('data-cy="remote-ui-section"')).toBeGreaterThan(-1)
    expect(html.indexOf('data-cy="remote-pair-section"')).toBeGreaterThan(-1)
    expect(html.indexOf('data-cy="remote-ui-section"')).toBeLessThan(html.indexOf('data-cy="remote-pair-section"'))
    // Sin churro de estado: ni fingerprint local ni badge de relay.
    expect(wrapper.find('[data-cy="remote-status"]').exists()).toBe(false)
  })

  it('generar código muestra el código con data-cy', async () => {
    vi.stubGlobal('fetch', mockFetch())
    const wrapper = mount(RemotePane)
    await flushPromises()
    await wrapper.find('[data-cy="remote-gen-code"]').trigger('click')
    await flushPromises()
    const code = wrapper.find('[data-cy="remote-pair-code"]')
    expect(code.exists()).toBe(true)
    expect(code.text()).toContain('482913')
  })

  it('separa las dos funciones en dos tarjetas con título e icono propios', async () => {
    vi.stubGlobal('fetch', mockFetch())
    const wrapper = mount(RemotePane)
    await flushPromises()
    const pair = wrapper.find('[data-cy="remote-pair-section"]')
    expect(pair.exists()).toBe(true)
    expect(pair.text()).toContain('bd.remotePairTitle')
    expect(pair.text()).toContain('bd.remotePairSub')
    expect(pair.text()).toContain('bd.remotePairNeedBoth')
    // Cada sección lleva su propio icono (Link2 vs Globe).
    expect(pair.find('svg').exists()).toBe(true)
    const ui = wrapper.find('[data-cy="remote-ui-section"]')
    expect(ui.exists()).toBe(true)
    expect(ui.text()).toContain('bd.remoteUiTitle')
    expect(ui.text()).toContain('bd.remoteUiSub')
    expect(ui.find('svg').exists()).toBe(true)
    // El QR de emparejamiento se distingue por su botón propio.
    expect(wrapper.find('[data-cy="remote-qr-show"]').text()).toContain('bd.remoteQrShow')
  })
})
