import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import PluginSettingsDialog from '../components/bundeck/PluginSettingsDialog.vue'

vi.mock('../composables/useI18n', () => ({
  useI18nStore: () => ({
    t: (key: string) => key,
  }),
}))

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

const discordBundle = {
  schema: {
    properties: {
      mode: { title: 'Modo', type: 'string', enum: ['auto', 'rpc', 'hotkey'] },
      clientId: { title: 'Client ID', type: 'string' },
      clientSecret: { title: 'Client Secret', type: 'string' },
      redirectUri: { title: 'Redirect URI', type: 'string' },
      proxyUrl: { title: 'Relay URL', type: 'string' },
      accessToken: { title: 'Access token', type: 'string' },
    },
    required: [],
  },
  values: {},
  instructions: 'x',
  oauth: { provider: 'discord', method: 'oauth-code' },
  configured: false,
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  globalThis.fetch = realFetch
  vi.restoreAllMocks()
})

describe('PluginSettingsDialog sección Discord (cero-config + avanzado)', () => {
  it('muestra Client ID / Redirect / Modo / Proxy con defaults baked-in como placeholder', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => discordBundle })) as any
    const wrapper = mount(PluginSettingsDialog, { props: { apiBase: 'http://localhost:3001/api/v1' } })
    stubDialog(wrapper.find('dialog').element as HTMLDialogElement)
    await (wrapper.vm as any).show('discord')
    await Promise.resolve()
    const box = wrapper.find('[data-cy="bd-discord-fields"]')
    expect(box.exists()).toBe(true)
    expect(wrapper.find('[data-cy="bd-discord-client-id"]').attributes('placeholder')).toBe('1575201215791497256')
    expect(wrapper.find('[data-cy="bd-discord-redirect-uri"]').attributes('placeholder')).toBe(
      'https://relay.bundeck.app/api/discord/callback',
    )
    expect(wrapper.find('[data-cy="bd-discord-proxy-url"]').attributes('placeholder')).toBe(
      'https://relay.bundeck.app/api/discord/rpc-token',
    )
    expect(wrapper.find('[data-cy="bd-discord-mode"]').exists()).toBe(true)
    // Sin duplicados del loop genérico: las claves las edita la sección dedicada.
    expect(wrapper.find('#ps-clientId').exists()).toBe(false)
    expect(wrapper.find('#ps-redirectUri').exists()).toBe(false)
    expect(wrapper.find('#ps-proxyUrl').exists()).toBe(false)
  })

  it('el Client Secret vive en <details> avanzado (power-user)', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => discordBundle })) as any
    const wrapper = mount(PluginSettingsDialog, { props: { apiBase: 'http://localhost:3001/api/v1' } })
    stubDialog(wrapper.find('dialog').element as HTMLDialogElement)
    await (wrapper.vm as any).show('discord')
    await Promise.resolve()
    const details = wrapper.find('[data-cy="bd-discord-secret"]')
    expect(details.exists()).toBe(true)
    expect(details.find('[data-cy="bd-discord-client-secret"]').exists()).toBe(true)
    expect(details.find('[data-cy="bd-discord-client-secret"]').attributes('type')).toBe('password')
  })

  it('guardar envía los valores discord (settings discord.*)', async () => {
    const puts: any[] = []
    globalThis.fetch = vi.fn(async (url: string, init?: any) => {
      if (init?.method === 'PUT') {
        puts.push(JSON.parse(init.body))
        return { ok: true, json: async () => ({ success: true }) }
      }
      return { ok: true, json: async () => discordBundle }
    }) as any
    const wrapper = mount(PluginSettingsDialog, { props: { apiBase: 'http://localhost:3001/api/v1' } })
    stubDialog(wrapper.find('dialog').element as HTMLDialogElement)
    await (wrapper.vm as any).show('discord')
    await Promise.resolve()
    await wrapper.find('[data-cy="bd-discord-client-id"]').setValue('cid-propia')
    await wrapper.find('[data-cy="bd-discord-redirect-uri"]').setValue('http://127.0.0.1:6463')
    await wrapper.find('[data-cy="bd-discord-client-secret"]').setValue('sec-propio')
    await wrapper.find('[data-cy="bd-discord-mode"]').setValue('rpc')
    await (wrapper.vm as any).save()
    await flushPromises()
    expect(puts).toHaveLength(1)
    expect(puts[0].values).toMatchObject({
      clientId: 'cid-propia',
      redirectUri: 'http://127.0.0.1:6463',
      clientSecret: 'sec-propio',
      mode: 'rpc',
    })
  })

  it('plugins no-discord no muestran la sección', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ schema: { properties: { token: { title: 'Token' } } }, values: {}, instructions: '', configured: true }),
    })) as any
    const wrapper = mount(PluginSettingsDialog, { props: { apiBase: 'http://localhost:3001/api/v1' } })
    stubDialog(wrapper.find('dialog').element as HTMLDialogElement)
    await (wrapper.vm as any).show('spotify')
    await Promise.resolve()
    expect(wrapper.find('[data-cy="bd-discord-fields"]').exists()).toBe(false)
  })

  it('sin autorizar: muestra "no conectado" + Autorizar primario, sin ✓ ni Desconectar', async () => {
    globalThis.fetch = vi.fn(async (url: string, init?: any) => {
      if (init?.method === 'POST' && String(url).endsWith('/key')) {
        return { ok: true, json: async () => ({ success: true, result: { status: 'needs-auth' } }) }
      }
      return { ok: true, json: async () => ({ ...discordBundle, configured: false, discordStatus: 'needs-auth' }) }
    }) as any
    const wrapper = mount(PluginSettingsDialog, { props: { apiBase: 'http://localhost:3001/api/v1' } })
    stubDialog(wrapper.find('dialog').element as HTMLDialogElement)
    await (wrapper.vm as any).show('discord')
    await flushPromises()
    expect(wrapper.find('[data-cy="bd-oauth-status"]').exists()).toBe(false)
    expect(wrapper.find('[data-cy="bd-discord-state"]').text()).toContain('bd.discordNotConnected')
    const connect = wrapper.find('[data-cy="bd-oauth-connect"]')
    expect(connect.text()).toContain('bd.discordConnect')
    expect(connect.classes()).toContain('bd-pri')
    expect(wrapper.find('[data-cy="bd-discord-disconnect"]').exists()).toBe(false)
    expect(wrapper.find('[data-cy="bd-discord-retry"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('checking: spinner visible mientras la sonda está en vuelo (apertura)', async () => {
    let resolveKey!: (v: any) => void
    globalThis.fetch = vi.fn(async (url: string, init?: any) => {
      if (init?.method === 'POST' && String(url).endsWith('/key')) {
        return new Promise((resolve) => {
          resolveKey = resolve
        })
      }
      return { ok: true, json: async () => ({ ...discordBundle, configured: false, discordStatus: 'needs-auth' }) }
    }) as any
    const wrapper = mount(PluginSettingsDialog, { props: { apiBase: 'http://localhost:3001/api/v1' } })
    stubDialog(wrapper.find('dialog').element as HTMLDialogElement)
    const shown = (wrapper.vm as any).show('discord')
    await flushPromises()
    const checking = wrapper.find('[data-cy="bd-discord-checking"]')
    expect(checking.exists()).toBe(true)
    expect(checking.text()).toContain('bd.discordStatusChecking')
    expect(checking.find('.bd-spin').exists()).toBe(true)
    // Al resolver la sonda, el spinner desaparece y queda el estado sin token.
    resolveKey({ ok: true, json: async () => ({ success: true, result: { status: 'needs-auth' } }) })
    await shown
    await flushPromises()
    expect(wrapper.find('[data-cy="bd-discord-checking"]').exists()).toBe(false)
    expect(wrapper.find('[data-cy="bd-discord-state"]').text()).toContain('bd.discordNotConnected')
    wrapper.unmount()
  })

  it('conectado: ✓ + Desconectar secundario + Volver a autorizar discreto', async () => {
    globalThis.fetch = vi.fn(async (url: string, init?: any) => {
      if (init?.method === 'POST' && String(url).endsWith('/key')) {
        return { ok: true, json: async () => ({ success: true, result: { status: 'connected' } }) }
      }
      return { ok: true, json: async () => ({ ...discordBundle, configured: true, discordStatus: 'authorized' }) }
    }) as any
    const wrapper = mount(PluginSettingsDialog, { props: { apiBase: 'http://localhost:3001/api/v1' } })
    stubDialog(wrapper.find('dialog').element as HTMLDialogElement)
    await (wrapper.vm as any).show('discord')
    await flushPromises()
    expect(wrapper.find('[data-cy="bd-oauth-status"]').exists()).toBe(true)
    expect(wrapper.find('[data-cy="bd-discord-retry"]').exists()).toBe(false)
    const disconnect = wrapper.find('[data-cy="bd-discord-disconnect"]')
    expect(disconnect.exists()).toBe(true)
    expect(disconnect.text()).toContain('bd.discordDisconnect')
    const connect = wrapper.find('[data-cy="bd-oauth-connect"]')
    expect(connect.text()).toContain('bd.discordReconnect')
    expect(connect.classes()).not.toContain('bd-pri')
    wrapper.unmount()
  })

  it('Discord cerrado: caja ámbar + reintento automático en segundo plano, sin botón manual', async () => {
    globalThis.fetch = vi.fn(async (url: string, init?: any) => {
      if (init?.method === 'POST' && String(url).endsWith('/key')) {
        return { ok: true, json: async () => ({ success: true, result: { status: 'discord-closed' } }) }
      }
      return { ok: true, json: async () => ({ ...discordBundle, configured: true, discordStatus: 'authorized' }) }
    }) as any
    const wrapper = mount(PluginSettingsDialog, { props: { apiBase: 'http://localhost:3001/api/v1' } })
    stubDialog(wrapper.find('dialog').element as HTMLDialogElement)
    await (wrapper.vm as any).show('discord')
    await flushPromises()
    expect(wrapper.find('[data-cy="bd-oauth-status"]').exists()).toBe(false)
    const box = wrapper.find('[data-cy="bd-discord-state"]')
    expect(box.exists()).toBe(true)
    expect(box.classes()).toContain('bd-warnbox')
    expect(box.text()).toContain('bd.discordClosed')
    // Sin jerga "sonda": no hay botón manual, hay spinner automático.
    expect(wrapper.find('[data-cy="bd-discord-retry"]').exists()).toBe(false)
    const auto = wrapper.find('[data-cy="bd-discord-autoretry"]')
    expect(auto.exists()).toBe(true)
    expect(auto.find('.bd-spin').exists()).toBe(true)
    expect(wrapper.find('[data-cy="bd-discord-disconnect"]').exists()).toBe(true)
    expect(wrapper.find('[data-cy="bd-oauth-connect"]').text()).toContain('bd.discordReconnect')
    wrapper.unmount()
  })

  it('token caducado: caja roja + reintento automático + Desconectar', async () => {
    globalThis.fetch = vi.fn(async (url: string, init?: any) => {
      if (init?.method === 'POST' && String(url).endsWith('/key')) {
        return { ok: true, json: async () => ({ success: true, result: { status: 'token-expired' } }) }
      }
      return { ok: true, json: async () => ({ ...discordBundle, configured: false, discordStatus: 'token-expired' }) }
    }) as any
    const wrapper = mount(PluginSettingsDialog, { props: { apiBase: 'http://localhost:3001/api/v1' } })
    stubDialog(wrapper.find('dialog').element as HTMLDialogElement)
    await (wrapper.vm as any).show('discord')
    await flushPromises()
    expect(wrapper.find('[data-cy="bd-oauth-status"]').exists()).toBe(false)
    const box = wrapper.find('[data-cy="bd-discord-state"]')
    expect(box.exists()).toBe(true)
    expect(box.text()).toContain('bd.discordExpired')
    expect(wrapper.find('[data-cy="bd-discord-retry"]').exists()).toBe(false)
    expect(wrapper.find('[data-cy="bd-discord-autoretry"]').exists()).toBe(true)
    expect(wrapper.find('[data-cy="bd-discord-disconnect"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('autorizado con sonda desconocida: ámbar "Autorizado" + reintento automático (nunca ✓ mentiroso)', async () => {
    globalThis.fetch = vi.fn(async (url: string, init?: any) => {
      if (init?.method === 'POST' && String(url).endsWith('/key')) {
        return { ok: false, json: async () => ({}) }
      }
      return { ok: true, json: async () => ({ ...discordBundle, configured: true, discordStatus: 'authorized' }) }
    }) as any
    const wrapper = mount(PluginSettingsDialog, { props: { apiBase: 'http://localhost:3001/api/v1' } })
    stubDialog(wrapper.find('dialog').element as HTMLDialogElement)
    await (wrapper.vm as any).show('discord')
    await flushPromises()
    expect(wrapper.find('[data-cy="bd-oauth-status"]').exists()).toBe(false)
    const box = wrapper.find('[data-cy="bd-discord-state"]')
    expect(box.classes()).toContain('bd-warnbox')
    expect(box.text()).toContain('bd.discordAuthorized')
    expect(wrapper.find('[data-cy="bd-discord-retry"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('conectado: solo ✓, sin aviso ni Reintentar', async () => {
    globalThis.fetch = vi.fn(async (url: string, init?: any) => {
      if (init?.method === 'POST' && String(url).endsWith('/key')) {
        return { ok: true, json: async () => ({ success: true, result: { status: 'connected' } }) }
      }
      return { ok: true, json: async () => ({ ...discordBundle, configured: true, discordStatus: 'authorized' }) }
    }) as any
    const wrapper = mount(PluginSettingsDialog, { props: { apiBase: 'http://localhost:3001/api/v1' } })
    stubDialog(wrapper.find('dialog').element as HTMLDialogElement)
    await (wrapper.vm as any).show('discord')
    await flushPromises()
    expect(wrapper.find('[data-cy="bd-oauth-status"]').exists()).toBe(true)
    expect(wrapper.find('[data-cy="bd-discord-retry"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('click Desconectar llama a discord.disconnect y refresca al estado sin token', async () => {
    let mode: 'connected' | 'needs-auth' = 'connected'
    const fetchMock = vi.fn(async (url: string, init?: any) => {
      if (init?.method === 'POST' && String(url).endsWith('/key')) {
        const action = JSON.parse(init.body ?? '{}')?.action
        if (action === 'disconnect') {
          mode = 'needs-auth'
          return { ok: true, json: async () => ({ success: true, result: { status: 'disconnected' } }) }
        }
        return { ok: true, json: async () => ({ success: true, result: { status: mode } }) }
      }
      return {
        ok: true,
        json: async () => ({ ...discordBundle, configured: mode !== 'needs-auth', discordStatus: mode === 'needs-auth' ? 'needs-auth' : 'authorized' }),
      }
    })
    globalThis.fetch = fetchMock as any
    const wrapper = mount(PluginSettingsDialog, { props: { apiBase: 'http://localhost:3001/api/v1' } })
    stubDialog(wrapper.find('dialog').element as HTMLDialogElement)
    await (wrapper.vm as any).show('discord')
    await flushPromises()
    expect(wrapper.find('[data-cy="bd-oauth-status"]').exists()).toBe(true)
    await wrapper.find('[data-cy="bd-discord-disconnect"]').trigger('click')
    await flushPromises()
    const disconnectCalls = fetchMock.mock.calls.filter(
      ([u, i]) => i?.method === 'POST' && String(u).endsWith('/key') && JSON.parse(i.body ?? '{}')?.action === 'disconnect',
    )
    expect(disconnectCalls.length).toBe(1)
    expect(wrapper.find('[data-cy="bd-discord-state"]').text()).toContain('bd.discordNotConnected')
    expect(wrapper.find('[data-cy="bd-discord-disconnect"]').exists()).toBe(false)
    expect(wrapper.find('[data-cy="bd-oauth-connect"]').text()).toContain('bd.discordConnect')
    wrapper.unmount()
  })

  it('auto-reintento: re-sonda cada ~5s, máximo ~6 intentos, y luego para', async () => {
    const fetchMock = vi.fn(async (url: string, init?: any) => {
      if (init?.method === 'POST' && String(url).endsWith('/key')) {
        return { ok: true, json: async () => ({ success: true, result: { status: 'discord-closed' } }) }
      }
      return { ok: true, json: async () => ({ ...discordBundle, configured: true, discordStatus: 'authorized' }) }
    })
    globalThis.fetch = fetchMock as any
    const wrapper = mount(PluginSettingsDialog, { props: { apiBase: 'http://localhost:3001/api/v1' } })
    stubDialog(wrapper.find('dialog').element as HTMLDialogElement)
    await (wrapper.vm as any).show('discord')
    await flushPromises()
    const keyCalls = () => fetchMock.mock.calls.filter(([u, i]) => i?.method === 'POST' && String(u).endsWith('/key')).length
    expect(keyCalls()).toBe(1)
    expect(wrapper.find('[data-cy="bd-discord-autoretry"]').exists()).toBe(true)
    // Re-sonda visible en vuelo durante el reintento.
    for (let i = 0; i < 6; i += 1) {
      await vi.advanceTimersByTimeAsync(5000)
      await flushPromises()
    }
    expect(keyCalls()).toBe(7)
    // Tras el máximo, para aunque siga cerrado.
    await vi.advanceTimersByTimeAsync(30000)
    await flushPromises()
    expect(keyCalls()).toBe(7)
    expect(wrapper.find('[data-cy="bd-discord-autoretry"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('auto-reintento: para en cuanto conecta', async () => {
    let n = 0
    const fetchMock = vi.fn(async (url: string, init?: any) => {
      if (init?.method === 'POST' && String(url).endsWith('/key')) {
        n += 1
        return { ok: true, json: async () => ({ success: true, result: { status: n < 2 ? 'discord-closed' : 'connected' } }) }
      }
      return { ok: true, json: async () => ({ ...discordBundle, configured: true, discordStatus: 'authorized' }) }
    })
    globalThis.fetch = fetchMock as any
    const wrapper = mount(PluginSettingsDialog, { props: { apiBase: 'http://localhost:3001/api/v1' } })
    stubDialog(wrapper.find('dialog').element as HTMLDialogElement)
    await (wrapper.vm as any).show('discord')
    await flushPromises()
    expect(wrapper.find('[data-cy="bd-discord-autoretry"]').exists()).toBe(true)
    await vi.advanceTimersByTimeAsync(5000)
    await flushPromises()
    expect(wrapper.find('[data-cy="bd-oauth-status"]').exists()).toBe(true)
    expect(wrapper.find('[data-cy="bd-discord-autoretry"]').exists()).toBe(false)
    const keyCalls = () => fetchMock.mock.calls.filter(([u, i]) => i?.method === 'POST' && String(u).endsWith('/key')).length
    const after = keyCalls()
    await vi.advanceTimersByTimeAsync(30000)
    await flushPromises()
    expect(keyCalls()).toBe(after)
    wrapper.unmount()
  })

  it('volver el foco a la ventana re-sonda (el token pudo llegar por la pestaña del callback)', async () => {
    const fetchMock = vi.fn(async (url: string, init?: any) => {
      if (init?.method === 'POST' && String(url).endsWith('/key')) {
        return { ok: true, json: async () => ({ success: true, result: { status: 'discord-closed' } }) }
      }
      return { ok: true, json: async () => ({ ...discordBundle, configured: true, discordStatus: 'authorized' }) }
    })
    globalThis.fetch = fetchMock as any
    const wrapper = mount(PluginSettingsDialog, { props: { apiBase: 'http://localhost:3001/api/v1' } })
    stubDialog(wrapper.find('dialog').element as HTMLDialogElement)
    await (wrapper.vm as any).show('discord')
    await flushPromises()
    const before = fetchMock.mock.calls.filter(([u, i]) => i?.method === 'POST' && String(u).endsWith('/key')).length
    window.dispatchEvent(new Event('focus'))
    await flushPromises()
    const after = fetchMock.mock.calls.filter(([u, i]) => i?.method === 'POST' && String(u).endsWith('/key')).length
    expect(after).toBeGreaterThan(before)
    wrapper.unmount()
  })
})
