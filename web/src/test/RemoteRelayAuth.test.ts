import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import {
  normalizeRelayAuth,
  resolveRelayCause,
  useRemote,
} from '../composables/useRemote'
import RemotePane from '../components/bundeck/RemotePane.vue'

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

vi.mock('qrcode', () => ({
  default: { toDataURL: async (text: string) => `data:image/png;base64,QR:${String(text).length}` },
}))

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

const statusBase = {
  deviceId: 'dev-local-12345678',
  fingerprint: 'ab12:34cd:56ef:78ab:90cd:12ef:34ab:56cd',
  publicKey: 'cHViLWtleQ==',
  pending: 0,
  trusted: 0,
  policy: ['page.select', 'button.press'],
  uiEnabled: true,
}

type StatusOpts = {
  auth?: string
  deviceLinked?: boolean
  relayUrl?: string
  relayStatus?: string
  tunnel?: string | null
}

function makeStatus(opts: StatusOpts = {}) {
  const status: Record<string, unknown> = {
    ...statusBase,
    relay: {
      url: opts.relayUrl ?? 'wss://relay.example.test',
      status: opts.relayStatus ?? 'disconnected',
      ...(opts.auth !== undefined ? { auth: opts.auth } : {}),
      ...(opts.deviceLinked !== undefined ? { deviceLinked: opts.deviceLinked } : {}),
    },
  }
  if (opts.tunnel === null) {
    // Sin campo túnel (daemon antiguo).
  } else {
    status.tunnel = { status: opts.tunnel ?? 'disconnected' }
  }
  return status
}

function makeFetch(status: Record<string, unknown>) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url)
    const method = init?.method ?? 'GET'
    calls.push({ url: u, init })
    if (u.endsWith('/config')) return { ok: true, status: 200, json: async () => ({ apiPort: 3001, wsPort: 3003 }) }
    if (u.includes('/remote/status')) return { ok: true, status: 200, json: async () => status }
    if (u.includes('/remote/devices') && method === 'GET') {
      return { ok: true, status: 200, json: async () => ({ devices: [] }) }
    }
    if (u.includes('/remote/relay-unlink') && method === 'POST') {
      return { ok: true, status: 200, json: async () => ({ ok: true }) }
    }
    if (u.includes('/remote/relay-rotate') && method === 'POST') {
      return { ok: true, status: 200, json: async () => ({ ok: true }) }
    }
    if (u.includes('/remote/ui-pending')) return { ok: true, status: 200, json: async () => ({ pending: [] }) }
    if (u.includes('/remote/ui-sessions')) return { ok: true, status: 200, json: async () => ({ sessions: [] }) }
    if (u.includes('/lan-sessions')) return { ok: true, status: 200, json: async () => ({ sessions: [] }) }
    if (u.includes('/api/v1/devices')) return { ok: true, status: 200, json: async () => [] }
    return { ok: true, status: 200, json: async () => ({ ok: true }) }
  })
  return { fn, calls }
}

describe('relay auth: helpers', () => {
  it('normalizeRelayAuth acepta los 6 valores y rechaza el resto', () => {
    for (const v of ['ok', 'auth-required', 'invalid-token', 'rate-limited', 'unreachable', 'unsupported']) {
      expect(normalizeRelayAuth(v)).toBe(v)
    }
    expect(normalizeRelayAuth(undefined)).toBeUndefined()
    expect(normalizeRelayAuth(null)).toBeUndefined()
    expect(normalizeRelayAuth('')).toBeUndefined()
    expect(normalizeRelayAuth('weird')).toBeUndefined()
    expect(normalizeRelayAuth(42)).toBeUndefined()
  })

  it('resolveRelayCause mapea cada auth (el auth manda sobre el túnel)', () => {
    expect(resolveRelayCause({ auth: 'auth-required' }, 'connected', true)).toBe('auth-required')
    expect(resolveRelayCause({ auth: 'invalid-token' }, 'connected', true)).toBe('invalid-token')
    expect(resolveRelayCause({ auth: 'rate-limited' }, 'connected', true)).toBe('rate-limited')
    expect(resolveRelayCause({ auth: 'unsupported' }, 'connected', true)).toBe('unsupported')
    expect(resolveRelayCause({ auth: 'unreachable' }, 'connected', true)).toBe('unreachable')
    // auth desconocido (daemon futuro) → caída genérica, nunca null.
    expect(resolveRelayCause({ auth: 'quic-only' }, 'connected', true)).toBe('unreachable')
  })

  it('resolveRelayCause: ok/sin auth + túnel caído → unreachable; túnel ok → null', () => {
    expect(resolveRelayCause({ auth: 'ok' }, 'disconnected', true)).toBe('unreachable')
    expect(resolveRelayCause({ auth: 'ok' }, 'connected', true)).toBeNull()
    expect(resolveRelayCause({}, 'disconnected', true)).toBe('unreachable')
    expect(resolveRelayCause({}, 'connected', true)).toBeNull()
    expect(resolveRelayCause(null, 'disconnected', true)).toBe('unreachable')
    // Sin UI habilitada no hay aviso de túnel.
    expect(resolveRelayCause({}, 'disconnected', false)).toBeNull()
    expect(resolveRelayCause({}, undefined, true)).toBeNull()
  })
})

describe('relay auth: acciones del composable', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    stubNoWs()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('unlinkRelay hace POST a /relay-unlink y refresca el estado', async () => {
    const status = makeStatus({ auth: 'ok', deviceLinked: true, tunnel: 'connected' })
    const { fn, calls } = makeFetch(status)
    vi.stubGlobal('fetch', fn)
    const { unlinkRelay, status: statusRef } = useRemote()
    await unlinkRelay()
    expect(calls.some((c) => c.url.includes('/remote/relay-unlink') && c.init?.method === 'POST')).toBe(true)
    expect(calls.some((c) => c.url.includes('/remote/status'))).toBe(true)
    expect(statusRef.value).toBeTruthy()
  })

  it('rotateRelayToken hace POST a /relay-rotate y refresca el estado (sin exponer token)', async () => {
    const status = makeStatus({ auth: 'ok', deviceLinked: true, tunnel: 'connected' })
    const { fn, calls } = makeFetch(status)
    vi.stubGlobal('fetch', fn)
    const { rotateRelayToken } = useRemote()
    await rotateRelayToken()
    const post = calls.find((c) => c.url.includes('/remote/relay-rotate'))
    expect(post).toBeTruthy()
    expect(post!.init?.method).toBe('POST')
    // El cuerpo no lleva ningún token: solo dispara la rotación en el daemon.
    expect(String(post!.init?.body ?? '{}')).not.toMatch(/token|secret/i)
    expect(calls.some((c) => c.url.includes('/remote/status'))).toBe(true)
  })
})

describe('RemotePane: aviso por causa + estado del vínculo', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    stubNoWs()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  const cases: Array<{ auth: string; deviceLinked: boolean; causeCy: string; msgKey: string }> = [
    { auth: 'auth-required', deviceLinked: false, causeCy: 'relay-auth-required', msgKey: 'bd.remoteRelayAuthRequired' },
    { auth: 'invalid-token', deviceLinked: false, causeCy: 'relay-invalid-token', msgKey: 'bd.remoteRelayInvalidToken' },
    { auth: 'rate-limited', deviceLinked: false, causeCy: 'relay-rate-limited', msgKey: 'bd.remoteRelayRateLimited' },
    { auth: 'unreachable', deviceLinked: false, causeCy: 'relay-unreachable', msgKey: 'bd.remoteUiTunnelDown' },
    { auth: 'unsupported', deviceLinked: false, causeCy: 'relay-unsupported', msgKey: 'bd.remoteRelayUnsupported' },
  ]

  it.each(cases)('auth=$auth muestra su mensaje y conserva el contenedor legacy', async ({ auth, deviceLinked, causeCy, msgKey }) => {
    const { fn } = makeFetch(makeStatus({ auth, deviceLinked, tunnel: 'connected' }))
    vi.stubGlobal('fetch', fn)
    const wrapper = mount(RemotePane)
    await flushPromises()
    // Contenedor legacy preservado (compat con tests/antiguos selectores).
    expect(wrapper.find('[data-cy="remote-ui-tunnel"]').exists()).toBe(true)
    const cause = wrapper.find(`[data-cy="${causeCy}"]`)
    expect(cause.exists()).toBe(true)
    expect(cause.text()).toContain(msgKey)
    wrapper.unmount()
  })

  it('auth-required incluye la nota automática y botón Vincular ahora que refresca', async () => {
    const { fn, calls } = makeFetch(makeStatus({ auth: 'auth-required', deviceLinked: false, tunnel: 'connected' }))
    vi.stubGlobal('fetch', fn)
    const wrapper = mount(RemotePane)
    await flushPromises()
    expect(wrapper.find('[data-cy="relay-auth-required"]').text()).toContain('bd.remoteRelayAuthAuto')
    const btn = wrapper.find('[data-cy="remote-relay-link-now"]')
    expect(btn.exists()).toBe(true)
    expect(btn.text()).toContain('bd.remoteRelayLinkNow')
    const before = calls.filter((c) => c.url.includes('/remote/status')).length
    await btn.trigger('click')
    await flushPromises()
    expect(calls.filter((c) => c.url.includes('/remote/status')).length).toBeGreaterThan(before)
    // Nunca se renderiza un token.
    expect(wrapper.text()).not.toMatch(/token|secret/i)
    wrapper.unmount()
  })

  it('invalid-token ofrece "Vincular de nuevo"', async () => {
    const { fn } = makeFetch(makeStatus({ auth: 'invalid-token', deviceLinked: false, tunnel: 'connected' }))
    vi.stubGlobal('fetch', fn)
    const wrapper = mount(RemotePane)
    await flushPromises()
    const btn = wrapper.find('[data-cy="remote-relay-link-now"]')
    expect(btn.exists()).toBe(true)
    expect(btn.text()).toContain('bd.remoteRelayRelink')
    wrapper.unmount()
  })

  it('rate-limited ofrece reintentar', async () => {
    const { fn, calls } = makeFetch(makeStatus({ auth: 'rate-limited', deviceLinked: false, tunnel: 'connected' }))
    vi.stubGlobal('fetch', fn)
    const wrapper = mount(RemotePane)
    await flushPromises()
    const btn = wrapper.find('[data-cy="remote-relay-retry"]')
    expect(btn.exists()).toBe(true)
    expect(btn.text()).toContain('bd.remoteRelayRetry')
    const before = calls.filter((c) => c.url.includes('/remote/status')).length
    await btn.trigger('click')
    await flushPromises()
    expect(calls.filter((c) => c.url.includes('/remote/status')).length).toBeGreaterThan(before)
    wrapper.unmount()
  })

  it('unreachable conserva el texto de sin-conexión (sin culpar al daemon)', async () => {
    const { fn } = makeFetch(makeStatus({ tunnel: 'disconnected' }))
    vi.stubGlobal('fetch', fn)
    const wrapper = mount(RemotePane)
    await flushPromises()
    expect(wrapper.find('[data-cy="relay-unreachable"]').text()).toContain('bd.remoteUiTunnelDown')
    wrapper.unmount()
  })

  it('estado del vínculo: vinculado vs no vinculado', async () => {
    const { fn } = makeFetch(makeStatus({ auth: 'ok', deviceLinked: true, tunnel: 'connected' }))
    vi.stubGlobal('fetch', fn)
    const w1 = mount(RemotePane)
    await flushPromises()
    expect(w1.find('[data-cy="remote-relay-link-state"]').exists()).toBe(true)
    expect(w1.find('[data-cy="relay-linked"]').exists()).toBe(true)
    expect(w1.find('[data-cy="relay-linked"]').text()).toContain('bd.remoteRelayLinked')
    w1.unmount()

    const { fn: fn2 } = makeFetch(makeStatus({ auth: 'auth-required', deviceLinked: false, tunnel: 'connected' }))
    vi.stubGlobal('fetch', fn2)
    const w2 = mount(RemotePane)
    await flushPromises()
    expect(w2.find('[data-cy="relay-unlinked"]').exists()).toBe(true)
    expect(w2.find('[data-cy="relay-unlinked"]').text()).toContain('bd.remoteRelayUnlinked')
    w2.unmount()
  })

  it('desvincular pide confirmación inline y llama al endpoint', async () => {
    const { fn, calls } = makeFetch(makeStatus({ auth: 'ok', deviceLinked: true, tunnel: 'connected' }))
    vi.stubGlobal('fetch', fn)
    const wrapper = mount(RemotePane)
    await flushPromises()
    expect(wrapper.find('[data-cy="remote-relay-unlink"]').exists()).toBe(true)
    expect(wrapper.find('[data-cy="remote-relay-unlink-confirm"]').exists()).toBe(false)
    await wrapper.find('[data-cy="remote-relay-unlink"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-cy="remote-relay-unlink-confirm"]').exists()).toBe(true)
    await wrapper.find('[data-cy="remote-relay-unlink-confirm"]').trigger('click')
    await flushPromises()
    expect(calls.some((c) => c.url.includes('/remote/relay-unlink') && c.init?.method === 'POST')).toBe(true)
    wrapper.unmount()
  })

  it('rotar pide confirmación inline y llama al endpoint', async () => {
    const { fn, calls } = makeFetch(makeStatus({ auth: 'ok', deviceLinked: true, tunnel: 'connected' }))
    vi.stubGlobal('fetch', fn)
    const wrapper = mount(RemotePane)
    await flushPromises()
    await wrapper.find('[data-cy="remote-relay-rotate"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-cy="remote-relay-rotate-confirm"]').exists()).toBe(true)
    await wrapper.find('[data-cy="remote-relay-rotate-confirm"]').trigger('click')
    await flushPromises()
    expect(calls.some((c) => c.url.includes('/remote/relay-rotate') && c.init?.method === 'POST')).toBe(true)
    expect(wrapper.text()).not.toMatch(/token|secret/i)
    wrapper.unmount()
  })
})
