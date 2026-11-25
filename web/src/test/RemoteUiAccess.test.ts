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
  tunnel?: string
}

function makeFetch(opts: FetchOpts = {}) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  let enabled = opts.uiEnabled ?? false
  let pending = opts.pending ?? []
  let nextCode = 0
  const sessions = opts.sessions ?? []
  const state = { enabled, pending: [...pending], sessions: [...sessions], code: opts.uiCode ?? null as unknown }

  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url)
    const method = init?.method ?? 'GET'
    calls.push({ url: u, init })
    if (u.endsWith('/config')) return { ok: true, status: 200, json: async () => ({ apiPort: 3001, wsPort: 3003 }) }
    if (u.includes('/remote/status')) {
      return { ok: true, status: 200, json: async () => ({ ...statusBase, uiEnabled: state.enabled, ...(opts.tunnel ? { tunnel: { status: opts.tunnel } } : {}) }) }
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
        nextCode += 1
        const urlCode = `abc${String(nextCode).padStart(3, '0')}`
        state.code = {
          code: String(123450 + nextCode),
          urlCode,
          url: `https://relay.example/ui/${urlCode}`,
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

  it('muestra el estado del túnel y avisa si no hay conexión', async () => {
    const { fn } = makeFetch({ uiEnabled: true })
    vi.stubGlobal('fetch', fn)
    const wrapper = mount(RemotePane)
    await flushPromises()

    // Sin dato de túnel (daemon antiguo): se muestra '…'.
    const line = wrapper.find('[data-cy="remote-ui-tunnel"]')
    expect(line.exists()).toBe(true)
    expect(line.text()).toContain('…')
    wrapper.unmount()

    // Túnel conectado: sin aviso.
    const { fn: fn2 } = makeFetch({ uiEnabled: true, tunnel: 'connected' })
    vi.stubGlobal('fetch', fn2)
    const w2 = mount(RemotePane)
    await flushPromises()
    expect(w2.find('[data-cy="remote-ui-tunnel"]').text()).toContain('connected')
    expect(w2.find('[data-cy="remote-ui-tunnel"]').text()).not.toContain('bd.remoteUiTunnelDown')
    w2.unmount()

    // Túnel caído con UI habilitada: aviso de códigos caducados.
    const { fn: fn3 } = makeFetch({ uiEnabled: true, tunnel: 'disconnected' })
    vi.stubGlobal('fetch', fn3)
    const w3 = mount(RemotePane)
    await flushPromises()
    expect(w3.find('[data-cy="remote-ui-tunnel"]').text()).toContain('bd.remoteUiTunnelDown')
    w3.unmount()
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
    await wrapper.find('[data-cy="remote-ui-open"]').trigger('click')
    await flushPromises()
    const firstUrl = wrapper.find('[data-cy="remote-ui-url"]').text()
    const approvalDialog = wrapper.find('[data-cy="remote-ui-approval-dialog"]')
    expect(approvalDialog.exists()).toBe(true)
    expect(approvalDialog.attributes('open')).toBeDefined()

    await approvalDialog.find('[data-cy="remote-ui-approval-allow"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-cy="remote-ui-url"]').text()).not.toBe(firstUrl)
    expect(fn.mock.calls.filter(([url, init]) => String(url).includes('/remote/ui-code') && init?.method === 'POST')).toHaveLength(2)
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

  it('sessions → renombrar por fila (input + guardar)', async () => {
    const iPadUA = 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
    const { fn, calls } = makeFetch({
      uiEnabled: true,
      sessions: [
        { tokenPrefix: 'tokpref1', createdAt: Date.now() - 1000, exp: Date.now() + 3600000, ua: iPadUA, ip: '9.9.9.9', revoked: false, deviceName: 'iPad Safari' },
      ],
    })
    vi.stubGlobal('fetch', fn)
    const wrapper = mount(RemotePane)
    await flushPromises()
    await wrapper.find('[data-cy="remote-ui-toggle"]').setValue(true)
    await flushPromises()

    // Muestra el nombre guardado y al renombrar pre-rellena con él.
    expect(wrapper.find('[data-cy="remote-ui-session-device"]').text()).toContain('iPad Safari')
    await wrapper.find('[data-cy="remote-ui-session-rename"]').trigger('click')
    await flushPromises()
    const input = wrapper.find('[data-cy="remote-ui-session-name-input"]')
    expect((input.element as HTMLInputElement).value).toBe('iPad Safari')
    await input.setValue('iPad Salón')
    await wrapper.find('[data-cy="remote-ui-session-name-save"]').trigger('click')
    await flushPromises()
    const posted = calls.find((c) => c.url.includes('/remote/ui-sessions/tokpref1/device-name') && c.init?.method === 'POST')
    expect(posted).toBeTruthy()
    expect(String(posted!.init?.body)).toContain('iPad Salón')
    wrapper.unmount()
  })

  it('sessions → renombrar sugiere modelo + navegador si no hay nombre', async () => {
    const iPhoneUA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
    const { fn } = makeFetch({
      uiEnabled: true,
      sessions: [
        { tokenPrefix: 'tokpref2', createdAt: Date.now() - 1000, exp: Date.now() + 3600000, ua: iPhoneUA, ip: '9.9.9.9', revoked: false },
      ],
    })
    vi.stubGlobal('fetch', fn)
    const wrapper = mount(RemotePane)
    await flushPromises()
    await wrapper.find('[data-cy="remote-ui-toggle"]').setValue(true)
    await flushPromises()
    await wrapper.find('[data-cy="remote-ui-session-rename"]').trigger('click')
    await flushPromises()
    expect((wrapper.find('[data-cy="remote-ui-session-name-input"]').element as HTMLInputElement).value).toBe('iPhone Safari')
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

  describe('aprobación con transporte en vivo', () => {
    const wsInstances: Array<{ onmessage: ((e: unknown) => void) | null }> = []

    beforeEach(() => {
      wsInstances.length = 0
      vi.stubGlobal(
        'WebSocket',
        class {
          static OPEN = 1
          readyState = 1
          onopen: ((e?: unknown) => void) | null = null
          onmessage: ((e: unknown) => void) | null = null
          onclose: ((e?: unknown) => void) | null = null
          onerror: ((e?: unknown) => void) | null = null
          constructor() {
            wsInstances.push(this as unknown as { onmessage: ((e: unknown) => void) | null })
          }
          send() {}
          close() {}
        }
      )
    })

    async function openApproval(ua = 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1') {
      const { fn } = makeFetch({
        uiEnabled: true,
        pending: [{ reqId: 'req-1', urlCode: 'abc123', ua, ip: '1.2.3.4', createdAt: Date.now() }],
      })
      vi.stubGlobal('fetch', fn)
      const wrapper = mount(RemotePane)
      await flushPromises()
      await wrapper.find('[data-cy="remote-ui-toggle"]').setValue(true)
      await flushPromises()
      const approvalDialog = wrapper.find('[data-cy="remote-ui-approval-dialog"]')
      expect(approvalDialog.attributes('open')).toBeDefined()
      return wrapper
    }

    it('el diálogo anuncia la política de transporte antes de aprobar', async () => {
      const wrapper = await openApproval()
      expect(wrapper.find('[data-cy="remote-ui-transport-notice"]').exists()).toBe(true)
      wrapper.unmount()
    })

    it('allow → vista de éxito con "probando P2P" y cerrar', async () => {
      const { fn, calls } = makeFetch({
        uiEnabled: true,
        pending: [{ reqId: 'req-1', urlCode: 'abc123', ua: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1', ip: '1.2.3.4', createdAt: Date.now() }],
      })
      vi.stubGlobal('fetch', fn)
      const wrapper = mount(RemotePane)
      await flushPromises()
      await wrapper.find('[data-cy="remote-ui-toggle"]').setValue(true)
      await flushPromises()
      await wrapper.find('[data-cy="remote-ui-approval-allow"]').trigger('click')
      await flushPromises()
      // Vista de éxito: muestra el navegador y el transporte conectando.
      expect(wrapper.find('[data-cy="remote-ui-approved-ua"]').text()).toContain('Mobile')
      const badge = wrapper.find('[data-cy="remote-ui-approved-transport"]')
      expect(badge.exists()).toBe(true)
      expect(badge.attributes('data-transport')).toBe('connecting')
      expect(badge.text()).toContain('bd.remoteUiApprovedConnecting')
      // Spinner de carga mientras se intenta el P2P.
      expect(badge.find('.bd-spin').exists()).toBe(true)
      // Input con el nombre sugerido (modelo + navegador que vio el relay).
      const nameInput = wrapper.find('[data-cy="remote-ui-device-name"]')
      expect(nameInput.exists()).toBe(true)
      expect((nameInput.element as HTMLInputElement).value).toBe('iPad Safari')
      // Guardar envía el nombre a la sesión y cierra.
      await nameInput.setValue('iPad Salón')
      await wrapper.find('[data-cy="remote-ui-approval-close"]').trigger('click')
      await flushPromises()
      const posted = calls.find((c) => c.url.includes('/device-name') && c.init?.method === 'POST')
      expect(posted).toBeTruthy()
      expect(String(posted!.init?.body)).toContain('iPad Salón')
      expect(wrapper.find('[data-cy="remote-ui-approved-transport"]').exists()).toBe(false)
      wrapper.unmount()
    })

    it('rtc-connected convierte la vista en P2P en vivo', async () => {
      const wrapper = await openApproval()
      await wrapper.find('[data-cy="remote-ui-approval-allow"]').trigger('click')
      await flushPromises()
      expect(wsInstances.length).toBeGreaterThan(0)
      const ws = wsInstances[wsInstances.length - 1]
      // El daemon avisa con el tipo `remote.rtc-connected` (con prefijo).
      ws.onmessage?.({
        data: JSON.stringify({ type: 'remote.rtc-connected', payload: { tokenPrefix: 'SECRET-T' } }),
      })
      await flushPromises()
      const badge = wrapper.find('[data-cy="remote-ui-approved-transport"]')
      expect(badge.attributes('data-transport')).toBe('p2p')
      expect(badge.text()).toContain('bd.remoteUiTransportP2p')
      // Conectado: ya no hay spinner.
      expect(badge.find('.bd-spin').exists()).toBe(false)
      wrapper.unmount()
    })

    it('sin P2P en 15 s → muestra Relay', async () => {
      vi.useFakeTimers()
      const wrapper = await openApproval()
      await wrapper.find('[data-cy="remote-ui-approval-allow"]').trigger('click')
      await flushPromises()
      expect(wrapper.find('[data-cy="remote-ui-approved-transport"]').attributes('data-transport')).toBe(
        'connecting'
      )
      await vi.advanceTimersByTimeAsync(16000)
      await flushPromises()
      const badge = wrapper.find('[data-cy="remote-ui-approved-transport"]')
      expect(badge.attributes('data-transport')).toBe('relay')
      expect(badge.text()).toContain('bd.remoteUiTransportRelay')
      // Fallback a relay: tampoco hay spinner.
      expect(badge.find('.bd-spin').exists()).toBe(false)
      wrapper.unmount()
    })
  })
})
