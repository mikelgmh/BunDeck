import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import PluginSettingsDialog from '../components/bundeck/PluginSettingsDialog.vue'

vi.mock('../composables/useI18n', () => ({
  useI18nStore: () => ({
    t: (key: string) => key,
  }),
}))

// jsdom no implementa showModal/close de <dialog>: stub.
function stubDialog(el: HTMLDialogElement | null) {
  if (!el) return
  if (!('showModal' in el) || typeof (el as any).showModal !== 'function') {
    ;(el as any).showModal = vi.fn()
  }
  if (!('close' in el) || typeof (el as any).close !== 'function') {
    ;(el as any).close = vi.fn()
  } else {
    vi.spyOn(el, 'close').mockImplementation(() => {})
    vi.spyOn(el, 'showModal' as any).mockImplementation(() => {})
  }
}

const realFetch = globalThis.fetch

function mockFetchOnce(bundle: any) {
  globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => bundle })) as any
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  globalThis.fetch = realFetch
  vi.restoreAllMocks()
})

describe('PluginSettingsDialog OAuth (Spotify sin Client ID)', () => {
  it('muestra la caja de conexión cuando el bundle trae oauth', async () => {
    mockFetchOnce({
      schema: { properties: { token: { title: 'Token', type: 'string' } }, required: ['token'] },
      values: {},
      instructions: 'x',
      oauth: { provider: 'spotify', method: 'web-player-extraction' },
      configured: false,
    })
    const wrapper = mount(PluginSettingsDialog, { props: { apiBase: 'http://localhost:3001/api/v1' } })
    stubDialog(wrapper.find('dialog').element as HTMLDialogElement)
    await (wrapper.vm as any).show('spotify')
    await Promise.resolve()
    expect(wrapper.find('[data-cy="bd-oauth-box"]').exists()).toBe(true)
    expect(wrapper.find('[data-cy="bd-oauth-connect"]').exists()).toBe(true)
    expect(wrapper.find('[data-cy="bd-oauth-status"]').exists()).toBe(false)
  })

  it('no muestra la caja sin oauth (plugins genéricos)', async () => {
    mockFetchOnce({ schema: null, values: {}, instructions: '', configured: true })
    const wrapper = mount(PluginSettingsDialog, { props: { apiBase: 'http://localhost:3001/api/v1' } })
    stubDialog(wrapper.find('dialog').element as HTMLDialogElement)
    await (wrapper.vm as any).show('page')
    await Promise.resolve()
    expect(wrapper.find('[data-cy="bd-oauth-box"]').exists()).toBe(false)
  })

  it('conectar pide login-request y resuelve al configurarse', async () => {
    // 1) bundle inicial sin configurar; 2) POST login-request ok; 3+) poll → configurado.
    let polls = 0
    globalThis.fetch = vi.fn(async (url: string, init?: any) => {
      if (init?.method === 'POST' && String(url).includes('login-request')) {
        return { ok: true, json: async () => ({ success: true }) }
      }
      if (String(url).includes('login-request')) {
        return { ok: true, json: async () => ({ pending: true }) }
      }
      polls++
      if (polls >= 2) {
        return {
          ok: true,
          json: async () => ({
            schema: { properties: {} },
            values: { token: 'tok-abc' },
            instructions: '',
            oauth: { provider: 'spotify' },
            configured: true,
          }),
        }
      }
      return {
        ok: true,
        json: async () => ({
          schema: { properties: {} },
          values: {},
          instructions: '',
          oauth: { provider: 'spotify' },
          configured: false,
        }),
      }
    }) as any
    const wrapper = mount(PluginSettingsDialog, { props: { apiBase: 'http://localhost:3001/api/v1' } })
    stubDialog(wrapper.find('dialog').element as HTMLDialogElement)
    await (wrapper.vm as any).show('spotify')
    const p = (wrapper.vm as any).connectOAuth()
    // Avanzar los intervalos de poll (2s) hasta resolver.
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(2100)
    }
    await p
    expect(wrapper.emitted('saved')).toBeTruthy()
    expect(wrapper.find('[data-cy="bd-oauth-status"]').exists()).toBe(true)
  })
})
