import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import PressLogsDialog from '../components/bundeck/PressLogsDialog.vue'
import esLocale from '../i18n/locales/es.json'

vi.mock('../composables/useI18n', () => ({
  useI18nStore: () => ({
    // Lookup real en es.json con interpolación {x}, como el composable.
    t: (key: string, params?: Record<string, unknown>) => {
      const parts = String(key).split('.')
      let cur: unknown = esLocale
      for (const p of parts) cur = (cur as any)?.[p]
      let s = typeof cur === 'string' ? cur : String(key)
      if (params) for (const [k, v] of Object.entries(params)) s = s.replace(`{${k}}`, String(v))
      return s
    },
  }),
}))

// jsdom no implementa showModal/close de <dialog>: stub.
function stubDialog(el: HTMLDialogElement | null) {
  if (!el) return
  ;(el as any).showModal = vi.fn()
  ;(el as any).close = vi.fn()
}

const LOG_A = {
  id: 'l1', ts: 1764000000000, buttonId: 'b1', position: 0,
  pressType: 'click', deviceId: 'dev-1234567890', deviceName: 'Panel',
  source: 'web', actionType: 'shell.exec', success: true, error: null, durationMs: 12,
}
const LOG_B = {
  id: 'l2', ts: 1764000001000, buttonId: 'b1', position: 0,
  pressType: 'long', deviceId: 'dev-999', deviceName: null,
  source: 'web', actionType: 'http.get', success: false, error: 'timeout', durationMs: 3001,
}
const LOG_C = {
  id: 'l3', ts: 1764000002000, buttonId: 'b2', position: 1,
  pressType: 'click', deviceId: 'dev-1234567890', deviceName: 'Panel',
  source: 'mobile', actionType: 'shell.exec', success: true, error: null, durationMs: 9,
}

let lastUrls: string[] = []
let lastInits: Array<RequestInit | undefined> = []
let getPayload: any = { items: [LOG_A, LOG_B], total: 2 }
let deletePayload: any = { deleted: 2 }

const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
  lastUrls.push(String(url))
  lastInits.push(init)
  if ((init?.method ?? 'GET') === 'DELETE') {
    return { ok: true, status: 200, json: async () => deletePayload } as any
  }
  return { ok: true, status: 200, json: async () => getPayload } as any
})

beforeEach(() => {
  lastUrls = []
  lastInits = []
  getPayload = { items: [LOG_A, LOG_B], total: 2 }
  deletePayload = { deleted: 2 }
  fetchMock.mockClear()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const mountDialog = (props: Record<string, unknown> = {}) => {
  const wrapper = mount(PressLogsDialog, {
    props: { apiBase: 'http://localhost:3001/api/v1', ...props },
  })
  stubDialog(wrapper.find('dialog').element as HTMLDialogElement)
  return wrapper
}

describe('PressLogsDialog', () => {
  it('lista los registros del botón con sus columnas', async () => {
    const wrapper = mountDialog({ buttonId: 'b1', buttonLabel: 'Mi tecla' })
    await (wrapper.vm as any).show()
    await flushPromises()

    expect(lastUrls[0]).toContain('/buttons/b1/logs')
    const rows = wrapper.findAll('[data-cy="bd-press-log-item"]')
    expect(rows).toHaveLength(2)
    // Fecha, dispositivo (nombre o id corto), acción, OK/error, duración.
    expect(rows[0].text()).toContain('Panel')
    expect(rows[0].text()).toContain('shell.exec')
    expect(rows[0].text()).toContain('OK')
    expect(rows[0].text()).toContain('12')
    expect(rows[1].text()).toContain('dev-999')
    expect(rows[1].text()).toContain('timeout')
    // Título con el nombre de la tecla.
    expect(wrapper.text()).toContain('Mi tecla')
    wrapper.unmount()
  })

  it('muestra el estado vacío', async () => {
    getPayload = { items: [], total: 0 }
    const wrapper = mountDialog({ buttonId: 'b1' })
    await (wrapper.vm as any).show()
    await flushPromises()

    expect(wrapper.findAll('[data-cy="bd-press-log-item"]')).toHaveLength(0)
    expect(wrapper.text()).toContain('Sin registros todavía')
    wrapper.unmount()
  })

  it('envía los filtros en la query', async () => {
    const wrapper = mountDialog({ buttonId: 'b1' })
    await (wrapper.vm as any).show()
    await flushPromises()

    const selects = wrapper.findAll('select')
    // Orden: pressType, success, limit.
    await selects[0].setValue('long')
    await flushPromises()
    await selects[1].setValue('false')
    await flushPromises()

    const device = wrapper.find('input[type="text"]')
    await device.setValue('dev-999')
    await (device.element as HTMLInputElement & { value: string }).value
    await device.trigger('change')
    await flushPromises()

    const last = lastUrls[lastUrls.length - 1]
    expect(last).toContain('pressType=long')
    expect(last).toContain('success=false')
    expect(last).toContain('deviceId=dev-999')
    wrapper.unmount()
  })

  it('pagina con anterior/siguiente usando offset y muestra el indicador', async () => {
    const page1 = Array.from({ length: 50 }, (_, i) => ({ ...LOG_A, id: `p1-${i}`, ts: 1764000000000 + i }))
    const page2 = [{ ...LOG_C, ts: 1764000099999 }]
    getPayload = { items: page1, total: 120 }
    const wrapper = mountDialog({ actionType: 'shell.exec' })
    await (wrapper.vm as any).show()
    await flushPromises()

    expect(lastUrls[0]).toContain('/actions/logs')
    expect(lastUrls[0]).toContain('actionType=shell.exec')
    expect(lastUrls[0]).toContain('offset=0')
    // Título de acción con el tipo.
    expect(wrapper.text()).toContain('shell.exec')
    // Indicador de página: 1 de 3 (120 / 50).
    expect(wrapper.find('[data-cy="bd-press-logs-page"]').text()).toContain('120')
    expect(wrapper.find('[data-cy="bd-press-logs-prev"]').attributes('disabled')).toBeDefined()

    // Siguiente pide la página 1 (offset=limit 50).
    getPayload = { items: page2, total: 120 }
    await wrapper.find('[data-cy="bd-press-logs-next"]').trigger('click')
    await flushPromises()

    expect(lastUrls[lastUrls.length - 1]).toContain('offset=50')
    expect(wrapper.findAll('[data-cy="bd-press-log-item"]')).toHaveLength(1)

    // Anterior vuelve a la página 0.
    getPayload = { items: page1, total: 120 }
    await wrapper.find('[data-cy="bd-press-logs-prev"]').trigger('click')
    await flushPromises()

    expect(lastUrls[lastUrls.length - 1]).toContain('offset=0')
    expect(wrapper.findAll('[data-cy="bd-press-log-item"]')).toHaveLength(50)
    wrapper.unmount()
  })

  it('cambiar el límite reinicia a la primera página', async () => {
    getPayload = { items: [LOG_A, LOG_B], total: 3 }
    const wrapper = mountDialog({ buttonId: 'b1' })
    await (wrapper.vm as any).show()
    await flushPromises()

    const limitSel = wrapper.find('[data-cy="bd-press-logs-limit"]')
    await limitSel.setValue('20')
    await flushPromises()

    const last = lastUrls[lastUrls.length - 1]
    expect(last).toContain('limit=20')
    expect(last).toContain('offset=0')
    wrapper.unmount()
  })

  it('limpiar pide confirmación y hace DELETE', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const wrapper = mountDialog({ buttonId: 'b1' })
    await (wrapper.vm as any).show()
    await flushPromises()

    getPayload = { items: [], total: 0 }
    await wrapper.find('[data-cy="bd-press-logs-clear"]').trigger('click')
    await flushPromises()

    expect(confirmSpy).toHaveBeenCalled()
    expect(lastInits.some((i) => i?.method === 'DELETE')).toBe(true)
    expect(lastUrls[lastUrls.length - 1]).toContain('/buttons/b1/logs')
    expect(wrapper.findAll('[data-cy="bd-press-log-item"]')).toHaveLength(0)
    wrapper.unmount()
  })

  it('sin confirmar no borra', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    const wrapper = mountDialog({ buttonId: 'b1' })
    await (wrapper.vm as any).show()
    await flushPromises()

    const calls = fetchMock.mock.calls.length
    await wrapper.find('[data-cy="bd-press-logs-clear"]').trigger('click')
    await flushPromises()

    expect(fetchMock.mock.calls.length).toBe(calls)
    expect(wrapper.findAll('[data-cy="bd-press-log-item"]')).toHaveLength(2)
    wrapper.unmount()
  })

  it('muestra el error HTTP sin romper', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 500, json: async () => ({ error: 'boom' }) }) as any)
    )
    const wrapper = mountDialog({ buttonId: 'b1' })
    await (wrapper.vm as any).show()
    await flushPromises()

    expect(wrapper.find('.bd-err').exists()).toBe(true)
    wrapper.unmount()
  })

  it('opciones de tipo canónicas (sin «click» legado) y botón Actualizar', async () => {
    const wrapper = mountDialog({ buttonId: 'b1' })
    await (wrapper.vm as any).show()
    await flushPromises()

    const typeSel = wrapper.find('[data-cy="bd-press-logs-filter-type"]')
    const values = typeSel.findAll('option').map((o) => (o.element as HTMLOptionElement).value)
    expect(values).toContain('short')
    expect(values).toContain('long')
    expect(values).not.toContain('click')
    // Sin duplicados en valores.
    expect(new Set(values).size).toBe(values.length)

    const calls = fetchMock.mock.calls.length
    await wrapper.find('[data-cy="bd-press-logs-refresh"]').trigger('click')
    await flushPromises()
    expect(fetchMock.mock.calls.length).toBeGreaterThan(calls)
    wrapper.unmount()
  })

  it('limpiar solo envía el ámbito (sin limit/offset/filtros de vista)', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const wrapper = mountDialog({ buttonId: 'b1' })
    await (wrapper.vm as any).show()
    await flushPromises()

    getPayload = { items: [], total: 0 }
    await wrapper.find('[data-cy="bd-press-logs-clear"]').trigger('click')
    await flushPromises()

    const dels = lastUrls.filter((u, i) => lastInits[i]?.method === 'DELETE')
    expect(dels).toHaveLength(1)
    expect(dels[0]).toContain('/buttons/b1/logs')
    expect(dels[0]).not.toMatch(/[?&](limit|offset|success|pressType|deviceId)=/)
    wrapper.unmount()
  })
})
