import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import WebhooksPane from '../components/bundeck/WebhooksPane.vue'

vi.mock('../composables/useI18n', () => ({
  useI18nStore: () => ({
    t: (key: string) => key,
    currentLocale: { value: 'es' },
    setLocale: () => {},
    loadSavedLocale: () => {},
  }),
}))

// Sin mock del palette: el ActionCommandPalette real se monta como async
// (jsdom lo resuelve con flushPromises); no se abre en estos tests.

const HOOKS = [
  {
    id: 'wh-1',
    name: 'Cine',
    token: 'a'.repeat(64),
    method: 'POST',
    enabled: 1,
    actions: [{ type: 'local.toast', parameters: { text: 'cine' } }],
    trigger_count: 3,
    last_triggered_at: Date.now(),
  },
  {
    id: 'wh-2',
    name: 'Fuera de casa',
    token: 'b'.repeat(64),
    method: 'GET',
    enabled: 0,
    actions: [],
    trigger_count: 0,
    last_triggered_at: null,
  },
]

const calls: Array<{ url: string; method: string; body?: any }> = []

function mockFetch() {
  calls.length = 0
  return vi.fn(async (url: string, init: any = {}) => {
    const method = (init.method ?? 'GET').toUpperCase()
    let body: any
    try {
      body = init.body ? JSON.parse(init.body) : undefined
    } catch {
      body = undefined
    }
    calls.push({ url, method, body })
    if (url.endsWith('/webhooks') && method === 'GET') {
      return { ok: true, json: async () => HOOKS }
    }
    if (url.endsWith('/network/ips') && method === 'GET') {
      return { ok: true, json: async () => ({ ips: ['192.168.1.10'] }) }
    }
    if (url.endsWith('/webhooks') && method === 'POST') {
      return { ok: true, json: async () => ({ id: 'wh-new', ...body, token: 'c'.repeat(64), trigger_count: 0, last_triggered_at: null }) }
    }
    const testMatch = url.match(/\/webhooks\/([^/]+)\/test$/)
    if (testMatch && method === 'POST') {
      return { ok: true, json: async () => ({ ok: true, executed: 1, failed: 0, results: [] }) }
    }
    const regenMatch = url.match(/\/webhooks\/([^/]+)\/regenerate$/)
    if (regenMatch && method === 'POST') {
      return { ok: true, json: async () => ({ ...HOOKS[0], token: 'd'.repeat(64) }) }
    }
    const itemMatch = url.match(/\/webhooks\/([^/]+)$/)
    if (itemMatch) {
      if (method === 'PUT') {
        const cur = HOOKS.find((h) => h.id === itemMatch[1]) ?? HOOKS[0]
        return { ok: true, json: async () => ({ ...cur, ...body }) }
      }
      if (method === 'DELETE') return { ok: true, json: async () => ({ ok: true }) }
    }
    return { ok: false, status: 404, json: async () => ({ error: 'nope' }) }
  })
}

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch())
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function mountPane() {
  return mount(WebhooksPane, {
    props: { apiBase: 'http://127.0.0.1:3001/api/v1', plugins: [], detailed: [] },
  })
}

describe('WebhooksPane', () => {
  it('renderiza la lista con URL completa LAN, método, nº acciones y on/off', async () => {
    const wrapper = mountPane()
    await flushPromises()
    expect(wrapper.find('[data-cy="bd-webhooks"]').exists()).toBe(true)
    expect(wrapper.find('[data-cy="bd-webhook-item-wh-1"]').exists()).toBe(true)
    expect(wrapper.find('[data-cy="bd-webhook-item-wh-2"]').exists()).toBe(true)
    // URL con la IP LAN (no localhost) + token
    const urlInput = wrapper.find('[data-cy="bd-webhook-url-wh-1"]')
    expect((urlInput.element as HTMLInputElement).value).toContain('http://192.168.1.10:3001/api/v1/webhooks/')
    expect((urlInput.element as HTMLInputElement).value).toContain('a'.repeat(64))
    expect(wrapper.text()).toContain('bd.webhooksLocalOnly')
  })

  it('el buscador acota la lista', async () => {
    const wrapper = mountPane()
    await flushPromises()
    await wrapper.find('[data-cy="bd-webhooks-search"]').setValue('cine')
    expect(wrapper.find('[data-cy="bd-webhook-item-wh-1"]').exists()).toBe(true)
    expect(wrapper.find('[data-cy="bd-webhook-item-wh-2"]').exists()).toBe(false)
  })

  it('crear emite POST con nombre y acciones', async () => {
    const wrapper = mountPane()
    await flushPromises()
    await wrapper.find('[data-cy="bd-webhook-new"]').trigger('click')
    await wrapper.find('[data-cy="bd-webhook-name"]').setValue('Prueba')
    await wrapper.find('[data-cy="bd-webhook-save"]').trigger('click')
    await flushPromises()
    const post = calls.find((c) => c.url.endsWith('/webhooks') && c.method === 'POST')
    expect(post).toBeTruthy()
    expect(post!.body.name).toBe('Prueba')
  })

  it('toggle emite PUT con enabled', async () => {
    const wrapper = mountPane()
    await flushPromises()
    await wrapper.find('[data-cy="bd-webhook-toggle-wh-2"]').setValue(true)
    await flushPromises()
    const put = calls.find((c) => c.url.endsWith('/webhooks/wh-2') && c.method === 'PUT')
    expect(put).toBeTruthy()
    expect(put!.body.enabled).toBe(true)
  })

  it('copiar notifica la URL', async () => {
    const wrapper = mountPane()
    await flushPromises()
    await wrapper.find('[data-cy="bd-webhook-copy-wh-1"]').trigger('click')
    expect(wrapper.emitted('notify')).toBeTruthy()
    expect(wrapper.emitted('notify')![0]).toEqual(['bd.webhookCopied'])
  })

  it('probar dispara el test y notifica el resultado', async () => {
    const wrapper = mountPane()
    await flushPromises()
    await wrapper.find('[data-cy="bd-webhook-test-wh-1"]').trigger('click')
    await flushPromises()
    expect(calls.some((c) => c.url.endsWith('/webhooks/wh-1/test') && c.method === 'POST')).toBe(true)
    expect(wrapper.emitted('notify')).toBeTruthy()
    expect(String(wrapper.emitted('notify')![0][0])).toContain('bd.webhookTestOk')
  })

  it('borrar pide confirmación y luego emite DELETE', async () => {
    const wrapper = mountPane()
    await flushPromises()
    await wrapper.find('[data-cy="bd-webhook-delete-wh-1"]').trigger('click')
    // Aún no borra: muestra confirmación
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
    await wrapper.find('[data-cy="bd-webhook-delete-confirm-wh-1"]').trigger('click')
    await flushPromises()
    expect(calls.some((c) => c.url.endsWith('/webhooks/wh-1') && c.method === 'DELETE')).toBe(true)
  })

  it('sin webhooks muestra un estado vacío cuidado', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).endsWith('/network/ips')) return { ok: true, json: async () => ({ ips: [] }) }
      return { ok: true, json: async () => [] }
    })
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = mountPane()
    await flushPromises()
    const empty = wrapper.find('[data-cy="bd-webhooks-empty"]')
    expect(empty.exists()).toBe(true)
    expect(empty.text()).toContain('bd.webhookNoHooks')
  })

  it('buscar sin resultados muestra el hint de no-match', async () => {
    const wrapper = mountPane()
    await flushPromises()
    await wrapper.find('[data-cy="bd-webhooks-search"]').setValue('zzz-sin-coincidencia')
    expect(wrapper.find('[data-cy="bd-webhook-item-wh-1"]').exists()).toBe(false)
    const nomatch = wrapper.find('[data-cy="bd-webhooks-nomatch"]')
    expect(nomatch.exists()).toBe(true)
    expect(nomatch.text()).toContain('bd.webhookNoMatch')
  })
})
