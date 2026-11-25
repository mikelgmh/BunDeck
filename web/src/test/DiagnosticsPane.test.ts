import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import DiagnosticsPane from '../components/bundeck/DiagnosticsPane.vue'

vi.mock('../composables/useI18n', () => ({
  useI18nStore: () => ({ t: (key: string) => String(key) }),
}))

vi.mock('../composables/useTunnel', () => ({
  isTunnelMode: () => false,
}))

const LOG_ROWS = [
  { id: 1, level: 'info', message: 'Action started: discord.toggle-mute', ts: 1000 },
  { id: 2, level: 'error', message: 'Action failed: discord.toggle-mute', ts: 1500 },
]

const PRESS_ITEMS = [
  {
    id: 'p1', ts: 2000, buttonId: 'b1', actionType: 'discord.toggle-mute',
    success: true, error: null, pressType: 'short', deviceName: 'Deck', source: 'web',
  },
  {
    id: 'p2', ts: 2500, buttonId: 'b1', actionType: 'discord.toggle-mute',
    success: false, error: 'Discord cerrado', pressType: 'short', deviceName: 'Deck', source: 'streamdeck',
  },
]

let lastUrls: string[] = []

const fetchMock = vi.fn(async (url: string) => {
  lastUrls.push(String(url))
  const u = String(url)
  if (u.includes('/press-logs')) {
    return { ok: true, status: 200, json: async () => ({ items: PRESS_ITEMS, total: 2 }) } as any
  }
  if (u.includes('/logs')) {
    return { ok: true, status: 200, json: async () => LOG_ROWS } as any
  }
  // Sondas de servicios del refresh inicial.
  return { ok: true, status: 200, json: async () => ({}) } as any
})

beforeEach(() => {
  lastUrls = []
  fetchMock.mockClear()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const mountPane = () => mount(DiagnosticsPane, {
  props: { apiBase: 'http://localhost:3001/api/v1' },
})

describe('DiagnosticsPane: Registros muestran actividad real', () => {
  it('fusiona /logs con /press-logs (web y HW) ordenados por fecha', async () => {
    const wrapper = mountPane()
    await flushPromises()
    await flushPromises()

    expect(lastUrls.some((u) => u.includes('/press-logs'))).toBe(true)
    const rows = wrapper.findAll('[data-cy="diagnostics-log"]')
    expect(rows).toHaveLength(4)
    // La más reciente primero: la pulsación HW fallida.
    expect(rows[0].text()).toContain('FALLO: Discord cerrado')
    expect(rows[0].text()).toContain('discord.toggle-mute')
    expect(rows[0].text()).toContain('Deck')
    expect(wrapper.text()).toContain('Action started: discord.toggle-mute')
    wrapper.unmount()
  })

  it('respeta el filtro de nivel sin ocultar todo por defecto', async () => {
    const wrapper = mountPane()
    await flushPromises()
    await flushPromises()

    // Por defecto (sin filtro): todo visible.
    expect(wrapper.findAll('[data-cy="diagnostics-log"]')).toHaveLength(4)

    // Filtrar por error: solo el log error + la pulsación fallida.
    await wrapper.find('[data-cy="diagnostics-level"]').setValue('error')
    await flushPromises()
    const rows = wrapper.findAll('[data-cy="diagnostics-log"]')
    expect(rows).toHaveLength(2)
    expect(rows[0].text()).toContain('FALLO')
    expect(wrapper.text()).toContain('Action failed')
    wrapper.unmount()
  })

  it('antepone log.created en vivo (cliente suscrito al tópico logs)', async () => {
    const wrapper = mountPane()
    await flushPromises()
    await flushPromises()
    expect(wrapper.findAll('[data-cy="diagnostics-log"]')).toHaveLength(4)

    window.dispatchEvent(new CustomEvent('libredeck:log-created', {
      detail: { level: 'warn', message: 'Botón b9 (web/short): pulsación ejecutada', ts: 9999 },
    }))
    await flushPromises()

    const rows = wrapper.findAll('[data-cy="diagnostics-log"]')
    expect(rows).toHaveLength(5)
    expect(rows[0].text()).toContain('Botón b9')
    wrapper.unmount()
  })

  it('sin press-logs (daemon antiguo) sigue mostrando /logs', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = String(url)
      if (u.includes('/press-logs')) return { ok: false, status: 404, json: async () => ({}) } as any
      if (u.includes('/logs')) return { ok: true, status: 200, json: async () => LOG_ROWS } as any
      return { ok: true, status: 200, json: async () => ({}) } as any
    }) as any)
    const wrapper = mountPane()
    await flushPromises()
    await flushPromises()
    expect(wrapper.findAll('[data-cy="diagnostics-log"]')).toHaveLength(2)
    wrapper.unmount()
  })
})
