import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import WorkflowControl from '../components/bundeck/widgets/WorkflowControl.vue'
import { resolveCarouselMs } from '../composables/useAutoCarousel'
import { useI18nStore } from '../composables/useI18n'

describe('WorkflowControl', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    useI18nStore().setLocale('es')
  })

  it('uses Spanish by default and updates its local copy when the locale changes', async () => {
    const i18n = useI18nStore()
    i18n.setLocale('es')
    const wrapper = mount(WorkflowControl, {
      props: {
        action: { type: 'flow.set-var', parameters: { name: 'enabled', value: true } },
        apiBase: '',
      },
    })
    expect(wrapper.text()).toContain('Variable de flujo')
    expect(wrapper.text()).toContain('Fijar')

    i18n.setLocale('en')
    await flushPromises()
    expect(wrapper.text()).toContain('Flow variable')
    expect(wrapper.text()).toContain('Set')
    wrapper.unmount()
  })

  it('loads clipboard slots and invokes the official action with the chosen slot', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      requests.push({ url, init })
      const request = init?.body ? JSON.parse(String(init.body)) : null
      const result = request?.action?.type === 'clipboard.list-slots'
        ? { slots: [{ slot: 'Firma', preview: 'Un saludo', length: 9 }] }
        : request?.action?.type === 'clipboard.history'
          ? { entries: [] }
          : { pasted: true }
      return new Response(JSON.stringify({ success: true, result }), { status: 200 })
    }))

    const wrapper = mount(WorkflowControl, {
      props: {
        action: { type: 'clipboard.list-slots', parameters: {} },
        apiBase: 'http://localhost:3001',
      },
    })
    await flushPromises()

    const paste = wrapper.get('.m-plus-list button[aria-label="Copiar Firma al portapapeles"]')
    await paste.trigger('click')
    await flushPromises()

    const executeRequests = requests.filter(r => r.url.endsWith('/api/v1/actions/execute'))
    const pasteCall = JSON.parse(String(executeRequests.at(-1)?.init?.body))
    expect(pasteCall).toEqual({
      action: { type: 'clipboard.paste-slot', parameters: { slot: 'Firma' } },
      context: { quiet: true, source: 'widget-control' },
    })
    expect(wrapper.text()).toContain('Firma')
    expect(wrapper.text()).toContain('listo para pegar')
    wrapper.unmount()
  })

  it('keeps workflow controls inert in read-only mode', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      success: true,
      result: { slots: [{ slot: 'Firma', preview: 'Un saludo', length: 9 }] },
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const wrapper = mount(WorkflowControl, {
      props: {
        action: { type: 'clipboard.list-slots', parameters: {} },
        apiBase: '',
        readonly: true,
      },
    })
    await flushPromises()
    expect(wrapper.get('.m-plus-list button[aria-label="Copiar Firma al portapapeles"]').element.disabled).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2) // list-slots + history
    wrapper.unmount()
  })

  it('shows NeedsConfig when the flow variable has no name', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })))
    const wrapper = mount(WorkflowControl, {
      props: { action: { type: 'flow.set-var', parameters: {} }, apiBase: '' },
    })
    await flushPromises()
    expect(wrapper.find('[data-cy="bd-needs-config"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('shows NeedsConfig for unconfigured OSC and sends when configured', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), init })
      return new Response(JSON.stringify({ success: true, result: { sent: true } }), { status: 200 })
    }))

    const missing = mount(WorkflowControl, {
      props: { action: { type: 'midi-osc.send-osc', parameters: {} }, apiBase: 'http://localhost:3001' },
    })
    await flushPromises()
    expect(missing.find('[data-cy="bd-needs-config"]').exists()).toBe(true)
    missing.unmount()

    const ready = mount(WorkflowControl, {
      props: {
        action: { type: 'midi-osc.send-osc', parameters: { host: '127.0.0.1', port: 8000, address: '/fader/1' } },
        apiBase: 'http://localhost:3001',
      },
    })
    await flushPromises()
    expect(ready.find('[data-cy="bd-needs-config"]').exists()).toBe(false)
    await ready.get('.osc-pad').trigger('click')
    await flushPromises()
    const calls = requests.filter(r => r.url.endsWith('/api/v1/actions/execute'))
    expect(JSON.parse(String(calls.at(-1)?.init?.body))).toEqual({
      action: { type: 'midi-osc.send-osc', parameters: { host: '127.0.0.1', port: 8000, address: '/fader/1' } },
      context: { quiet: true, source: 'widget-control' },
    })
    ready.unmount()
  })

  it('resolves the shared carouselMs contract for compact slots and layouts', () => {
    expect(resolveCarouselMs({})).toBe(4000)
    expect(resolveCarouselMs({ carouselMs: 0 })).toBe(0)
    expect(resolveCarouselMs({ carouselMs: -5 })).toBe(0)
    expect(resolveCarouselMs({ carouselMs: 200 })).toBe(1000)
    expect(resolveCarouselMs({ carouselMs: 2500 })).toBe(2500)
  })

  it('renders the compact carousel for clipboard slots with carouselMs off', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      success: true,
      result: { slots: [{ slot: 'Firma', preview: 'Un saludo', length: 9 }] },
    }), { status: 200 })))
    const wrapper = mount(WorkflowControl, {
      props: { action: { type: 'clipboard.list-slots', parameters: { carouselMs: 0 } }, apiBase: '' },
    })
    await flushPromises()
    expect(wrapper.find('[data-cy="bd-carousel"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('Firma')
    wrapper.unmount()
  })
})
