import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'

// Fast-path LAN fallido: `?invite=` usado/caducado + `?relayFallback=<urlCode>`.
// La página "Sin permiso" debe mostrar la vía de escape al relay (código +
// copiar) y JAMÁS redirigir sola (anti-bucle LAN↔relay).

const fetchPayload = (url: string) => {
  const u = String(url)
  if (u.endsWith('/config')) return { apiPort: 3001, wsPort: 3003, frontendPort: 3002 }
  if (u.includes('/profiles/') && u.includes('/assignments')) return { assignments: {} }
  if (u.includes('/profiles')) return []
  if (u.includes('/pages')) return []
  if (u.includes('/devices/streamdeck/status')) return { isConnected: false }
  if (u.includes('/devices')) return []
  if (u.includes('/plugins/actions')) return []
  if (/\/plugins(\?|$)/.test(u)) return { detailed: [] }
  if (u.includes('/marketplace')) return { plugins: [] }
  if (u.includes('/mcp/tokens')) return { tokens: [] }
  if (u.includes('/mcp/scopes')) return { scopes: [] }
  if (u.includes('/sessions')) return []
  if (u.includes('/settings')) return {}
  if (u.includes('/version')) return { version: '0.0.0-test' }
  if (u.includes('/remote/status')) return { deviceId: 'd', relay: { url: '', status: 'disabled' }, pending: 0, trusted: 0, policy: [] }
  if (u.includes('/remote/devices')) return { devices: [] }
  return {}
}

const DENY_BODY = JSON.stringify({ error: 'Sin permiso: entra con el QR', code: 'LAN_INVITE_REQUIRED' })

function stubNet() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const u = String(url)
      // Canje + sonda: invitación usada/caducada → 401 con código LAN.
      if (u.includes('/remote/lan-redeem') || u.includes('/profiles')) {
        return {
          ok: false,
          status: 401,
          json: async () => ({ code: 'LAN_INVITE_REQUIRED' }),
          text: async () => DENY_BODY,
        } as any
      }
      return {
        ok: true,
        status: 200,
        json: async () => fetchPayload(u),
        text: async () => '',
      } as any
    }),
  )
  vi.stubGlobal('WebSocket', class {
    onopen: ((...args: any[]) => void) | null = null
    onclose: ((...args: any[]) => void) | null = null
    onmessage: ((...args: any[]) => void) | null = null
    send() {}
    close() {}
  })
  if (typeof (HTMLDialogElement.prototype as any).showModal !== 'function') {
    ;(HTMLDialogElement.prototype as any).showModal = function (this: any) {
      this.setAttribute('open', '')
    }
  }
  if (typeof (HTMLDialogElement.prototype as any).close !== 'function') {
    ;(HTMLDialogElement.prototype as any).close = function (this: any) {
      this.removeAttribute('open')
    }
  }
}

describe('LAN con invite caducado + relayFallback: escape sin bucle', () => {
  let origUrl: string

  beforeEach(() => {
    origUrl = window.location.href
    localStorage.clear()
    vi.useFakeTimers()
    stubNet()
    try {
      HTMLMediaElement.prototype.play = (async () => {}) as never
      HTMLMediaElement.prototype.pause = (() => {}) as never
    } catch {
      /* noop */
    }
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
    window.history.replaceState(null, '', origUrl)
  })

  const settle = async () => {
    for (let i = 0; i < 4; i++) {
      await flushPromises()
      await nextTick()
    }
  }

  it('muestra el código de escape y no redirige sola', async () => {
    // Espías de redirect: si jsdom no los deja espiar, la estabilidad del
    // href (assert de abajo) es la prueba principal de no-redirect.
    let replaceSpy: ReturnType<typeof vi.spyOn> | null = null
    let assignSpy: ReturnType<typeof vi.spyOn> | null = null
    try {
      replaceSpy = vi.spyOn(window.location, 'replace').mockImplementation((() => {}) as any)
    } catch {
      replaceSpy = null
    }
    try {
      assignSpy = vi.spyOn(window.location, 'assign').mockImplementation((() => {}) as any)
    } catch {
      assignSpy = null
    }
    window.history.replaceState(null, '', '/?invite=bad&relayFallback=AbC123xYz')
    const { default: BunDeckApp } = await import('../components/bundeck/BunDeckApp.vue')
    const wrapper = mount(BunDeckApp)
    await settle()

    expect(wrapper.find('[data-cy="lan-denied"]').exists()).toBe(true)
    expect(wrapper.find('[data-cy="lan-relay-fallback"]').exists()).toBe(true)
    expect(wrapper.find('[data-cy="lan-relay-fallback-code"]').text()).toBe('AbC123xYz')
    // Sin redirect automático a ninguna parte…
    if (replaceSpy) expect(replaceSpy).not.toHaveBeenCalled()
    if (assignSpy) expect(assignSpy).not.toHaveBeenCalled()
    // …y el escape sobrevive en la URL (el invite de un solo uso sí se limpia).
    expect(window.location.href).toContain('relayFallback=AbC123xYz')
    expect(window.location.href).not.toContain('invite=bad')

    wrapper.unmount()
  })

  it('el botón copia el código del relay', async () => {
    const writeText = vi.fn(async (_s: string) => {})
    vi.stubGlobal('navigator', { userAgent: window.navigator.userAgent, clipboard: { writeText } })
    window.history.replaceState(null, '', '/?invite=bad&relayFallback=AbC123xYz')
    const { default: BunDeckApp } = await import('../components/bundeck/BunDeckApp.vue')
    const wrapper = mount(BunDeckApp)
    await settle()

    const btn = wrapper.find('[data-cy="lan-relay-fallback-copy"]')
    expect(btn.exists()).toBe(true)
    await btn.trigger('click')
    await nextTick()
    expect(writeText).toHaveBeenCalledWith('AbC123xYz')
    expect(btn.text()).toBe('Código copiado')

    wrapper.unmount()
  })

  it('sin relayFallback no hay bloque de escape (página clásica)', async () => {
    window.history.replaceState(null, '', '/?invite=bad')
    const { default: BunDeckApp } = await import('../components/bundeck/BunDeckApp.vue')
    const wrapper = mount(BunDeckApp)
    await settle()

    expect(wrapper.find('[data-cy="lan-denied"]').exists()).toBe(true)
    expect(wrapper.find('[data-cy="lan-relay-fallback"]').exists()).toBe(false)

    wrapper.unmount()
  })
})
