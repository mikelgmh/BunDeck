import { describe, expect, it, vi, beforeEach } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import MediaTransportControl from '../components/bundeck/widgets/MediaTransportControl.vue'
import { executeWidgetAction } from '../composables/useWidgetAction'
import { useI18nStore } from '../composables/useI18n'

vi.mock('../composables/useWidgetAction', () => ({ executeWidgetAction: vi.fn() }))

const execute = vi.mocked(executeWidgetAction)

describe('MediaTransportControl', () => {
  beforeEach(() => {
    execute.mockReset()
    useI18nStore().setLocale('en')
  })

  it('routes transport buttons through the multimedia action and helper', async () => {
    execute.mockResolvedValue({})
    const wrapper = mount(MediaTransportControl, {
      props: {
        action: { type: 'multimedia.multimedia', parameters: { action: 'play' } },
        apiBase: 'http://localhost:3001',
      },
    })

    await wrapper.get('[aria-label="Previous track"]').trigger('click')
    await flushPromises()
    expect(execute).toHaveBeenCalledWith('http://localhost:3001', 'multimedia.multimedia', { action: 'previous' })
    await wrapper.get('[aria-label="Play or pause"]').trigger('click')
    await flushPromises()
    expect(execute).toHaveBeenLastCalledWith('http://localhost:3001', 'multimedia.multimedia', { action: 'playpause' })
    await wrapper.get('[aria-label="Next track"]').trigger('click')
    await flushPromises()
    expect(execute).toHaveBeenLastCalledWith('http://localhost:3001', 'multimedia.multimedia', { action: 'next' })
    await wrapper.get('[aria-label="Toggle mute"]').trigger('click')
    await flushPromises()
    expect(execute).toHaveBeenLastCalledWith('http://localhost:3001', 'multimedia.multimedia', { action: 'mute' })
    expect(wrapper.text()).toContain('Command sent.')
    wrapper.unmount()
  })

  it('does not run commands in read-only mode', async () => {
    const wrapper = mount(MediaTransportControl, {
      props: {
        action: { type: 'multimedia.multimedia', parameters: {} },
        apiBase: '',
        readonly: true,
      },
    })
    await wrapper.get('[aria-label="Play or pause"]').trigger('click')
    expect(execute).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('keeps only play and next visible in XS (previous/mute progressive)', () => {
    const wrapper = mount(MediaTransportControl, {
      props: { action: { type: 'multimedia.multimedia', parameters: {} }, apiBase: '' },
    })
    // Sin container queries en jsdom todo existe; las clases marcan el
    // progressive disclosure que el CSS aplica en <200px.
    expect(wrapper.get('[aria-label="Previous track"]').classes()).toContain('xs-hide')
    expect(wrapper.get('[aria-label="Toggle mute"]').classes()).toContain('xs-hide')
    expect(wrapper.get('[aria-label="Play or pause"]').classes()).not.toContain('xs-hide')
    expect(wrapper.get('[aria-label="Next track"]').classes()).not.toContain('xs-hide')
    expect(wrapper.find('[data-cy="bd-needs-config"]').exists()).toBe(false)
    wrapper.unmount()
  })
})
