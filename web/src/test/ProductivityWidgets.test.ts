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
})
