import { describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import ControlSurface from '../components/bundeck/ControlSurface.vue'

describe('ControlSurface', () => {
  it('resolves a registered action to its interactive control', async () => {
    const wrapper = mount(ControlSurface, {
      props: {
        action: { type: 'multimedia.multimedia', parameters: {} },
        apiBase: '',
        label: 'Media',
      },
    })
    await flushPromises()
    expect(wrapper.find('[data-component="media-transport"]').exists()).toBe(true)
    await vi.waitFor(() => expect(wrapper.find('[data-cy="media-transport"]').exists()).toBe(true))
    wrapper.unmount()
  })

  it('keeps legacy volume actions on the existing specialized control', async () => {
    const wrapper = mount(ControlSurface, {
      props: {
        action: { type: 'audio-mixer.volume-control', parameters: { app: 'spotify.exe' } },
        apiBase: 'http://localhost:3001',
        label: 'Spotify',
      },
      global: {
        stubs: {
          VolumeRange: {
            props: ['apiBase', 'app', 'label', 'readonly'],
            template: '<div data-cy="volume-range-stub">{{ app }} {{ label }}</div>',
          },
        },
      },
    })
    expect(wrapper.find('[data-cy="volume-range-stub"]').text()).toContain('spotify.exe')
    expect(wrapper.find('[data-cy="volume-range-stub"]').text()).toContain('Spotify')
    wrapper.unmount()
  })
})
