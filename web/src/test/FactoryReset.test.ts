import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import FactoryResetSection from '../components/bundeck/FactoryResetSection.vue'
import { FACTORY_RESET_STORAGE_KEYS } from '../composables/useFactoryReset'

vi.mock('../composables/useI18n', () => ({
  useI18nStore: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      if (params && typeof params.msg !== 'undefined') return `${key}:${params.msg}`
      return key
    },
    currentLocale: { value: 'es' },
    setLocale: () => {},
    loadSavedLocale: () => {},
  }),
}))

const API = 'http://localhost:3001/api/v1'

const okJson = (body: unknown, status = 200) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }) as Response

describe('FactoryResetSection', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    localStorage.clear()
  })

  it('muestra el botón y mantiene oculta la confirmación', () => {
    const wrapper = mount(FactoryResetSection, { props: { apiBase: API } })
    expect(wrapper.find('[data-cy="bd-reset-open"]').exists()).toBe(true)
    expect(wrapper.find('[data-cy="bd-reset-confirm-box"]').exists()).toBe(false)
  })

  it('la confirmación exige el check de aviso antes de borrar', async () => {
    const fetchMock = vi.fn(async () => okJson({ success: true }))
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = mount(FactoryResetSection, { props: { apiBase: API } })

    await wrapper.find('[data-cy="bd-reset-open"]').trigger('click')
    const box = wrapper.find('[data-cy="bd-reset-confirm-box"]')
    expect(box.exists()).toBe(true)
    expect(box.text()).toContain('bd.resetConfirmTitle')
    expect(box.text()).toContain('bd.resetConfirmBody')

    const confirm = wrapper.find('[data-cy="bd-reset-confirm"]')
    // Doble confirmación: sin el check no se puede confirmar.
    expect((confirm.element as HTMLButtonElement).disabled).toBe(true)
    await wrapper.find('[data-cy="bd-reset-ack"]').setValue(true)
    expect((wrapper.find('[data-cy="bd-reset-confirm"]').element as HTMLButtonElement).disabled).toBe(false)

    await wrapper.find('[data-cy="bd-reset-confirm"]').trigger('click')
    await flushPromises()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { method?: string; body?: string }]
    expect(url).toBe(`${API}/admin/reset`)
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body ?? '')).toEqual({ confirm: true })
  })

  it('tras el reset limpia localStorage, notifica y emite reset-done', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okJson({ success: true, reset: true })))
    for (const k of FACTORY_RESET_STORAGE_KEYS) localStorage.setItem(k, 'x')
    localStorage.setItem('otra-clave', 'se-queda')

    const wrapper = mount(FactoryResetSection, { props: { apiBase: API } })
    await wrapper.find('[data-cy="bd-reset-open"]').trigger('click')
    await wrapper.find('[data-cy="bd-reset-ack"]').setValue(true)
    await wrapper.find('[data-cy="bd-reset-confirm"]').trigger('click')
    await flushPromises()

    for (const k of FACTORY_RESET_STORAGE_KEYS) {
      expect(localStorage.getItem(k)).toBeNull()
    }
    expect(localStorage.getItem('otra-clave')).toBe('se-queda')
    expect(wrapper.emitted('notify')?.[0]).toEqual(['bd.resetDone'])
    expect(wrapper.emitted('reset-done')).toHaveLength(1)
    // La caja se cierra al terminar.
    expect(wrapper.find('[data-cy="bd-reset-confirm-box"]').exists()).toBe(false)
  })

  it('si el daemon rechaza, muestra el error y no emite reset-done', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okJson({ error: 'Confirmación requerida' }, 400)))
    const wrapper = mount(FactoryResetSection, { props: { apiBase: API } })
    await wrapper.find('[data-cy="bd-reset-open"]').trigger('click')
    await wrapper.find('[data-cy="bd-reset-ack"]').setValue(true)
    await wrapper.find('[data-cy="bd-reset-confirm"]').trigger('click')
    await flushPromises()

    const err = wrapper.find('[data-cy="bd-reset-error"]')
    expect(err.exists()).toBe(true)
    expect(err.text()).toContain('Confirmación requerida')
    expect(wrapper.emitted('reset-done')).toBeUndefined()
    expect(wrapper.emitted('notify')).toBeUndefined()
  })

  it('cancelar cierra la confirmación sin llamar al daemon', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = mount(FactoryResetSection, { props: { apiBase: API } })
    await wrapper.find('[data-cy="bd-reset-open"]').trigger('click')
    await wrapper.find('[data-cy="bd-reset-cancel"]').trigger('click')
    expect(wrapper.find('[data-cy="bd-reset-confirm-box"]').exists()).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('ofrece descargar la copia antes de borrar', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ format: 'x' }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const createObjectURL = vi.fn(() => 'blob:fake')
    const revokeObjectURL = vi.fn()
    const origCreate = URL.createObjectURL
    const origRevoke = URL.revokeObjectURL
    URL.createObjectURL = createObjectURL as unknown as typeof URL.createObjectURL
    URL.revokeObjectURL = revokeObjectURL
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    try {
      const wrapper = mount(FactoryResetSection, { props: { apiBase: API } })
      await wrapper.find('[data-cy="bd-reset-open"]').trigger('click')
      await wrapper.find('[data-cy="bd-reset-download"]').trigger('click')
      await flushPromises()

      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect((fetchMock.mock.calls[0] as unknown[])?.[0]).toBe(`${API}/backups/export`)
      expect(clickSpy).toHaveBeenCalled()
      expect(wrapper.emitted('notify')?.[0]).toEqual(['bd.backupExported'])
      // Descargar no borra: la confirmación sigue abierta.
      expect(wrapper.find('[data-cy="bd-reset-confirm-box"]').exists()).toBe(true)
    } finally {
      URL.createObjectURL = origCreate
      URL.revokeObjectURL = origRevoke
      clickSpy.mockRestore()
    }
  })
})
