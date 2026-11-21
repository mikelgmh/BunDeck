import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import TitleBar from '../components/bundeck/TitleBar.vue'

vi.mock('../composables/useI18n', () => ({
  useI18nStore: () => ({
    t: (key: string) => key,
    currentLocale: { value: 'es' },
    setLocale: () => {},
    loadSavedLocale: () => {},
  }),
}))

describe('TitleBar', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it('no renderiza nada en navegador (sin launcher API)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('no host')
    }))
    const wrapper = mount(TitleBar)
    await flushPromises()
    expect(wrapper.find('.bd-titlebar').exists()).toBe(false)
  })

  it('renderiza min/max/close en Electrobun y llama a la API', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url)
      calls.push(`${init?.method ?? 'GET'} ${u}`)
      if (u.endsWith('/window-state')) {
        return { ok: true, json: async () => ({ ok: true, maximized: false }) }
      }
      if (u.endsWith('/window-toggle-maximize')) {
        return { ok: true, json: async () => ({ ok: true, maximized: true }) }
      }
      return { ok: true, json: async () => ({ ok: true }) }
    }))
    const wrapper = mount(TitleBar)
    await flushPromises()
    expect(wrapper.find('.bd-titlebar').exists()).toBe(true)
    expect(wrapper.find('[data-cy="bd-win-min"]').exists()).toBe(true)
    expect(wrapper.find('[data-cy="bd-win-max"]').exists()).toBe(true)
    expect(wrapper.find('[data-cy="bd-win-close"]').exists()).toBe(true)

    await wrapper.find('[data-cy="bd-win-min"]').trigger('click')
    await wrapper.find('[data-cy="bd-win-max"]').trigger('click')
    await wrapper.find('[data-cy="bd-win-close"]').trigger('click')
    await flushPromises()

    expect(calls.some((c) => c.includes('/window-minimize'))).toBe(true)
    expect(calls.some((c) => c.includes('/window-toggle-maximize'))).toBe(true)
    expect(calls.some((c) => c.includes('/window-close'))).toBe(true)
  })
})
