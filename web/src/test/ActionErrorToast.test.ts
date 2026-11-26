import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { useStreamDeck } from '../composables/useStreamDeck'

const Harness = defineComponent({
  setup(_, { expose }) {
    const sd = useStreamDeck()
    expose({ sd })
    return () => h('div')
  },
})

let execResponse: any = { success: true, result: {}, duration: 1 }

const fetchMock = vi.fn(async (url: string) => {
  if (String(url).includes('/actions/execute')) {
    if ((execResponse as any)?.__throw) {
      throw new Error((execResponse as any).__throw)
    }
    return { ok: true, status: 200, json: async () => execResponse } as any
  }
  return { ok: true, status: 200, json: async () => ({}) } as any
})

beforeEach(() => {
  execResponse = { success: true, result: {}, duration: 1 }
  fetchMock.mockClear()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function collectActionErrors() {
  const events: any[] = []
  const handler = (e: Event) => events.push((e as CustomEvent).detail)
  window.addEventListener('libredeck:action-error', handler as EventListener)
  return { events, stop: () => window.removeEventListener('libredeck:action-error', handler as EventListener) }
}

const mountSd = () => mount(Harness) as any

describe('action.error → toast (ya no se descarta)', () => {
  it('el mensaje WS action.error emite evento para el toast', async () => {
    const wrapper = mountSd()
    const { events, stop } = collectActionErrors()
    const sd = (wrapper.vm as any).sd

    await sd.handleWebSocketMessage({
      type: 'action.error',
      payload: { actionId: 'run:discord.toggle-mute', error: 'Discord (toggle-mute) [discord-closed]: Discord cerrado' },
    })
    await flushPromises()

    expect(events).toHaveLength(1)
    expect(events[0].message).toContain('Discord cerrado')
    stop()
    wrapper.unmount()
  })

  it('incluye acción y tecla para identificar el origen del error', async () => {
    const wrapper = mountSd()
    const { events, stop } = collectActionErrors()
    const sd = (wrapper.vm as any).sd
    sd.plugins.value = [['pc-vitals', {
      manifest: { name: 'PC Vitals' },
      actions: [['summary', { name: 'Resumen del sistema' }]],
    }]]

    await sd.handleWebSocketMessage({
      type: 'action.error',
      payload: {
        actionId: 'run:pc-vitals.summary',
        actionType: 'pc-vitals.summary',
        position: 3,
        error: 'Action is already running',
      },
    })
    await flushPromises()

    expect(events).toHaveLength(1)
    expect(events[0].message).toContain('Resumen del sistema')
    expect(events[0].message).toContain('tecla 4')
    expect(events[0].message).toContain('Action is already running')
    stop()
    wrapper.unmount()
  })

  it('executeButton avisa cuando el daemon responde success:false (200)', async () => {
    execResponse = { success: false, error: 'Discord (toggle-mute) [voice-locked]: otra app tiene el control', duration: 5 }
    const wrapper = mountSd()
    const { events, stop } = collectActionErrors()
    const sd = (wrapper.vm as any).sd

    sd.currentButtons.value = [{
      id: 'b1', page_id: 'p1', position: 0,
      data: { actions: [{ type: 'discord.toggle-mute', parameters: {} }] },
    }]
    await sd.executeButton(0)
    await flushPromises()

    expect(events).toHaveLength(1)
    expect(events[0].message).toContain('voice-locked')
    stop()
    wrapper.unmount()
  })

  it('executeButton avisa cuando la ejecución lanza (HTTP 500)', async () => {
    execResponse = { __throw: 'API Error: 500' }
    const wrapper = mountSd()
    const { events, stop } = collectActionErrors()
    const sd = (wrapper.vm as any).sd

    sd.currentButtons.value = [{
      id: 'b1', page_id: 'p1', position: 0,
      data: { actions: [{ type: 'discord.toggle-mute', parameters: {} }] },
    }]
    await sd.executeButton(0)
    await flushPromises()

    expect(events).toHaveLength(1)
    expect(events[0].message).toContain('500')
    stop()
    wrapper.unmount()
  })

  it('executeButton en éxito no emite nada', async () => {
    execResponse = { success: true, result: { transport: 'rpc', mute: true }, duration: 3 }
    const wrapper = mountSd()
    const { events, stop } = collectActionErrors()
    const sd = (wrapper.vm as any).sd

    sd.currentButtons.value = [{
      id: 'b1', page_id: 'p1', position: 0,
      data: { actions: [{ type: 'discord.toggle-mute', parameters: {} }] },
    }]
    await sd.executeButton(0)
    await flushPromises()

    expect(events).toHaveLength(0)
    stop()
    wrapper.unmount()
  })
})
