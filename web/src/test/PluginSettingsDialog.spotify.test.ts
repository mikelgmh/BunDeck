import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
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

  it('pending muestra guía accionable + enlace a open.spotify.com', async () => {
    // POST login-request ok; el poll nunca se configura: sigue pendiente.
    globalThis.fetch = vi.fn(async (url: string, init?: any) => {
      if (init?.method === 'POST' && String(url).includes('login-request')) {
        return { ok: true, json: async () => ({ success: true }) }
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
    await vi.advanceTimersByTimeAsync(2100)
    await flushPromises()
    // Mientras está pendiente: guía del host + pista remota + enlace.
    const hint = wrapper.find('[data-cy="bd-spotify-host-hint"]')
    expect(hint.exists()).toBe(true)
    expect(hint.text()).toContain('bd.spotifyHostWindow')
    expect(hint.text()).toContain('bd.spotifyRemoteHint')
    const link = hint.find('[data-cy="bd-spotify-open"]')
    expect(link.exists()).toBe(true)
    expect(link.attributes('href')).toBe('https://open.spotify.com')
    expect(link.attributes('target')).toBe('_blank')
    // Limpieza: agotar el timeout de 5 min y tragar el rechazo.
    const done = p.catch(() => {})
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 5000)
    await done
    await flushPromises()
    expect(wrapper.find('[data-cy="bd-spotify-host-hint"]').exists()).toBe(false)
  })

  it('cancelar aborta el pending y re-habilita el botón', async () => {
    const deletes: string[] = []
    globalThis.fetch = vi.fn(async (url: string, init?: any) => {
      if (init?.method === 'POST' && String(url).includes('login-request')) {
        return { ok: true, json: async () => ({ success: true }) }
      }
      if (init?.method === 'DELETE' && String(url).includes('login-request')) {
        deletes.push(String(url))
        return { ok: true, json: async () => ({ success: true }) }
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
    await vi.advanceTimersByTimeAsync(2100)
    await flushPromises()
    const pending = wrapper.find('[data-cy="bd-oauth-pending"]')
    expect(pending.exists()).toBe(true)
    expect(pending.element.tagName).toBe('P')
    const row = wrapper.find('.bd-r2')
    expect(row.exists()).toBe(true)
    expect(row.element.contains(pending.element)).toBe(false)
    const cancel = wrapper.find('[data-cy="bd-oauth-cancel"]')
    expect(cancel.exists()).toBe(true)
    await cancel.trigger('click')
    await flushPromises()
    expect(deletes.length).toBeGreaterThanOrEqual(1)
    expect(wrapper.find('[data-cy="bd-oauth-pending"]').exists()).toBe(false)
    expect((wrapper.find('[data-cy="bd-oauth-connect"]').element as HTMLButtonElement).disabled).toBe(false)
    const done = p.catch(() => {})
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 5000)
    await done
  })
})
