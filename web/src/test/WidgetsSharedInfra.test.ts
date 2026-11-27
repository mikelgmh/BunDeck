import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, defineComponent, h, ref } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import Marquee from '../components/bundeck/widgets/shared/Marquee.vue'
import NeedsConfig from '../components/bundeck/widgets/shared/NeedsConfig.vue'
import AutoCarousel from '../components/bundeck/widgets/shared/AutoCarousel.vue'
import {
  OPEN_ACTION_SETTINGS_EVENT,
  bundeckRootUrl,
  useOpenActionSettings,
} from '../composables/useOpenActionSettings'
import { resolveCarouselMs, useAutoCarousel } from '../composables/useAutoCarousel'
import { useI18nStore } from '../composables/useI18n'

const { setLocale } = useI18nStore()

beforeEach(() => {
  setLocale('es')
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  setLocale('es')
})

describe('resolveCarouselMs (contrato carouselMs)', () => {
  it('devuelve el defecto 4000 sin setting', () => {
    expect(resolveCarouselMs(undefined)).toBe(4000)
    expect(resolveCarouselMs(null)).toBe(4000)
    expect(resolveCarouselMs({})).toBe(4000)
  })

  it('acepta valores válidos y satura el mínimo a 1000', () => {
    expect(resolveCarouselMs({ carouselMs: 2500 })).toBe(2500)
    expect(resolveCarouselMs({ carouselMs: 200 })).toBe(1000)
    expect(resolveCarouselMs({ carouselMs: '3000' })).toBe(3000)
  })

  it('0 o negativo desactiva (0)', () => {
    expect(resolveCarouselMs({ carouselMs: 0 })).toBe(0)
    expect(resolveCarouselMs({ carouselMs: -5 })).toBe(0)
  })

  it('inválidos caen al defecto o al fallback dado', () => {
    expect(resolveCarouselMs({ carouselMs: 'pronto' })).toBe(4000)
    expect(resolveCarouselMs({ carouselMs: NaN }, 7000)).toBe(7000)
  })
})

describe('useAutoCarousel', () => {
  function harness(count: any, options: any = {}) {
    let api: ReturnType<typeof useAutoCarousel> | null = null
    const Comp = defineComponent({
      setup() {
        api = useAutoCarousel(count, options)
        return () => h('div')
      },
    })
    const wrapper = mount(Comp)
    if (!api) throw new Error('composable no inicializado')
    return { wrapper, api: api as ReturnType<typeof useAutoCarousel> }
  }

  it('rota el índice con el intervalo y envuelve', () => {
    vi.useFakeTimers()
    const { wrapper, api } = harness(3, { intervalMs: 2000 })
    expect(api.index.value).toBe(0)
    vi.advanceTimersByTime(2000)
    expect(api.index.value).toBe(1)
    vi.advanceTimersByTime(4000)
    expect(api.index.value).toBe(0)
    wrapper.unmount()
  })

  it('no rota con un solo elemento ni con intervalo 0', () => {
    vi.useFakeTimers()
    const one = harness(1, { intervalMs: 2000 })
    vi.advanceTimersByTime(10000)
    expect(one.api.index.value).toBe(0)
    one.wrapper.unmount()
    const off = harness(4, { intervalMs: 0 })
    vi.advanceTimersByTime(10000)
    expect(off.api.index.value).toBe(0)
    off.wrapper.unmount()
  })

  it('navegación manual envuelve y pause/resume funcionan', () => {
    vi.useFakeTimers()
    const { wrapper, api } = harness(3, { intervalMs: 5000 })
    api.prev()
    expect(api.index.value).toBe(2)
    api.next()
    expect(api.index.value).toBe(0)
    api.goTo(7)
    expect(api.index.value).toBe(1)
    api.pause()
    vi.advanceTimersByTime(20000)
    expect(api.index.value).toBe(1)
    api.resume()
    vi.advanceTimersByTime(5000)
    expect(api.index.value).toBe(2)
    wrapper.unmount()
  })

  it('resetea el índice si la lista encoge', async () => {
    vi.useFakeTimers()
    const count = ref(3)
    const { wrapper, api } = harness(count, { intervalMs: 5000 })
    api.goTo(2)
    expect(api.index.value).toBe(2)
    count.value = 1
    await flushPromises()
    expect(api.index.value).toBe(0)
    wrapper.unmount()
  })

  it('lee el intervalo de un getter reactivo (resolveCarouselMs)', async () => {
    vi.useFakeTimers()
    const params = ref<Record<string, any>>({ carouselMs: 0 })
    const { wrapper, api } = harness(2, {
      intervalMs: computed(() => resolveCarouselMs(params.value)),
    })
    vi.advanceTimersByTime(20000)
    expect(api.index.value).toBe(0)
    params.value = { carouselMs: 1500 }
    await flushPromises()
    vi.advanceTimersByTime(1500)
    expect(api.index.value).toBe(1)
    wrapper.unmount()
  })
})

describe('Marquee', () => {
  it('expone la velocidad vía CSS y queda estático sin overflow (jsdom)', async () => {
    const wrapper = mount(Marquee, { props: { text: 'Hola', speed: 10 } })
    await flushPromises()
    expect(wrapper.attributes('style')).toContain('--bd-marquee-duration: 10s')
    expect(wrapper.classes()).toContain('is-static')
    expect(wrapper.find('[data-cy="bd-marquee-text"]').text()).toBe('Hola')
    wrapper.unmount()
  })

  it('anima cuando el texto desborda (medida real, no siempre)', async () => {
    // El texto vive en spans con `:key="text"` (fundido al cambiar): los
    // mocks deben sobrevivir al re-montaje, así que se definen en el
    // prototipo en vez de en la instancia del elemento.
    const swDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollWidth')
    const cwDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')
    Object.defineProperties(HTMLElement.prototype, {
      scrollWidth: { configurable: true, get() { return 500 } },
      clientWidth: {
        configurable: true,
        get(this: HTMLElement) {
          return this?.dataset?.cy === 'bd-marquee' ? 100 : (cwDesc?.get?.call(this) ?? 0)
        },
      },
    })
    try {
      const wrapper = mount(Marquee, { props: { text: 'un título larguísimo que no cabe en la tecla pequeña' } })
      await flushPromises()
      expect(wrapper.classes()).not.toContain('is-static')
      wrapper.unmount()
    } finally {
      if (swDesc) Object.defineProperty(HTMLElement.prototype, 'scrollWidth', swDesc)
      else delete (HTMLElement.prototype as any).scrollWidth
      if (cwDesc) Object.defineProperty(HTMLElement.prototype, 'clientWidth', cwDesc)
      else delete (HTMLElement.prototype as any).clientWidth
    }
  })
})

describe('useOpenActionSettings', () => {
  it('devuelve drawer cuando BunDeckApp gestiona el evento', () => {
    const seen: any[] = []
    const onEvent = (e: Event) => {
      seen.push((e as CustomEvent).detail)
      e.preventDefault()
    }
    window.addEventListener(OPEN_ACTION_SETTINGS_EVENT, onEvent as EventListener)
    try {
      const { openActionSettings } = useOpenActionSettings()
      expect(openActionSettings({ actionType: 'obs.status', position: 7 })).toBe('drawer')
      expect(seen).toEqual([{ actionType: 'obs.status', position: 7 }])
    } finally {
      window.removeEventListener(OPEN_ACTION_SETTINGS_EVENT, onEvent as EventListener)
    }
  })

  it('sin listener y en host queda como no-gestionado (kiosco)', () => {
    const open = vi.fn()
    const prevOpen = window.open
    window.open = open as any
    try {
      const { openActionSettings } = useOpenActionSettings()
      expect(openActionSettings({ position: 3 })).toBe('unhandled')
      expect(open).not.toHaveBeenCalled()
    } finally {
      window.open = prevOpen
    }
  })

  it('en remoto sin drawer abre bundeck en la web (hook remoteUrl)', () => {
    const open = vi.fn()
    const prevOpen = window.open
    window.open = open as any
    const prevLocation = Object.getOwnPropertyDescriptor(window, 'location')
    Object.defineProperty(window, 'location', {
      value: {
        hostname: '192.168.1.50',
        origin: 'http://192.168.1.50:4321',
        pathname: '/',
        search: '',
        hash: '',
        protocol: 'http:',
      },
      configurable: true,
    })
    try {
      const { openActionSettings } = useOpenActionSettings()
      expect(openActionSettings({ actionType: 'obs.status' })).toBe('remote')
      expect(open).toHaveBeenCalledWith('http://192.168.1.50:4321/', '_blank', 'noopener')
      open.mockClear()
      expect(
        openActionSettings({ actionType: 'obs.status', remoteUrl: 'https://deck.example/ui' }),
      ).toBe('remote')
      expect(open).toHaveBeenCalledWith('https://deck.example/ui', '_blank', 'noopener')
    } finally {
      window.open = prevOpen
      if (prevLocation) Object.defineProperty(window, 'location', prevLocation)
    }
  })

  it('bundeckRootUrl usa el origin actual', () => {
    expect(bundeckRootUrl()).toBe(`${window.location.origin}/`)
  })
})

describe('NeedsConfig', () => {
  it('pide el drawer con tipo y posición al pulsar', async () => {
    const seen: any[] = []
    const results: string[] = []
    const onEvent = (e: Event) => {
      seen.push((e as CustomEvent).detail)
      e.preventDefault()
    }
    window.addEventListener(OPEN_ACTION_SETTINGS_EVENT, onEvent as EventListener)
    try {
      const wrapper = mount(NeedsConfig, {
        props: { actionType: 'obs.status', position: 4 },
      })
      const btn = wrapper.find('[data-cy="bd-needs-config"]')
      expect(btn.attributes('aria-label')).toContain('Sin configurar')
      await btn.trigger('click')
      expect(seen).toEqual([{ actionType: 'obs.status', position: 4 }])
      expect(wrapper.emitted('opened')).toEqual([['drawer']])
      results.push('ok')
      wrapper.unmount()
    } finally {
      window.removeEventListener(OPEN_ACTION_SETTINGS_EVENT, onEvent as EventListener)
    }
    expect(results).toEqual(['ok'])
  })
})

describe('AutoCarousel', () => {
  it('pinta el elemento del índice y rota; dots solo con showDots', async () => {
    vi.useFakeTimers()
    const wrapper = mount(AutoCarousel, {
      props: { count: 3, intervalMs: 2000, showDots: false },
      slots: { default: ({ index }: any) => h('span', `item-${index}`) },
    })
    expect(wrapper.text()).toContain('item-0')
    expect(wrapper.findAll('[data-cy="bd-carousel-dot"]')).toHaveLength(0)
    vi.advanceTimersByTime(2000)
    await flushPromises()
    expect(wrapper.text()).toContain('item-1')
    await wrapper.setProps({ showDots: true })
    const dots = wrapper.findAll('[data-cy="bd-carousel-dot"]')
    expect(dots).toHaveLength(3)
    await dots[2].trigger('click')
    expect(wrapper.text()).toContain('item-2')
    wrapper.unmount()
  })
})
