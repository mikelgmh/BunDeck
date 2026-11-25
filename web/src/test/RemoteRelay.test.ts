import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { isValidRelayUrlInput, isRelayDisabledInput } from '../composables/useRemote'
import RemotePane from '../components/bundeck/RemotePane.vue'

vi.mock('../composables/useI18n', () => ({
  useI18nStore: () => ({
    t: (key: string) => key,
    currentLocale: { value: 'es' },
    setLocale: () => {},
    loadSavedLocale: () => {},
  }),
}))

const statusPublic = {
  deviceId: 'dev-local-12345678',
  fingerprint: 'ab12:34cd:56ef:78ab:90cd:12ef:34ab:56cd',
  publicKey: 'cHViLWtleQ==',
  relay: { url: 'wss://relay.bundeck.app', status: 'connected' },
  pending: 0,
  trusted: 0,
  policy: ['page.select', 'button.press'],
}

function mockFetch(status: typeof statusPublic, calls: Array<{ url: string; init?: RequestInit }>) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    const u = String(url)
    const method = init?.method ?? 'GET'
    if (u.endsWith('/config')) return { ok: true, json: async () => ({ apiPort: 3001, wsPort: 3003 }) }
    if (u.includes('/remote/status')) return { ok: true, json: async () => status }
    if (u.includes('/remote/relay') && method === 'PUT') {
      const body = JSON.parse(String(init?.body ?? '{}'))
      if (body.url === null || body.url === undefined) {
        return { ok: true, json: async () => ({ ok: true, url: 'wss://relay.bundeck.app' }) }
      }
      return { ok: true, json: async () => ({ ok: true, url: String(body.url) }) }
    }
    if (u.includes('/remote/devices') && method === 'GET') return { ok: true, json: async () => ({ devices: [] }) }
    if (u.includes('/api/v1/devices') && method === 'GET') return { ok: true, json: async () => [] }
    if (u.includes('/lan-sessions')) return { ok: true, json: async () => ({ sessions: [] }) }
    return { ok: true, json: async () => ({ ok: true }) }
  })
}

function stubGlobals() {
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

beforeEach(() => {
  vi.unstubAllGlobals()
  stubGlobals()
})

describe('isValidRelayUrlInput', () => {
  it('acepta ws/wss y http(s) (normalizables), rechaza resto y vacía', () => {
    expect(isValidRelayUrlInput('wss://relay.example.test')).toBe(true)
    expect(isValidRelayUrlInput('ws://localhost:3003')).toBe(true)
    expect(isValidRelayUrlInput('https://relay.example.test')).toBe(true)
    expect(isValidRelayUrlInput('http://localhost:3003/x')).toBe(true)
    expect(isValidRelayUrlInput('')).toBe(false)
    expect(isValidRelayUrlInput('   ')).toBe(false)
    expect(isValidRelayUrlInput(null)).toBe(false)
    expect(isValidRelayUrlInput(undefined)).toBe(false)
    expect(isValidRelayUrlInput('ftp://x.test')).toBe(false)
    expect(isValidRelayUrlInput('notaurl')).toBe(false)
  })

  it('acepta centinelas de desactivado', () => {
    expect(isRelayDisabledInput('off')).toBe(true)
    expect(isRelayDisabledInput('OFF')).toBe(true)
    expect(isRelayDisabledInput('none')).toBe(true)
    expect(isRelayDisabledInput('disabled')).toBe(true)
    expect(isValidRelayUrlInput('off')).toBe(true)
    expect(isRelayDisabledInput('wss://x.test')).toBe(false)
  })
})

describe('RemotePane: sección Relay', () => {
  it('renderiza radios, input, guardar/restablecer con data-cy', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    vi.stubGlobal('fetch', mockFetch(statusPublic, calls))
    const wrapper = mount(RemotePane)
    await flushPromises()
    expect(wrapper.find('[data-cy="remote-relay-section"]').exists()).toBe(true)
    expect(wrapper.find('[data-cy="remote-relay-public"]').exists()).toBe(true)
    expect(wrapper.find('[data-cy="remote-relay-custom"]').exists()).toBe(true)
    expect(wrapper.find('[data-cy="remote-relay-off"]').exists()).toBe(true)
    expect(wrapper.find('[data-cy="remote-relay-save"]').exists()).toBe(true)
    expect(wrapper.find('[data-cy="remote-relay-reset"]').exists()).toBe(true)
    // Con el relay público efectivo, el modo inicial es público.
    expect((wrapper.find('[data-cy="remote-relay-public"]').element as HTMLInputElement).checked).toBe(true)
    wrapper.unmount()
  })

  it('muestra aviso si RELAY_URL en env ignora Ajustes', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const withEnv = { ...statusPublic, relay: { ...statusPublic.relay, envOverride: true } }
    vi.stubGlobal('fetch', mockFetch(withEnv, calls))
    const wrapper = mount(RemotePane)
    await flushPromises()
    expect(wrapper.find('[data-cy="remote-relay-env"]').exists()).toBe(true)
    expect(wrapper.find('[data-cy="remote-relay-env"]').text()).toContain('bd.remoteRelayEnvHint')
    wrapper.unmount()
  })

  it('URL inválida: muestra error y no llama al endpoint', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    vi.stubGlobal('fetch', mockFetch(statusPublic, calls))
    const wrapper = mount(RemotePane)
    await flushPromises()
    const custom = wrapper.find('[data-cy="remote-relay-custom"]')
    ;(custom.element as HTMLInputElement).checked = true
    await custom.trigger('change')
    await wrapper.find('[data-cy="remote-relay-url"]').setValue('notaurl')
    await wrapper.find('[data-cy="remote-relay-save"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-cy="remote-relay-error"]').exists()).toBe(true)
    expect(wrapper.find('[data-cy="remote-relay-error"]').text()).toContain('bd.remoteRelayInvalid')
    expect(calls.some((c) => c.url.includes('/remote/relay'))).toBe(false)
    wrapper.unmount()
  })

  it('guardar custom válido llama a PUT /remote/relay y restablecer manda null', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    vi.stubGlobal('fetch', mockFetch(statusPublic, calls))
    const wrapper = mount(RemotePane)
    await flushPromises()
    const custom = wrapper.find('[data-cy="remote-relay-custom"]')
    ;(custom.element as HTMLInputElement).checked = true
    await custom.trigger('change')
    await wrapper.find('[data-cy="remote-relay-url"]').setValue('wss://relay-custom.example.test')
    await wrapper.find('[data-cy="remote-relay-save"]').trigger('click')
    await flushPromises()
    const puts = calls.filter((c) => c.url.includes('/remote/relay') && c.init?.method === 'PUT')
    expect(puts.length).toBeGreaterThan(0)
    expect(String(puts[0].init?.body)).toContain('wss://relay-custom.example.test')

    await wrapper.find('[data-cy="remote-relay-reset"]').trigger('click')
    await flushPromises()
    const resets = calls.filter((c) => c.url.includes('/remote/relay') && c.init?.method === 'PUT')
    expect(String(resets[resets.length - 1].init?.body)).toContain('null')
    wrapper.unmount()
  })
})
