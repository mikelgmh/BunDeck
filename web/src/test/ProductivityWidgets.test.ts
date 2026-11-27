import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import CalendarAgenda from '../components/bundeck/widgets/CalendarAgenda.vue'
import PomodoroControl from '../components/bundeck/widgets/PomodoroControl.vue'
import StatusCards from '../components/bundeck/widgets/StatusCards.vue'
import { executeWidgetAction } from '../composables/useWidgetAction'
import { useI18nStore } from '../composables/useI18n'

vi.mock('../composables/useWidgetAction', () => ({
  executeWidgetAction: vi.fn(),
}))

const runAction = vi.mocked(executeWidgetAction)
const props = (type: string, parameters: Record<string, any> = {}) => ({
  action: { type, parameters },
  apiBase: 'http://localhost:3001',
})

describe('productivity and status widgets', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()
    useI18nStore().setLocale('es')
  })

  it('shows the next event countdown and opens the event through the action API', async () => {
    runAction.mockImplementation(async (_base, type) => type === 'calendar.next-event'
      ? { found: true, event: { summary: 'Design review', start: new Date(Date.now() + 3_600_000).toISOString(), url: 'https://example.test/event' } }
      : { opened: true })
    const wrapper = mount(CalendarAgenda, { props: props('calendar.next-event') })
    await flushPromises()
    expect(wrapper.text()).toContain('Design review')
    expect(wrapper.text()).toContain('En 1h')
    await wrapper.get('button.open').trigger('click')
    await flushPromises()
    expect(runAction).toHaveBeenCalledWith('http://localhost:3001', 'calendar.open-event', {
      url: 'https://example.test/event',
    })
    wrapper.unmount()
  })

  it('polls timer status and starts focus using the existing timer actions', async () => {
    runAction.mockImplementation(async (_base, type) => {
      if (type === 'timer.status') return { status: 'idle', mode: 'work', remainingMs: 0, totalMs: 1_500_000 }
      if (type === 'timer.start') return { started: true }
      return { status: 'running', mode: 'work', remainingMs: 1_500_000, totalMs: 1_500_000 }
    })
    const wrapper = mount(PomodoroControl, { props: props('timer.status') })
    await flushPromises()
    await wrapper.get('button.start').trigger('click')
    await flushPromises()
    expect(runAction).toHaveBeenCalledWith('http://localhost:3001', 'timer.start', { mode: 'work' })
    expect(runAction).toHaveBeenCalledWith('http://localhost:3001', 'timer.status', {})
    wrapper.unmount()
  })

  it('does not automatically capture a webcam image and reports manual capture success', async () => {
    runAction.mockResolvedValue({ saved: true, outputPath: 'private/local/path.jpg' })
    const wrapper = mount(StatusCards, { props: props('webcam.snapshot') })
    await flushPromises()
    expect(runAction).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('Capturar foto')
    await wrapper.get('.action-button').trigger('click')
    await flushPromises()
    expect(runAction).toHaveBeenCalledWith('http://localhost:3001', 'webcam.snapshot', {})
    expect(wrapper.text()).toContain('Foto capturada')
    expect(wrapper.text()).not.toContain('private/local/path.jpg')
    wrapper.unmount()
  })

  it('renders the ActionResult payload for the PC summary', async () => {
    runAction.mockResolvedValue({
      cpu: 42,
      ram: 61,
      gpu: { usage: 18, temperature: 54 },
      disk: { value: 70 },
      uptime: { human: '2d 3h' },
      monitored: true,
    })
    const wrapper = mount(StatusCards, { props: props('pc-vitals.summary') })
    await flushPromises()

    expect(wrapper.text()).toContain('42%')
    expect(wrapper.text()).toContain('61%')
    expect(wrapper.text()).toContain('18%')
    expect(wrapper.text()).toContain('2d 3h')
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('shows ActionRunner errors inside the status card', async () => {
    runAction.mockRejectedValue(new Error('Action is already running'))
    const wrapper = mount(StatusCards, { props: props('pc-vitals.summary') })
    await flushPromises()

    expect(wrapper.get('[role="alert"]').text()).toContain('Action is already running')
    wrapper.unmount()
  })

  it('uses local English copy when the app locale is English', async () => {
    const i18n = useI18nStore()
    i18n.setLocale('en')
    runAction.mockImplementation(async (_base, type) => {
      if (type === 'calendar.next-event') return { found: false }
      if (type === 'timer.status') return { status: 'idle', mode: 'work', remainingMs: 0, totalMs: 1_500_000 }
      return { saved: true }
    })
    const calendar = mount(CalendarAgenda, { props: props('calendar.next-event') })
    const timer = mount(PomodoroControl, { props: props('timer.status') })
    const webcam = mount(StatusCards, { props: props('webcam.snapshot') })
    await flushPromises()
    expect(calendar.text()).toContain('No upcoming events')
    expect(timer.text()).toContain('FOCUS TIMER')
    expect(timer.text()).toContain('Focus')
    expect(webcam.text()).toContain('Camera snapshot')
    expect(webcam.text()).toContain('Capture photo')
    calendar.unmount()
    timer.unmount()
    webcam.unmount()
    i18n.setLocale('es')
  })

  it('shows an accessible error instead of an empty calendar when loading fails', async () => {
    runAction.mockRejectedValue(new Error('Calendar is not configured'))
    const wrapper = mount(CalendarAgenda, { props: props('calendar.next-event') })
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain('Calendar is not configured')
    expect(wrapper.text()).not.toContain('No upcoming events')
    wrapper.unmount()
  })

  it('shows NeedsConfig when the calendar has no source and the load fails', async () => {
    runAction.mockRejectedValue(new Error('Sin fuente de calendario'))
    const bare = mount(CalendarAgenda, { props: props('calendar.next-event') })
    await flushPromises()
    expect(bare.find('[data-cy="bd-needs-config"]').exists()).toBe(true)
    bare.unmount()
    const withIcs = mount(CalendarAgenda, { props: props('calendar.next-event', { icsPath: '/tmp/cal.ics' }) })
    await flushPromises()
    expect(withIcs.find('[data-cy="bd-needs-config"]').exists()).toBe(false)
    withIcs.unmount()
  })

  it('hides NeedsConfig after a successful calendar load even without params', async () => {
    runAction.mockResolvedValue({ found: false })
    const wrapper = mount(CalendarAgenda, { props: props('calendar.next-event') })
    await flushPromises()
    expect(wrapper.find('[data-cy="bd-needs-config"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('No hay próximos eventos')
    wrapper.unmount()
  })

  it('never asks for configuration on the timer (status needs no params)', async () => {
    runAction.mockResolvedValue({ status: 'idle', mode: 'work', remainingMs: 0, totalMs: 1_500_000 })
    const wrapper = mount(PomodoroControl, { props: props('timer.status') })
    await flushPromises()
    expect(wrapper.find('[data-cy="bd-needs-config"]').exists()).toBe(false)
    wrapper.unmount()
  })
})

describe('status cards responsive contract', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('pide configuración sin host en minecraft y sin métrica en monitor', async () => {
    runAction.mockResolvedValue({ online: true })
    const missing = mount(StatusCards, { props: props('minecraft.server-status') })
    await flushPromises()
    expect(missing.find('[data-cy="bd-needs-config"]').exists()).toBe(true)
    const ok = mount(StatusCards, { props: props('minecraft.server-status', { host: 'hypixel.net' }) })
    await flushPromises()
    expect(ok.find('[data-cy="bd-needs-config"]').exists()).toBe(false)
    const monitorMissing = mount(StatusCards, { props: props('pc-vitals.monitor') })
    await flushPromises()
    expect(monitorMissing.find('[data-cy="bd-needs-config"]').exists()).toBe(true)
    const monitorOk = mount(StatusCards, { props: props('pc-vitals.monitor', { component: 'cpu', metric: 'usage' }) })
    await flushPromises()
    expect(monitorOk.find('[data-cy="bd-needs-config"]').exists()).toBe(false)
    missing.unmount()
    ok.unmount()
    monitorMissing.unmount()
    monitorOk.unmount()
  })

  it('NeedsConfig abre el drawer con tipo y posición', async () => {
    runAction.mockResolvedValue({})
    const seen: any[] = []
    const onEvent = (e: Event) => {
      seen.push((e as CustomEvent).detail)
      e.preventDefault()
    }
    window.addEventListener('bundeck:open-action-settings', onEvent as EventListener)
    try {
      const wrapper = mount(StatusCards, { props: { ...props('steam.server-status'), position: 4 } })
      await flushPromises()
      expect(wrapper.find('[data-cy="bd-needs-config"]').exists()).toBe(true)
      await wrapper.get('[data-cy="bd-needs-config"]').trigger('click')
      expect(seen).toEqual([{ actionType: 'steam.server-status', position: 4 }])
      wrapper.unmount()
    } finally {
      window.removeEventListener('bundeck:open-action-settings', onEvent as EventListener)
    }
  })

  it('el carrusel del summary rota métricas y respeta carouselMs 0', async () => {
    vi.useFakeTimers()
    runAction.mockResolvedValue({
      cpu: 42, ram: 61, gpu: { usage: 18 }, disk: { value: 70 }, uptime: { human: '2d 3h' }, monitored: true,
    })
    const wrapper = mount(StatusCards, { props: props('pc-vitals.summary') })
    await flushPromises()
    expect(wrapper.findAll('[data-cy="bd-carousel-dot"]')).toHaveLength(5)
    const hero = () => wrapper.find('.xs-carousel strong').text()
    expect(hero()).toContain('42')
    vi.advanceTimersByTime(4000)
    await flushPromises()
    expect(hero()).toContain('61')
    const off = mount(StatusCards, { props: props('pc-vitals.summary', { carouselMs: 0 }) })
    await flushPromises()
    const heroOff = () => off.find('.xs-carousel strong').text()
    expect(heroOff()).toContain('42')
    vi.advanceTimersByTime(12000)
    await flushPromises()
    expect(heroOff()).toContain('42')
    wrapper.unmount()
    off.unmount()
  })

  it('email.unread muestra la línea compacta con marquee y sin alerta', async () => {
    runAction.mockResolvedValue({ count: 5 })
    const wrapper = mount(StatusCards, { props: props('email.unread', { provider: 'gmail' }) })
    await flushPromises()
    expect(wrapper.find('.xs-line').text()).toContain('Sin leer · 5')
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('el error largo queda accesible con aviso corto neutro', async () => {
    runAction.mockRejectedValue(new Error('Fallo muy largo de la API que no debe pintar en rojo grande'))
    const wrapper = mount(StatusCards, { props: props('pc-vitals.summary') })
    await flushPromises()
    const alert = wrapper.get('[role="alert"]')
    expect(alert.text()).toContain('Fallo muy largo de la API')
    expect(alert.find('.err-short').text()).toBe('Error')
    wrapper.unmount()
  })
})
