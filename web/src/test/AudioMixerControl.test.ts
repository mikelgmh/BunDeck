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
    await wrapper.get('.apply').trigger('click')
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
})
