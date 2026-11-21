import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import PluginCatalog from '../components/bundeck/PluginCatalog.vue'

// Mock del store i18n (mismo patrón que ButtonEditor.test.ts)
vi.mock('../composables/useI18n', () => ({
  useI18nStore: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      if (!params) return key
      return `${key} ${JSON.stringify(params)}`
    },
  }),
}))

const CATALOG = {
  version: '0.1.0',
  generatedAt: 123,
  total: 3,
  plugins: [
    {
      id: 'obs',
      name: 'OBS Studio',
      version: '1.0.0',
      description: 'Controla escenas y directo',
      author: 'BunDeck',
      category: 'integrations',
      type: 'builtin',
      permissions: ['network'],
      actions: [{ id: 'scene', name: 'Cambiar de escena', description: 'Cambia la escena' }],
      compatibility: { os: ['win32', 'linux', 'darwin'], minVersion: '0.0.0' },
      keywords: ['obs', 'escena'],
      checksum: 'a'.repeat(64),
      compatible: true,
      installed: true,
      enabled: true,
      installedVersion: '1.0.0',
    },
    {
      id: 'shell',
      name: 'Shell Commands',
      version: '1.0.0',
      description: 'Ejecuta comandos del sistema',
      author: 'BunDeck',
      category: 'system',
      type: 'builtin',
      permissions: ['shell'],
      actions: [{ id: 'shell', name: 'Ejecutar', description: 'Ejecuta un comando' }],
      compatibility: { os: ['win32', 'linux', 'darwin'], minVersion: '0.0.0' },
      keywords: ['shell'],
      checksum: 'b'.repeat(64),
      compatible: true,
      installed: true,
      enabled: false,
      installedVersion: '1.0.0',
    },
    {
      id: 'future',
      name: 'Future Plugin',
      version: '9.9.9',
      description: 'Requiere app nueva',
      author: 'BunDeck',
      category: 'system',
      type: 'builtin',
      permissions: [],
      actions: [{ id: 'x', name: 'X', description: 'x' }],
      compatibility: { os: ['win32'], minVersion: '99.0.0' },
      keywords: ['future'],
      checksum: 'c'.repeat(64),
      compatible: false,
      installed: false,
      enabled: false,
      installedVersion: null,
    },
  ],
}

const mountCatalog = (props: Record<string, unknown> = {}) =>
  mount(PluginCatalog, {
    props: { apiBase: 'http://localhost:3001/api/v1', detailed: [], ...props },
  })

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, json: async () => CATALOG }))
  )
})

describe('PluginCatalog', () => {
  it('carga el catálogo desde /catalog y lista los plugins', async () => {
    const wrapper = mountCatalog()
    await flushPromises()
    expect(fetch).toHaveBeenCalledWith(
      'http://localhost:3001/api/v1/catalog',
      expect.objectContaining({})
    )
    const items = wrapper.findAll('[data-cy="bd-catalog-item"]')
    expect(items).toHaveLength(3)
    expect(wrapper.text()).toContain('OBS Studio')
  })

  it('filtra por búsqueda local (nombre y acción)', async () => {
    const wrapper = mountCatalog()
    await flushPromises()
    await wrapper.find('[data-cy="bd-catalog-search"]').setValue('escena')
    expect(wrapper.findAll('[data-cy="bd-catalog-item"]')).toHaveLength(1)
    expect(wrapper.text()).toContain('OBS Studio')
  })

  it('filtra por categoría', async () => {
    const wrapper = mountCatalog()
    await flushPromises()
    await wrapper.find('[data-cy="bd-catalog-category"]').setValue('system')
    const items = wrapper.findAll('[data-cy="bd-catalog-item"]')
    expect(items).toHaveLength(2)
  })

  it('el filtro "solo compatibles" oculta el plugin incompatible', async () => {
    const wrapper = mountCatalog()
    await flushPromises()
    await wrapper.find('[data-cy="bd-catalog-compatible"]').setChecked(true)
    const items = wrapper.findAll('[data-cy="bd-catalog-item"]')
    expect(items).toHaveLength(2)
    expect(wrapper.text()).not.toContain('Future Plugin')
  })

  it('muestra badges instalado/compatible y emite toggle-plugin al activar', async () => {
    const wrapper = mountCatalog()
    await flushPromises()
    expect(wrapper.find('[data-cy="bd-catalog-installed"]').exists()).toBe(true)
    expect(wrapper.find('[data-cy="bd-catalog-compat-no"]').exists()).toBe(true)
    await wrapper.find('[data-cy="bd-catalog-toggle-shell"]').trigger('click')
    expect(wrapper.emitted('toggle-plugin')).toEqual([['shell', true]])
  })

  it('muestra error y reintenta si el fetch falla', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 500 }))
    )
    const wrapper = mountCatalog()
    await flushPromises()
    expect(wrapper.text()).toContain('bd.catalogLoadError')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => CATALOG }))
    )
    await wrapper.find('[data-cy="bd-catalog-retry"]').trigger('click')
    await flushPromises()
    expect(wrapper.findAll('[data-cy="bd-catalog-item"]')).toHaveLength(3)
  })
})
