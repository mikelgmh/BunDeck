import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import {
  parseKioskMode,
  parseKioskFromLocation,
  withKioskParam,
  withoutKioskParam,
  isTripleTap,
  guardModeChange,
  marqueeOverflows,
  requestFullscreen,
} from '../composables/useKiosk'
import StageBoard from '../components/bundeck/StageBoard.vue'

vi.mock('../composables/useI18n', () => ({
  useI18nStore: () => ({
    t: (key: string) => key,
    currentLocale: { value: 'es' },
    setLocale: () => {},
    loadSavedLocale: () => {},
  }),
}))

vi.mock('../composables/useKeyShare', () => ({
  assetUrl: () => '',
  isAssetRef: () => false,
}))

describe('useKiosk: parseo del param', () => {
  it('acepta ?kiosk=1/true/yes/on', () => {
    expect(parseKioskMode('?kiosk=1')).toBe(true)
    expect(parseKioskMode('?kiosk=true')).toBe(true)
    expect(parseKioskMode('?kiosk=YES')).toBe(true)
    expect(parseKioskMode('?a=b&kiosk=on')).toBe(true)
  })

  it('acepta ?mode=kiosk y #kiosk', () => {
    expect(parseKioskMode('?mode=kiosk')).toBe(true)
    expect(parseKioskMode('', '#kiosk')).toBe(true)
    expect(parseKioskMode('', '#kiosk=1')).toBe(true)
  })

  it('rechaza ausente, kiosk=0/false y mode=edit/use', () => {
    expect(parseKioskMode('')).toBe(false)
    expect(parseKioskMode('?kiosk=0')).toBe(false)
    expect(parseKioskMode('?kiosk=false')).toBe(false)
    expect(parseKioskMode('?mode=use')).toBe(false)
    expect(parseKioskMode('?mode=edit')).toBe(false)
  })

  it('parseKioskFromLocation lee window.location', () => {
    expect(parseKioskFromLocation({ search: '?kiosk=1', hash: '' })).toBe(true)
    expect(parseKioskFromLocation({ search: '', hash: '#kiosk' })).toBe(true)
    expect(parseKioskFromLocation({ search: '', hash: '' })).toBe(false)
  })
})

describe('useKiosk: propagación en URLs', () => {
  it('withKioskParam añade ?kiosk=1 y es idempotente', () => {
    expect(withKioskParam('http://192.168.1.2:4321')).toBe('http://192.168.1.2:4321/?kiosk=1')
    expect(withKioskParam('https://relay.example/ui/abc123')).toBe('https://relay.example/ui/abc123?kiosk=1')
    expect(withKioskParam('https://relay.example/ui/abc123?kiosk=1')).toBe('https://relay.example/ui/abc123?kiosk=1')
    expect(withKioskParam('/t/token/?kiosk=1')).toBe('/t/token/?kiosk=1')
  })

  it('withKioskParam preserva query y hash existentes', () => {
    expect(withKioskParam('http://x/?a=b#kiosk')).toBe('http://x/?a=b#kiosk')
    const out = withKioskParam('http://x/page?a=b')
    expect(out).toContain('a=b')
    expect(out).toContain('kiosk=1')
  })

  it('withoutKioskParam limpia el param al salir', () => {
    expect(withoutKioskParam('http://x/?kiosk=1')).toBe('http://x/')
    expect(withoutKioskParam('http://x/?a=b&kiosk=1')).toBe('http://x/?a=b')
    expect(withoutKioskParam('http://x/?mode=kiosk')).toBe('http://x/')
    expect(withoutKioskParam('http://x/?a=b')).toBe('http://x/?a=b')
  })
})

describe('useKiosk: marquee de la barra', () => {
  it('estático si el texto cabe (incluida tolerancia subpíxel)', () => {
    expect(marqueeOverflows(100, 200)).toBe(false)
    expect(marqueeOverflows(200, 200)).toBe(false)
    expect(marqueeOverflows(201, 200)).toBe(false)
  })

  it('anima solo con overflow real del texto', () => {
    expect(marqueeOverflows(202, 200)).toBe(true)
    expect(marqueeOverflows(500, 320)).toBe(true)
  })

  it('el padding de separación entre copias no cuenta: se mide el span', () => {
    // Texto de 270px en caja de 300px cabe → estático, aunque el grupo
    // (texto + padding-right 48px = 318px) sea más ancho que la caja.
    expect(marqueeOverflows(270, 300)).toBe(false)
    expect(marqueeOverflows(318, 300)).toBe(true)
  })

  it('medidas no finitas nunca animan', () => {
    expect(marqueeOverflows(NaN, 300)).toBe(false)
    expect(marqueeOverflows(400, NaN)).toBe(false)
    expect(marqueeOverflows(0, 0)).toBe(false)
  })
})

describe('useKiosk: gestos y guardas', () => {
  it('isTripleTap: 3 taps en 600ms', () => {
    expect(isTripleTap([1000, 1200, 1400], 1500)).toBe(true)
    expect(isTripleTap([1000, 1200], 1500)).toBe(false)
    expect(isTripleTap([0, 500, 2000], 2100)).toBe(false)
  })

  it('guardModeChange veta edit en kiosco', () => {
    expect(guardModeChange(true, 'edit')).toBe('use')
    expect(guardModeChange(true, 'use')).toBe('use')
    expect(guardModeChange(false, 'edit')).toBe('edit')
  })

  it('requestFullscreen no lanza sin Fullscreen API', async () => {
    await expect(requestFullscreen()).resolves.toBe(false)
  })
})

const gridPage = { id: 'g1', profile_id: 'p', name: 'Inicio', order_idx: 0, is_folder: 0, data: {} }

const baseProps = {
  gridCols: 5,
  gridRows: 3,
  selectedButton: null,
  executingButtons: [],
  buttonConfig: {},
  getButton: () => undefined,
  allButtons: [],
  getButtonData: () => null,
  mode: 'use',
  labelMode: 'a',
  currentPages: [gridPage],
  currentPage: gridPage,
  navTrail: [],
  profileName: 'Principal',
  busy: false,
} as any

describe('StageBoard en kiosco', () => {
  it('solo grid: sin toolbar, sin páginas, con marca bd-kiosk-grid', () => {
    const wrapper = mount(StageBoard, { props: { ...baseProps, kiosk: true } })
    expect(wrapper.find('[data-cy="bd-kiosk-grid"]').exists()).toBe(true)
    expect(wrapper.find('.bd-tool').exists()).toBe(false)
    expect(wrapper.find('.bd-pages').exists()).toBe(false)
    // El grid de teclas sigue ahí.
    expect(wrapper.findAll('[data-cy="bd-key"]').length).toBe(15)
    // Sin "+" de tecla vacía en kiosco.
    expect(wrapper.text()).not.toContain('+')
    wrapper.unmount()
  })

  it('sin kiosco se ve todo como antes', () => {
    const wrapper = mount(StageBoard, { props: { ...baseProps } })
    expect(wrapper.find('[data-cy="bd-kiosk-grid"]').exists()).toBe(false)
    expect(wrapper.find('.bd-tool').exists()).toBe(true)
    expect(wrapper.find('.bd-pages').exists()).toBe(true)
    wrapper.unmount()
  })

  it('el menú contextual no se abre en kiosco', async () => {
    const withBtn = {
      ...baseProps,
      kiosk: true,
      getButton: () => ({ id: 'b1', data: { label: 'X', actions: [] } }),
      getButtonData: () => ({ label: 'X', actions: [] }),
    }
    const wrapper = mount(StageBoard, { props: withBtn })
    const key = wrapper.findAll('[data-cy="bd-key"]')[0]
    await key.trigger('contextmenu')
    await flushPromises()
    // Sin menú: no hay items de exportar/importar.
    expect(document.body.innerHTML).not.toContain('bd-key-export')
    expect(wrapper.findComponent({ name: 'ContextMenu' }).props('show')).toBe(false)
    wrapper.unmount()
  })
})

// --- BunDeckApp en kiosco: montaje completo con daemon simulado ---
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

describe('BunDeckApp en kiosco', () => {
  let origLocation: string

  beforeEach(() => {
    origLocation = window.location.href
    localStorage.clear()
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({
      ok: true,
      status: 200,
      json: async () => fetchPayload(url),
      text: async () => '',
    } as any)))
    // Sin Wake Lock real en jsdom: el fallback de vídeo del kiosco llama a
    // play()/pause(); se simulan para no ensuciar la salida del test.
    try {
      HTMLMediaElement.prototype.play = (async () => {}) as never
      HTMLMediaElement.prototype.pause = (() => {}) as never
    } catch {
      /* noop */
    }
    // Sin WS real en jsdom: el connectWebSocket del composable queda en noop.
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

  afterEach(() => {
    vi.unstubAllGlobals()
    window.history.replaceState(null, '', origLocation)
  })

  const gotoKiosk = (query = '?kiosk=1') => {
    window.history.replaceState(null, '', `${window.location.pathname}${query}`)
  }

  it('con ?kiosk=1: sin header/drawers/toolbar, en use y con salida', async () => {
    const { default: BunDeckApp } = await import('../components/bundeck/BunDeckApp.vue')
    gotoKiosk('?kiosk=1')
    const wrapper = mount(BunDeckApp)
    await flushPromises()
    await flushPromises()
    expect(wrapper.find('header.bd-top').exists()).toBe(false)
    expect(wrapper.find('#bd-drw').exists()).toBe(false)
    expect(wrapper.find('#bd-ins').exists()).toBe(false)
    expect(wrapper.find('.bd-tool').exists()).toBe(false)
    expect(wrapper.find('[data-cy="bd-kiosk-grid"]').exists()).toBe(true)
    expect(wrapper.find('[data-cy="bd-kiosk-exit"]').exists()).toBe(true)
    expect(wrapper.find('[data-cy="bd-kiosk-fullscreen"]').exists()).toBe(true)
    expect(wrapper.find('[data-cy="bd-kiosk-corner"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('el modo editar queda bloqueado en kiosco', async () => {
    const { default: BunDeckApp } = await import('../components/bundeck/BunDeckApp.vue')
    gotoKiosk('?mode=kiosk')
    const wrapper = mount(BunDeckApp)
    await flushPromises()
    await flushPromises()
    const stage = wrapper.findComponent(StageBoard)
    expect(stage.exists()).toBe(true)
    expect(stage.props('mode')).toBe('use')
    // Intentar pasar a editar no tiene efecto.
    await stage.vm.$emit('mode-change', 'edit')
    await flushPromises()
    expect(stage.props('mode')).toBe('use')
    expect(wrapper.find('header.bd-top').exists()).toBe(false)
    wrapper.unmount()
  })

  it('salir del kiosco: botón + confirmación limpia param y restaura UI', async () => {
    const { default: BunDeckApp } = await import('../components/bundeck/BunDeckApp.vue')
    gotoKiosk('?kiosk=1')
    const wrapper = mount(BunDeckApp)
    await flushPromises()
    await flushPromises()
    await wrapper.find('[data-cy="bd-kiosk-exit"]').trigger('click')
    await flushPromises()
    // Diálogo de confirmación visible.
    const dialogs = wrapper.findAll('dialog.bd-confirm')
    const open = dialogs.filter((d) => (d.element as HTMLDialogElement).hasAttribute('open'))
    expect(open.length).toBeGreaterThan(0)
    // Confirmar salida.
    const okBtn = open[0].find('.bd-confirm-actions .bd-pri')
    await okBtn.trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-cy="bd-kiosk-exit"]').exists()).toBe(false)
    expect(wrapper.find('[data-cy="bd-kiosk-grid"]').exists()).toBe(false)
    expect(wrapper.find('header.bd-top').exists()).toBe(true)
    expect(window.location.search).not.toContain('kiosk')
    wrapper.unmount()
  })

  it('sin param no hay kiosco', async () => {
    const { default: BunDeckApp } = await import('../components/bundeck/BunDeckApp.vue')
    gotoKiosk('')
    const wrapper = mount(BunDeckApp)
    await flushPromises()
    await flushPromises()
    expect(wrapper.find('[data-cy="bd-kiosk-exit"]').exists()).toBe(false)
    expect(wrapper.find('header.bd-top').exists()).toBe(true)
    wrapper.unmount()
  })

  it('botón de colapso siempre visible en kiosco (también desktop)', async () => {
    const { default: BunDeckApp } = await import('../components/bundeck/BunDeckApp.vue')
    gotoKiosk('?kiosk=1')
    const wrapper = mount(BunDeckApp)
    await flushPromises()
    await flushPromises()
    const toggle = wrapper.find('[data-cy="bd-kiosk-barcollapse"]')
    expect(toggle.exists()).toBe(true)
    expect(wrapper.find('#kbar.is-collapsed').exists()).toBe(false)
    expect(toggle.attributes('aria-expanded')).toBe('true')
    wrapper.unmount()
  })

  it('colapsar/expandir la barra alterna is-collapsed y aria-expanded', async () => {
    const { default: BunDeckApp } = await import('../components/bundeck/BunDeckApp.vue')
    gotoKiosk('?kiosk=1')
    const wrapper = mount(BunDeckApp)
    await flushPromises()
    await flushPromises()
    const toggle = wrapper.find('[data-cy="bd-kiosk-barcollapse"]')
    await toggle.trigger('click')
    expect(wrapper.find('#kbar.is-collapsed').exists()).toBe(true)
    expect(wrapper.find('[data-cy="bd-kiosk-barcollapse"]').attributes('aria-expanded')).toBe('false')
    await toggle.trigger('click')
    expect(wrapper.find('#kbar.is-collapsed').exists()).toBe(false)
    expect(wrapper.find('[data-cy="bd-kiosk-barcollapse"]').attributes('aria-expanded')).toBe('true')
    wrapper.unmount()
  })
})
