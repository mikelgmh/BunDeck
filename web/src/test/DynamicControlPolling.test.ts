import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { useStreamDeck } from '../composables/useStreamDeck'

const Harness = defineComponent({
  setup(_, { expose }) {
    const streamDeck = useStreamDeck()
    expose({ streamDeck })
    return () => h('div')
  },
})

describe('dynamic control surfaces', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('does not run control-surface actions through the generic dynamic poller', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = mount(Harness)
    const { streamDeck } = wrapper.vm as any
    streamDeck.plugins.value = [
      ['pc-vitals', {
        actions: [
          ['summary', { dynamic: true, surface: 'control', component: 'status-cards' }],
          ['monitor', { dynamic: true, surface: 'control', component: 'status-cards' }],
          ['legacy-metric', { dynamic: true }],
        ],
      }],
    ]
    const controlButton = {
      id: 'pc-status',
      page_id: 'page-1',
      position: 0,
      data: { actions: [{ id: 'stable-action-id', type: 'pc-vitals.summary', parameters: {} }] },
    }
    const regularDynamicButton = {
      id: 'legacy-status',
      page_id: 'page-1',
      position: 1,
      data: { actions: [{ id: 'legacy-action-id', type: 'pc-vitals.legacy-metric', parameters: {} }] },
    }
    streamDeck.currentButtons.value = [controlButton, regularDynamicButton]

    expect(streamDeck.hasDynamicAction(controlButton)).toBe(false)
    expect(streamDeck.getDynamicAction(controlButton)).toBeNull()
    expect(streamDeck.hasDynamicAction(regularDynamicButton)).toBe(true)
    expect(streamDeck.getDynamicAction(regularDynamicButton)?.id).toBe('legacy-action-id')

    await streamDeck.startDynamicUpdates()
    await flushPromises()
    const batchCalls = fetchMock.mock.calls.filter(([url]: [string]) => String(url).includes('/actions/execute-many'))
    expect(batchCalls).toHaveLength(1)
    const batchBody = JSON.parse(String(batchCalls[0][1].body))
    expect(batchBody.items).toHaveLength(1)
    expect(batchBody.items[0].action.type).toBe('pc-vitals.legacy-metric')

    streamDeck.cleanup()
    wrapper.unmount()
  })
})
