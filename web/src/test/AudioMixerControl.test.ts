import { describe, expect, it, vi, beforeEach } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import AudioMixerControl from '../components/bundeck/widgets/AudioMixerControl.vue'
import { executeWidgetAction } from '../composables/useWidgetAction'
import { useI18nStore } from '../composables/useI18n'

vi.mock('../composables/useWidgetAction', () => ({ executeWidgetAction: vi.fn() }))

const execute = vi.mocked(executeWidgetAction)

describe('AudioMixerControl', () => {
  beforeEach(() => {
    execute.mockReset()
    useI18nStore().setLocale('en')
  })

  it('sends explicit mute and unmute requests without inventing a current state', async () => {
    execute.mockResolvedValue({ result: { muted: 'toggle' } })
    const wrapper = mount(AudioMixerControl, {
      props: {
        action: { type: 'audio-mixer.mic-mute', parameters: {} },
        apiBase: 'http://localhost:3001',
        label: 'Desk mic',
      },
    })

    await wrapper.get('button').trigger('click')
    await flushPromises()
    expect(execute).toHaveBeenLastCalledWith('http://localhost:3001', 'audio-mixer.mic-mute', { muted: true })
    expect(wrapper.text()).toContain('Mute command sent.')
    expect(wrapper.text()).not.toContain('Muted')
    wrapper.unmount()
  })

  it('enumerates outputs and submits the chosen device while preserving other parameters', async () => {
    execute.mockResolvedValueOnce({ result: { devices: [{ id: '2', name: 'Studio speakers' }] } })
    execute.mockResolvedValueOnce({ result: { applied: true } })
    const wrapper = mount(AudioMixerControl, {
      props: {
        action: { type: 'audio-mixer.output-switch', parameters: { device: '', extra: 'kept' } },
        apiBase: '/api',
      },
    })
    await flushPromises()
    expect(execute).toHaveBeenNthCalledWith(1, '/api', 'audio-mixer.output-switch', { extra: 'kept' })
    expect(wrapper.text()).toContain('Studio speakers')

    await wrapper.get('select').setValue('2')
    await wrapper.get('.m-apply').trigger('click')
    await flushPromises()
    expect(execute).toHaveBeenLastCalledWith('/api', 'audio-mixer.output-switch', { device: '2', extra: 'kept' })
    expect(wrapper.text()).toContain('Output change requested.')
    wrapper.unmount()
  })

  it('keeps actions disabled in read-only mode', async () => {
    const wrapper = mount(AudioMixerControl, {
      props: {
        action: { type: 'audio-mixer.mic-mute', parameters: {} },
        apiBase: '',
        readonly: true,
      },
    })
    expect(wrapper.findAll('button').every((button) => button.attributes('disabled') !== undefined)).toBe(true)
    await wrapper.findAll('button')[0].trigger('click')
    expect(execute).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('rotates output devices in the XS hero with the carouselMs contract', async () => {
    execute.mockResolvedValueOnce({
      result: { devices: [{ id: '2', name: 'Studio speakers' }, { id: '3', name: 'Headphones' }] },
    })
    const wrapper = mount(AudioMixerControl, {
      props: {
        action: { type: 'audio-mixer.output-switch', parameters: { carouselMs: 0 } },
        apiBase: '/api',
      },
    })
    await flushPromises()
    // Sin container queries en jsdom todo el DOM existe: héroe XS + select M+.
    expect(wrapper.find('[data-cy="audio-xs-hero"]').exists()).toBe(true)
    expect(wrapper.find('[data-cy="audio-xs-hero"]').text()).toContain('Studio speakers')
    expect(wrapper.find('[data-cy="bd-marquee"]').exists()).toBe(true)
    // carouselMs <= 0 desactiva la rotación: sigue en el primer dispositivo.
    expect(wrapper.find('select').exists()).toBe(true)
    wrapper.unmount()
  })

  it('never shows the needs-config badge (both actions work without parameters)', async () => {
    execute.mockResolvedValue({ result: { devices: [] } })
    const mic = mount(AudioMixerControl, {
      props: { action: { type: 'audio-mixer.mic-mute', parameters: {} }, apiBase: '' },
    })
    expect(mic.find('[data-cy="bd-needs-config"]').exists()).toBe(false)
    mic.unmount()
    const out = mount(AudioMixerControl, {
      props: { action: { type: 'audio-mixer.output-switch', parameters: {} }, apiBase: '' },
    })
    await flushPromises()
    expect(out.find('[data-cy="bd-needs-config"]').exists()).toBe(false)
    out.unmount()
  })
})
