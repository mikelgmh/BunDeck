import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
import TunnelConnectDialog from '../components/bundeck/TunnelConnectDialog.vue'
import TunnelKioskDot from '../components/bundeck/TunnelKioskDot.vue'

vi.mock('../composables/useI18n', () => ({
  useI18nStore: () => ({
    t: (key: string) => key,
    currentLocale: { value: 'es' },
    setLocale: () => {},
    loadSavedLocale: () => {},
  }),
}))

describe('TunnelConnectDialog', () => {
  it('idle = Conectando, signaling = Probando P2P (spinner siempre)', () => {
    for (const [status, label] of [
      ['idle', 'bd.tunnelTransportConnecting'],
      ['signaling', 'bd.tunnelTransportProbing'],
    ] as const) {
      const wrapper = mount(TunnelConnectDialog, { props: { status } })
      expect(wrapper.find('[data-cy="tunnel-connect-dialog"]').exists()).toBe(true)
      expect(wrapper.find('[data-cy="tunnel-connect-label"]').text()).toBe(label)
      expect(wrapper.find('.bd-spin').exists()).toBe(true)
      wrapper.unmount()
    }
  })

  it('cancel (Escape) emite dismiss', async () => {
    const wrapper = mount(TunnelConnectDialog, { props: { status: 'signaling' } })
    await wrapper.find('[data-cy="tunnel-connect-dialog"]').trigger('cancel')
    expect(wrapper.emitted('dismiss')).toBeTruthy()
    wrapper.unmount()
  })
})

describe('TunnelKioskDot', () => {
  it('idle gris Conectando, signaling azul Probando, P2P verde, relay ámbar, sin-WS rojo', async () => {
    const cases = [
      { status: 'idle', wsOk: true, transport: 'connecting', title: 'bd.tunnelTransportConnecting' },
      { status: 'signaling', wsOk: true, transport: 'probing', title: 'bd.tunnelTransportProbing' },
      { status: 'connected', wsOk: true, transport: 'p2p', title: 'bd.tunnelTransportP2p' },
      { status: 'connected', wsOk: false, transport: 'p2p', title: 'bd.tunnelTransportP2p' },
      { status: 'fallback', wsOk: true, transport: 'relay', title: 'bd.tunnelTransportRelay' },
      { status: 'fallback', wsOk: false, transport: 'disconnected', title: 'bd.tunnelTransportDisconnected' },
    ] as const
    for (const c of cases) {
      const wrapper = mount(TunnelKioskDot, { props: { status: c.status, wsOk: c.wsOk } })
      const dot = wrapper.find('[data-cy="bd-kiosk-rtc"]')
      expect(dot.exists()).toBe(true)
      expect(dot.attributes('data-transport')).toBe(c.transport)
      expect(dot.attributes('title')).toBe(c.title)
      expect(dot.attributes('aria-label')).toBe(c.title)
      wrapper.unmount()
    }
  })

  it('sin wsOk (defecto) el fallback es relay', () => {
    const wrapper = mount(TunnelKioskDot, { props: { status: 'fallback' } })
    expect(wrapper.find('[data-cy="bd-kiosk-rtc"]').attributes('data-transport')).toBe('relay')
    wrapper.unmount()
  })
})

// --- Integración en BunDeckApp: modal + pilotito en kiosco por túnel ---
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

describe('BunDeckApp: modal de conexión + dot de kiosco en túnel', () => {
  let origUrl: string

  beforeEach(() => {
    origUrl = window.location.href
    localStorage.clear()
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({
      ok: true,
      status: 200,
      json: async () => fetchPayload(url),
      text: async () => '',
    } as any)))
    try {
      HTMLMediaElement.prototype.play = (async () => {}) as never
      HTMLMediaElement.prototype.pause = (() => {}) as never
    } catch {
      /* noop */
    }
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
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
    try {
      const { getRtcSingleton } = await import('../composables/useRemoteRtc')
      getRtcSingleton().disconnect()
    } catch {
      /* noop */
    }
    window.history.replaceState(null, '', origUrl)
  })

  const gotoTunnelKiosk = () => {
    const token = 'a'.repeat(32)
    window.history.replaceState(null, '', `/t/${token}/?kiosk=1`)
  }

  it('modal visible probando (banner oculto siempre en kiosco); terminal cierra modal sin banner; cierre manual no reabre', async () => {
    const { default: BunDeckApp } = await import('../components/bundeck/BunDeckApp.vue')
    const { getRtcSingleton } = await import('../composables/useRemoteRtc')
    gotoTunnelKiosk()
    const wrapper = mount(BunDeckApp)
    await flushPromises()
    await nextTick()
    const rtc = getRtcSingleton()

    // Estado inicial idle = Conectando: modal sí, banner NO (cero solape).
    expect(wrapper.find('[data-cy="tunnel-connect-dialog"]').exists()).toBe(true)
    expect(wrapper.find('[data-cy="tunnel-connect-label"]').text()).toBe('bd.tunnelTransportConnecting')
    expect(wrapper.find('[data-cy="tunnel-transport-banner"]').exists()).toBe(false)
    expect(wrapper.find('[data-cy="bd-kiosk-rtc"]').attributes('data-transport')).toBe('connecting')

    // Sigue probando en signaling: modal con texto P2P, banner sigue oculto.
    rtc.status.value = 'signaling'
    await nextTick()
    expect(wrapper.find('[data-cy="tunnel-connect-dialog"]').exists()).toBe(true)
    expect(wrapper.find('[data-cy="tunnel-connect-label"]').text()).toBe('bd.tunnelTransportProbing')
    expect(wrapper.find('[data-cy="tunnel-transport-banner"]').exists()).toBe(false)
    expect(wrapper.find('[data-cy="bd-kiosk-rtc"]').attributes('data-transport')).toBe('probing')

    // Al conectar (P2P) se cierra sola; dot en verde. En kiosco NO hay
    // banner (el estado vive en el dot de #kbar); en modo normal sí sale.
    rtc.status.value = 'connected'
    await nextTick()
    expect(wrapper.find('[data-cy="tunnel-connect-dialog"]').exists()).toBe(false)
    expect(wrapper.find('[data-cy="tunnel-transport-banner"]').exists()).toBe(false)
    expect(wrapper.find('[data-cy="bd-kiosk-rtc"]').attributes('data-transport')).toBe('p2p')

    // Al caer a relay también se cierra; sin banner en kiosco. El stub WS
    // de este test nunca abre → isConnected false → dot en Desconectado.
    rtc.status.value = 'signaling'
    await nextTick()
    expect(wrapper.find('[data-cy="tunnel-connect-dialog"]').exists()).toBe(true)
    expect(wrapper.find('[data-cy="tunnel-transport-banner"]').exists()).toBe(false)
    rtc.status.value = 'fallback'
    await nextTick()
    expect(wrapper.find('[data-cy="tunnel-connect-dialog"]').exists()).toBe(false)
    expect(wrapper.find('[data-cy="tunnel-transport-banner"]').exists()).toBe(false)
    expect(wrapper.find('[data-cy="bd-kiosk-rtc"]').attributes('data-transport')).toBe('disconnected')

    // Nuevo intento → reaparece; cancel (Escape) → no reabre sin nuevo intento,
    // y el banner sigue oculto al no ser estado terminal.
    rtc.status.value = 'signaling'
    await nextTick()
    expect(wrapper.find('[data-cy="tunnel-connect-dialog"]').exists()).toBe(true)
    await wrapper.find('[data-cy="tunnel-connect-dialog"]').trigger('cancel')
    await nextTick()
    expect(wrapper.find('[data-cy="tunnel-connect-dialog"]').exists()).toBe(false)
    expect(wrapper.find('[data-cy="tunnel-transport-banner"]').exists()).toBe(false)
    // Re-render sin cambio de intento: sigue cerrada.
    await wrapper.vm.$forceUpdate()
    await nextTick()
    expect(wrapper.find('[data-cy="tunnel-connect-dialog"]').exists()).toBe(false)

    wrapper.unmount()
  })

  it('entrada con singleton rancio (fallback) resetea a idle y muestra la modal', async () => {
    const { default: BunDeckApp } = await import('../components/bundeck/BunDeckApp.vue')
    const { getRtcSingleton } = await import('../composables/useRemoteRtc')
    const rtc = getRtcSingleton()
    // Simula un intento anterior ya resuelto (p. ej. HMR/remontaje en dev):
    // sin reset en onMounted la condición (idle/signaling) no se cumpliría
    // al entrar y la modal no saldría.
    rtc.status.value = 'fallback'
    gotoTunnelKiosk()
    const wrapper = mount(BunDeckApp)
    await flushPromises()
    await nextTick()
    expect(rtc.status.value).toBe('idle')
    expect(wrapper.find('[data-cy="tunnel-connect-dialog"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('sin túnel no hay modal, ni banner, ni dot de transporte', async () => {
    const { default: BunDeckApp } = await import('../components/bundeck/BunDeckApp.vue')
    window.history.replaceState(null, '', '/?kiosk=1')
    const wrapper = mount(BunDeckApp)
    await flushPromises()
    await nextTick()
    expect(wrapper.find('[data-cy="tunnel-connect-dialog"]').exists()).toBe(false)
    expect(wrapper.find('[data-cy="tunnel-transport-banner"]').exists()).toBe(false)
    expect(wrapper.find('[data-cy="bd-kiosk-rtc"]').exists()).toBe(false)
    // El wake-lock existente sigue intacto.
    expect(wrapper.find('[data-cy="bd-kiosk-wake"]').exists()).toBe(true)
    wrapper.unmount()
  })
})
