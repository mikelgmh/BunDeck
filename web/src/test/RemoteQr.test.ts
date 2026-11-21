import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import {
  isMobileLike,
  isValidFingerprint,
  parseRemoteQr,
} from '../composables/useRemote'
import RemotePane from '../components/bundeck/RemotePane.vue'
import RemoteQrScan from '../components/bundeck/RemoteQrScan.vue'

vi.mock('qrcode', () => ({
  default: {
    toDataURL: async (text: string) => `data:image/png;base64,QR:${String(text).length}`,
  },
}))

vi.mock('../composables/useI18n', () => ({
  useI18nStore: () => ({
    t: (key: string) => key,
    currentLocale: { value: 'es' },
    setLocale: () => {},
    loadSavedLocale: () => {},
  }),
}))

const FP = 'ab12:34cd:56ef:78ab:90cd:12ef:34ab:56cd'

const makeQr = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    v: 1,
    relay: 'wss://relay.example',
    code: '482913',
    dev: 'dev-remote-1',
    pub: 'cHViLWtleS1yZW1vdGU=',
    fp: FP,
    exp: Date.now() + 600000,
    ...over,
  })

const statusOk = {
  deviceId: 'dev-local-12345678',
  fingerprint: FP,
  publicKey: 'cHViLWtleQ==',
  relay: { url: '', status: 'disabled' },
  pending: 0,
  trusted: 0,
  policy: ['page.select', 'button.press'],
}

function mockFetch(opts: { qr404?: boolean } = {}) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url)
    calls.push({ url: u, init })
    const method = init?.method ?? 'GET'
    if (u.endsWith('/config')) return { ok: true, status: 200, json: async () => ({ apiPort: 3001, wsPort: 3003 }) }
    if (u.includes('/remote/qr') && opts.qr404) return { ok: false, status: 404, json: async () => ({}) }
    if (u.includes('/remote/qr')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          code: '482913',
          fingerprint: FP,
          deviceId: 'dev-local-12345678',
          publicKey: 'cHViLWtleQ==',
          expiresAt: Date.now() + 600000,
          relayUrl: '',
          qr: makeQr(),
        }),
      }
    }
    if (u.includes('/remote/status')) return { ok: true, status: 200, json: async () => statusOk }
    if (u.includes('/remote/devices') && method === 'GET') return { ok: true, status: 200, json: async () => ({ devices: [] }) }
    if (u.includes('/remote/pair-accept')) return { ok: true, status: 200, json: async () => ({ ok: true }) }
    return { ok: true, status: 200, json: async () => ({ ok: true }) }
  })
  return { fn, calls }
}

function stubNoCamera() {
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

describe('isMobileLike', () => {
  it('detecta UA móvil (iPhone, Android, iPad)', () => {
    expect(
      isMobileLike({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15' })
    ).toBe(true)
    expect(
      isMobileLike({ userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36' })
    ).toBe(true)
    expect(
      isMobileLike({ userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15' })
    ).toBe(true)
  })

  it('desktop sin táctil no es móvil', () => {
    expect(
      isMobileLike({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
        coarsePointer: false,
        touchPoints: 0,
      })
    ).toBe(false)
  })

  it('puntero grueso + táctil cuenta como móvil (iPad en modo escritorio)', () => {
    expect(
      isMobileLike({
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15',
        coarsePointer: true,
        touchPoints: 5,
      })
    ).toBe(true)
  })

  it('puntero grueso sin táctil no basta', () => {
    expect(
      isMobileLike({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        coarsePointer: true,
        touchPoints: 0,
      })
    ).toBe(false)
  })
})

describe('parseRemoteQr', () => {
  it('payload válido', () => {
    const r = parseRemoteQr(makeQr())
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.payload.code).toBe('482913')
      expect(r.payload.dev).toBe('dev-remote-1')
      expect(r.payload.fp).toBe(FP)
      expect(r.payload.relay).toBe('wss://relay.example')
    }
  })

  it('expirado → expired', () => {
    expect(parseRemoteQr(makeQr({ exp: Date.now() - 1000 }))).toEqual({ ok: false, error: 'expired' })
  })

  it('malformado → malformed', () => {
    expect(parseRemoteQr('esto no es json')).toEqual({ ok: false, error: 'malformed' })
    expect(parseRemoteQr('[1,2,3]')).toEqual({ ok: false, error: 'malformed' })
    expect(parseRemoteQr('')).toEqual({ ok: false, error: 'malformed' })
  })

  it('versión distinta → version', () => {
    expect(parseRemoteQr(makeQr({ v: 2 }))).toEqual({ ok: false, error: 'version' })
    expect(parseRemoteQr(JSON.stringify({ foo: 1 }))).toEqual({ ok: false, error: 'version' })
  })

  it('campos ausentes → fields', () => {
    const o = JSON.parse(makeQr())
    delete o.pub
    expect(parseRemoteQr(JSON.stringify(o))).toEqual({ ok: false, error: 'fields' })
    expect(parseRemoteQr(makeQr({ code: '123' }))).toEqual({ ok: false, error: 'fields' })
    expect(parseRemoteQr(makeQr({ exp: 'mañana' }))).toEqual({ ok: false, error: 'fields' })
  })

  it('huella con mal formato → fingerprint', () => {
    expect(parseRemoteQr(makeQr({ fp: 'zz' }))).toEqual({ ok: false, error: 'fingerprint' })
    expect(parseRemoteQr(makeQr({ fp: 'ab12' }))).toEqual({ ok: false, error: 'fingerprint' })
    expect(isValidFingerprint(FP)).toBe(true)
    expect(isValidFingerprint('AB12:34CD:56EF:78AB:90CD:12EF:34AB:56CD')).toBe(true)
    expect(isValidFingerprint('nope')).toBe(false)
  })
})

describe('RemotePane QR host', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    stubNoCamera()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('mostrar QR pinta data-URL + cuenta atrás + regenerar', async () => {
    const { fn, calls } = mockFetch()
    vi.stubGlobal('fetch', fn)
    const wrapper = mount(RemotePane)
    await flushPromises()

    expect(wrapper.find('[data-cy="remote-qr-show"]').exists()).toBe(true)
    await wrapper.find('[data-cy="remote-qr-show"]').trigger('click')
    await flushPromises()

    const img = wrapper.find('[data-cy="remote-qr-img"]')
    expect(img.exists()).toBe(true)
    expect(String(img.attributes('src'))).toMatch(/^data:image\/png;base64,QR:/)
    expect(wrapper.find('[data-cy="remote-qr-exp"]').exists()).toBe(true)
    expect(wrapper.find('[data-cy="remote-scan-btn"]').exists()).toBe(true)

    await wrapper.find('[data-cy="remote-qr-regen"]').trigger('click')
    await flushPromises()
    expect(calls.filter((c) => c.url.includes('/remote/qr')).length).toBe(2)
    wrapper.unmount()
  })

  it('404 en /qr → aviso de actualizar daemon y sin sección QR', async () => {
    const { fn } = mockFetch({ qr404: true })
    vi.stubGlobal('fetch', fn)
    const wrapper = mount(RemotePane)
    await flushPromises()
    await wrapper.find('[data-cy="remote-qr-show"]').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('bd.remoteQrUpdate')
    expect(wrapper.find('[data-cy="remote-qr-img"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('flujo scan→pair-accept con fetch mockeado (pegado manual)', async () => {
    const { fn, calls } = mockFetch()
    vi.stubGlobal('fetch', fn)
    const wrapper = mount(RemotePane)
    await flushPromises()

    await wrapper.find('[data-cy="remote-scan-btn"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-cy="remote-scan-video"]').exists()).toBe(true)
    const paste = wrapper.find('[data-cy="remote-scan-paste"]')
    expect(paste.exists()).toBe(true)

    await paste.setValue(makeQr())
    await wrapper.find('[data-cy="remote-scan-validate"]').trigger('click')
    await flushPromises()

    // El escáner se cierra al decodificar y aparece el resumen.
    expect(wrapper.find('[data-cy="remote-scan-video"]').exists()).toBe(false)
    const summary = wrapper.find('[data-cy="remote-scan-summary"]')
    expect(summary.exists()).toBe(true)
    expect(summary.text()).toContain('dev-remo')
    expect(summary.text()).toContain(FP.slice(0, 9))
    // El relay local está vacío y el QR trae uno → aviso sin bloquear.
    expect(summary.text()).toContain('bd.remoteRelayMismatch')

    await wrapper.find('[data-cy="remote-scan-confirm"]').trigger('click')
    await flushPromises()
    const accept = calls.find((c) => c.url.includes('/remote/pair-accept'))
    expect(accept).toBeTruthy()
    const body = JSON.parse(String((accept!.init as RequestInit)?.body ?? '{}'))
    expect(body).toMatchObject({ code: '482913', remoteDeviceId: 'dev-remote-1', remotePubKey: 'cHViLWtleS1yZW1vdGU=' })
    // Tras confirmar, el resumen se limpia.
    expect(wrapper.find('[data-cy="remote-scan-summary"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('QR caducado pegado → error de caducidad sin resumen', async () => {
    const { fn } = mockFetch()
    vi.stubGlobal('fetch', fn)
    const wrapper = mount(RemotePane)
    await flushPromises()
    await wrapper.find('[data-cy="remote-scan-btn"]').trigger('click')
    await flushPromises()
    await wrapper.find('[data-cy="remote-scan-paste"]').setValue(makeQr({ exp: Date.now() - 5000 }))
    await wrapper.find('[data-cy="remote-scan-validate"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-cy="remote-scan-summary"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('bd.remoteQrExpiredErr')
    wrapper.unmount()
  })
})

describe('RemoteQrScan cámara', () => {
  const realMediaDevices = (navigator as Navigator & { mediaDevices?: unknown }).mediaDevices

  beforeEach(() => {
    vi.unstubAllGlobals()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    try {
      if (typeof realMediaDevices !== 'undefined') {
        Object.defineProperty(window.navigator, 'mediaDevices', { value: realMediaDevices, configurable: true })
      } else {
        // jsdom no define mediaDevices por defecto: lo dejamos como estaba.
        const nav = window.navigator as Record<string, unknown>
        delete nav.mediaDevices
      }
    } catch {
      /* noop */
    }
  })

  it('cancelar libera los tracks del stream', async () => {
    const stop = vi.fn()
    const fakeStream = { getTracks: () => [{ stop, kind: 'video' }] }
    Object.defineProperty(window.navigator, 'mediaDevices', {
      value: { getUserMedia: vi.fn(async () => fakeStream) },
      configurable: true,
    })
    const wrapper = mount(RemoteQrScan)
    await flushPromises()
    expect(wrapper.find('[data-cy="remote-scan-video"]').exists()).toBe(true)
    await wrapper.find('[data-cy="remote-scan-cancel"]').trigger('click')
    expect(stop).toHaveBeenCalled()
    wrapper.unmount()
  })

  it('desmontar libera los tracks del stream', async () => {
    const stop = vi.fn()
    const fakeStream = { getTracks: () => [{ stop, kind: 'video' }] }
    Object.defineProperty(window.navigator, 'mediaDevices', {
      value: { getUserMedia: vi.fn(async () => fakeStream) },
      configurable: true,
    })
    const wrapper = mount(RemoteQrScan)
    await flushPromises()
    wrapper.unmount()
    expect(stop).toHaveBeenCalled()
  })

  it('sin cámara: mensaje claro + pegado manual disponible', async () => {
    const nav = window.navigator as Record<string, unknown>
    delete nav.mediaDevices
    const wrapper = mount(RemoteQrScan)
    await flushPromises()
    expect(wrapper.text()).toContain('bd.remoteScanNoCam')
    expect(wrapper.find('[data-cy="remote-scan-paste"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('BarcodeDetector nativo que detecta → emite decoded', async () => {
    const stop = vi.fn()
    const fakeStream = { getTracks: () => [{ stop, kind: 'video' }] }
    Object.defineProperty(window.navigator, 'mediaDevices', {
      value: { getUserMedia: vi.fn(async () => fakeStream) },
      configurable: true,
    })
    const payload = makeQr()
    vi.stubGlobal(
      'BarcodeDetector',
      class {
        static async getSupportedFormats() {
          return ['qr_code']
        }
        async detect() {
          return [{ rawValue: payload }]
        }
      }
    )
    const wrapper = mount(RemoteQrScan)
    await flushPromises()
    await new Promise((r) => setTimeout(r, 600))
    await flushPromises()
    expect(wrapper.emitted('decoded')).toBeTruthy()
    expect(wrapper.emitted('decoded')![0]).toEqual([payload])
    // Al decodificar se liberan los tracks.
    expect(stop).toHaveBeenCalled()
    wrapper.unmount()
  })
})
