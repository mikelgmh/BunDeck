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

  it('sin autorizar: muestra "no conectado" + Autorizar (sin ✓ mentiroso)', async () => {
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
    expect(wrapper.find('[data-cy="bd-oauth-connect"]').text()).toContain('bd.discordConnect')
  })

  it('autorizado + RPC en vivo: muestra ✓ + Reautorizar', async () => {
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
    expect(wrapper.find('[data-cy="bd-oauth-connect"]').text()).toContain('bd.discordReconnect')
  })

  it('token caducado: mensaje accionable + Reautorizar', async () => {
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
    expect(wrapper.find('[data-cy="bd-discord-state"]').text()).toContain('bd.discordExpired')
    expect(wrapper.find('[data-cy="bd-oauth-connect"]').text()).toContain('bd.discordReconnect')
  })

  it('Discord cerrado: aviso ámbar autorizado + Reintentar sonda (sin ✓, sin Reintentar entrega)', async () => {
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
    // Botón Reintentar sonda: re-sonda sin re-autorizar.
    expect(wrapper.find('[data-cy="bd-discord-retry"]').exists()).toBe(true)
  })

  it('autorizado con sonda desconocida: ámbar "Autorizado" + Reintentar (nunca ✓ mentiroso)', async () => {
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
    expect(wrapper.find('[data-cy="bd-discord-retry"]').exists()).toBe(true)
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
  })

  it('Reintentar sonda vuelve a llamar a la sonda en vivo', async () => {
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
    await wrapper.find('[data-cy="bd-discord-retry"]').trigger('click')
    await flushPromises()
    const after = fetchMock.mock.calls.filter(([u, i]) => i?.method === 'POST' && String(u).endsWith('/key')).length
    expect(after).toBeGreaterThan(before)
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
  })
})
