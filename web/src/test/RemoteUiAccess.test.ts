import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import RemotePane from '../components/bundeck/RemotePane.vue'

vi.mock('qrcode', () => ({
  default: {
    toDataURL: async (text: string) => `data:image/png;base64,QR:${String(text).length}`,
  },
}))

vi.mock('../composables/useI18n', () => ({
  useI18nStore: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      if (!params) return key
      return `${key} ${Object.values(params).join(' ')}`
    },
    currentLocale: { value: 'es' },
    setLocale: () => {},
    loadSavedLocale: () => {},
  }),
}))

const statusBase = {
  deviceId: 'dev-local-12345678',
  fingerprint: 'ab12:34cd:56ef:78ab:90cd:12ef:34ab:56cd',
  publicKey: 'cHViLWtleQ==',
  relay: { url: '', status: 'disabled' },
  pending: 0,
  trusted: 0,
  policy: ['page.select', 'button.press'],
}

type FetchOpts = {
  ui404?: boolean
  uiEnabled?: boolean
  pending?: Array<Record<string, unknown>>
  sessions?: Array<Record<string, unknown>>
  uiCode?: Record<string, unknown> | null
}

function makeFetch(opts: FetchOpts = {}) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  let enabled = opts.uiEnabled ?? false
  let pending = opts.pending ?? []
  const sessions = opts.sessions ?? []
  const state = { enabled, pending: [...pending], sessions: [...sessions], code: opts.uiCode ?? null as unknown }

  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url)
    const method = init?.method ?? 'GET'
    calls.push({ url: u, init })
    if (u.endsWith('/config')) return { ok: true, status: 200, json: async () => ({ apiPort: 3001, wsPort: 3003 }) }
    if (u.includes('/remote/status')) {
      return { ok: true, status: 200, json: async () => ({ ...statusBase, uiEnabled: state.enabled }) }
    }
    if (u.includes('/remote/devices') && method === 'GET') {
      return { ok: true, status: 200, json: async () => ({ devices: [] }) }
    }
    // --- UI remota ---
    if (u.includes('/remote/ui-enabled')) {
      if (opts.ui404) return { ok: false, status: 404, json: async () => ({}) }
      const body = JSON.parse(String((init as RequestInit)?.body ?? '{}'))
      state.enabled = !!body.enabled
      if (!state.enabled) {
        state.pending = []
      }
      return { ok: true, status: 200, json: async () => ({ uiEnabled: state.enabled }) }
    }
    if (u.includes('/remote/ui-code')) {
      if (opts.ui404) return { ok: false, status: 404, json: async () => ({}) }
      if (method === 'POST') {
        state.code = {
          code: '123456',
          urlCode: 'abc123',
          url: 'https://relay.example/ui#abc123',
          expiresAt: Date.now() + 120000,
        }
        return { ok: true, status: 200, json: async () => state.code }
      }
      state.code = null
      return { ok: true, status: 200, json: async () => ({ ok: true }) }
    }
    if (u.includes('/remote/ui-pending/') && u.endsWith('/allow')) {
      if (opts.ui404) return { ok: false, status: 404, json: async () => ({}) }
      state.pending = []
      return { ok: true, status: 200, json: async () => ({ ok: true, sessionToken: 'SECRET-TOKEN-123' }) }
    }
    if (u.includes('/remote/ui-pending/') && u.endsWith('/deny')) {
      if (opts.ui404) return { ok: false, status: 404, json: async () => ({}) }
      state.pending = []
      return { ok: true, status: 200, json: async () => ({ ok: true }) }
    }
    if (u.includes('/remote/ui-pending')) {
      if (opts.ui404) return { ok: false, status: 404, json: async () => ({}) }
      return { ok: true, status: 200, json: async () => ({ pending: state.pending }) }
    }
    if (u.includes('/remote/ui-sessions/') && method === 'DELETE') {
      if (opts.ui404) return { ok: false, status: 404, json: async () => ({}) }
      state.sessions = []
      return { ok: true, status: 200, json: async () => ({ ok: true }) }
    }
    if (u.includes('/remote/ui-sessions')) {
      if (opts.ui404) return { ok: false, status: 404, json: async () => ({}) }
      return { ok: true, status: 200, json: async () => ({ sessions: state.sessions }) }
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }) }
  })
  return { fn, calls, state }
}

function stubNoWs() {
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
}

describe('RemotePane UI remota', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    stubNoWs()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('toggle on/off con data-cy y llamadas a ui-enabled', async () => {
    const { fn, calls } = makeFetch()
    vi.stubGlobal('fetch', fn)
    const wrapper = mount(RemotePane)
    await flushPromises()

    const toggle = wrapper.find('[data-cy="remote-ui-toggle"]')
    expect(toggle.exists()).toBe(true)
    expect((toggle.element as HTMLInputElement).checked).toBe(false)

    await toggle.setValue(true)
    await flushPromises()
    const post = calls.find((c) => c.url.includes('/remote/ui-enabled') && (c.init?.method === 'POST' || c.init?.method === 'PUT'))
    expect(post).toBeTruthy()
    expect(String(post!.init?.body)).toContain('true')

    await toggle.setValue(false)
    await flushPromises()
    const offs = calls.filter((c) => c.url.includes('/remote/ui-enabled'))
    expect(offs.length).toBeGreaterThanOrEqual(2)
    expect(String(offs[offs.length - 1].init?.body)).toContain('false')
    wrapper.unmount()
  })

  it('ui-code → QR + cuenta atrás + revocar', async () => {
    const { fn, calls } = makeFetch({ uiEnabled: true })
    vi.stubGlobal('fetch', fn)
    const wrapper = mount(RemotePane)
    await flushPromises()

    await wrapper.find('[data-cy="remote-ui-toggle"]').setValue(true)
    await flushPromises()
    await wrapper.find('[data-cy="remote-ui-open"]').trigger('click')
    await flushPromises()

    const img = wrapper.find('[data-cy="remote-ui-qr-img"]')
    expect(img.exists()).toBe(true)
    expect(String(img.attributes('src'))).toMatch(/^data:image\/png;base64,QR:/)
    expect(wrapper.find('[data-cy="remote-ui-url"]').text()).toContain('https://relay.example/ui')
    const exp = wrapper.find('[data-cy="remote-ui-exp"]')
    expect(exp.exists()).toBe(true)
    expect(exp.text()).toContain('bd.remoteUiExp')

    expect(calls.some((c) => c.url.includes('/remote/ui-code') && c.init?.method === 'POST')).toBe(true)

    await wrapper.find('[data-cy="remote-ui-revoke-code"]').trigger('click')
    await flushPromises()
    expect(calls.some((c) => c.url.includes('/remote/ui-code') && c.init?.method === 'DELETE')).toBe(true)
    expect(wrapper.find('[data-cy="remote-ui-qr"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('404 → aviso de actualizar daemon y sección deshabilitada', async () => {
    const { fn } = makeFetch({ ui404: true })
    vi.stubGlobal('fetch', fn)
    const wrapper = mount(RemotePane)
    await flushPromises()

    await wrapper.find('[data-cy="remote-ui-toggle"]').setValue(true)
    await flushPromises()
    expect(wrapper.find('[data-cy="remote-ui-update"]').exists()).toBe(true)
    expect(wrapper.find('[data-cy="remote-ui-open"]').exists()).toBe(false)

    // También al pedir código directamente con daemon antiguo.
    const { fn: fn2 } = makeFetch({ ui404: true, uiEnabled: true })
    vi.stubGlobal('fetch', fn2)
    const w2 = mount(RemotePane)
    await flushPromises()
    await w2.find('[data-cy="remote-ui-toggle"]').setValue(true)
    await flushPromises()
    expect(w2.find('[data-cy="remote-ui-update"]').exists()).toBe(true)
    w2.unmount()
    wrapper.unmount()
  })

  it('pending → allow muestra el token UNA vez con copiar', async () => {
    const { fn } = makeFetch({
      uiEnabled: true,
      pending: [{ reqId: 'req-1', urlCode: 'abc123', ua: 'Mobile', ip: '1.2.3.4', createdAt: Date.now() }],
    })
    vi.stubGlobal('fetch', fn)
    const wrapper = mount(RemotePane)
    await flushPromises()
    await wrapper.find('[data-cy="remote-ui-toggle"]').setValue(true)
    await flushPromises()

    expect(wrapper.find('[data-cy="remote-ui-pending-list"]').exists()).toBe(true)
    expect(wrapper.findAll('[data-cy="remote-ui-pending-item"]').length).toBe(1)

    await wrapper.find('[data-cy="remote-ui-allow"]').trigger('click')
    await flushPromises()
    const tokenBox = wrapper.find('[data-cy="remote-ui-token-once"]')
    expect(tokenBox.exists()).toBe(true)
    expect(tokenBox.text()).toContain('SECRET-TOKEN-123')
    expect(wrapper.find('[data-cy="remote-ui-token-copy"]').exists()).toBe(true)

    // Descartar: el token no se vuelve a mostrar (nunca renderizar el completo salvo creación).
    await wrapper.find('[data-cy="remote-ui-token-ok"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-cy="remote-ui-token-once"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('SECRET-TOKEN-123')
    wrapper.unmount()
  })

  it('deny elimina el pendiente', async () => {
    const { fn } = makeFetch({
      uiEnabled: true,
      pending: [{ reqId: 'req-9', urlCode: 'zzz999', ua: 'Mobile', ip: '5.6.7.8', createdAt: Date.now() }],
    })
    vi.stubGlobal('fetch', fn)
    const wrapper = mount(RemotePane)
    await flushPromises()
    await wrapper.find('[data-cy="remote-ui-toggle"]').setValue(true)
    await flushPromises()
    expect(wrapper.findAll('[data-cy="remote-ui-pending-item"]').length).toBe(1)

    await wrapper.find('[data-cy="remote-ui-deny"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-cy="remote-ui-pending-empty"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('sessions → revoke por fila', async () => {
    const { fn, calls } = makeFetch({
      uiEnabled: true,
      sessions: [
        { tokenPrefix: 'tokpref1', createdAt: Date.now() - 1000, exp: Date.now() + 3600000, ua: 'Mobile', ip: '9.9.9.9', revoked: false },
      ],
    })
    vi.stubGlobal('fetch', fn)
    const wrapper = mount(RemotePane)
    await flushPromises()
    await wrapper.find('[data-cy="remote-ui-toggle"]').setValue(true)
    await flushPromises()

    expect(wrapper.find('[data-cy="remote-ui-sessions"]').exists()).toBe(true)
    expect(wrapper.findAll('[data-cy="remote-ui-session-item"]').length).toBe(1)
    await wrapper.find('[data-cy="remote-ui-session-revoke"]').trigger('click')
    await flushPromises()
    expect(calls.some((c) => c.url.includes('/remote/ui-sessions/tokpref1') && c.init?.method === 'DELETE')).toBe(true)
    wrapper.unmount()
  })

  it('revocar código con pendientes pide confirmación', async () => {
    const { fn, calls } = makeFetch({
      uiEnabled: true,
      pending: [{ reqId: 'req-2', urlCode: 'abc123', ua: 'Mobile', ip: '1.1.1.1', createdAt: Date.now() }],
    })
    vi.stubGlobal('fetch', fn)
    const confirmSpy = vi.fn(() => false)
    vi.stubGlobal('confirm', confirmSpy)
    Object.defineProperty(window, 'confirm', { value: confirmSpy, configurable: true })
    const wrapper = mount(RemotePane)
    await flushPromises()
    await wrapper.find('[data-cy="remote-ui-toggle"]').setValue(true)
    await flushPromises()
    await wrapper.find('[data-cy="remote-ui-open"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-cy="remote-ui-qr"]').exists()).toBe(true)

    await wrapper.find('[data-cy="remote-ui-revoke-code"]').trigger('click')
    await flushPromises()
    expect(confirmSpy).toHaveBeenCalled()
    // Cancelado: no se llama a DELETE y el código sigue visible.
    expect(calls.some((c) => c.url.includes('/remote/ui-code') && c.init?.method === 'DELETE')).toBe(false)
    expect(wrapper.find('[data-cy="remote-ui-qr"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('polls cada 5s y cleanup al desmontar cancela intervalos', async () => {
    vi.useFakeTimers()
    const setSpy = vi.spyOn(window, 'setInterval')
    const clearSpy = vi.spyOn(window, 'clearInterval')
    const { fn } = makeFetch({
      uiEnabled: true,
      pending: [],
      sessions: [],
    })
    vi.stubGlobal('fetch', fn)
    const wrapper = mount(RemotePane)
    await flushPromises()

    await wrapper.find('[data-cy="remote-ui-toggle"]').setValue(true)
    await flushPromises()
    expect(setSpy).toHaveBeenCalled()
    const callsBefore = fn.mock.calls.length

    await vi.advanceTimersByTimeAsync(5100)
    await flushPromises()
    expect(fn.mock.calls.length).toBeGreaterThan(callsBefore)

    wrapper.unmount()
    expect(clearSpy).toHaveBeenCalled()
    setSpy.mockRestore()
    clearSpy.mockRestore()
  })
})
