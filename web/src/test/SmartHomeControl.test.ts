import { describe, expect, it, vi, beforeEach } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import SmartHomeControl from '../components/bundeck/widgets/SmartHomeControl.vue'
import { executeWidgetAction } from '../composables/useWidgetAction'
import { useI18nStore } from '../composables/useI18n'

vi.mock('../composables/useWidgetAction', () => ({ executeWidgetAction: vi.fn() }))

const execute = vi.mocked(executeWidgetAction)

describe('SmartHomeControl', () => {
  beforeEach(() => {
    execute.mockReset()
    useI18nStore().setLocale('en')
  })

  it('reads Home Assistant sensor state and never renders token parameters', async () => {
    execute.mockResolvedValue({
      result: {
        rawState: '21.5',
        attributes: { unit_of_measurement: '°C' },
      },
    })
    const wrapper = mount(SmartHomeControl, {
      props: {
        action: {
          type: 'homeassistant.entity',
          parameters: { entityId: 'sensor.office_temperature', action: 'read', token: 'secret-token' },
        },
        apiBase: '/api',
      },
    })
    await flushPromises()

    expect(execute).toHaveBeenCalledWith('/api', 'homeassistant.entity', {
      entityId: 'sensor.office_temperature',
      action: 'read',
      token: 'secret-token',
    })
    expect(wrapper.text()).toContain('21.5 °C')
    expect(wrapper.text()).not.toContain('secret-token')
    wrapper.unmount()
  })

  it('exposes interactive Home Assistant brightness and sends target brightness', async () => {
    execute.mockResolvedValue({ result: { success: true } })
    const wrapper = mount(SmartHomeControl, {
      props: {
        action: {
          type: 'homeassistant.entity',
          parameters: { entityId: 'light.desk', action: 'on', brightness: 128 },
        },
        apiBase: '',
      },
    })
    await flushPromises()
    const slider = wrapper.get('[aria-label="Target light brightness"]')
    await slider.setValue('180')
    await slider.trigger('change')
    await flushPromises()
    expect(execute).toHaveBeenLastCalledWith('', 'homeassistant.entity', {
      entityId: 'light.desk',
      action: 'on',
      brightness: 180,
    })
    wrapper.unmount()
  })

  it('supports Govee brightness changes without reporting them as synchronized state', async () => {
    execute.mockResolvedValue({ result: { success: true } })
    const wrapper = mount(SmartHomeControl, {
      props: {
        action: {
          type: 'govee.brightness',
          parameters: { apiKey: 'private-key', device: 'device-id', model: 'H6159', brightness: 40 },
        },
        apiBase: '',
      },
    })
    await wrapper.get('[aria-label="Target light brightness"]').setValue('72')
    await wrapper.get('[aria-label="Target light brightness"]').trigger('change')
    await flushPromises()

    expect(execute).toHaveBeenLastCalledWith('', 'govee.brightness', {
      apiKey: 'private-key',
      device: 'device-id',
      model: 'H6159',
      brightness: 72,
    })
    expect(wrapper.text()).toContain('current brightness')
    expect(wrapper.text()).not.toContain('private-key')
    wrapper.unmount()
  })

  it('keeps controls read-only when requested', async () => {
    const wrapper = mount(SmartHomeControl, {
      props: {
        action: { type: 'hue-extra.toggle', parameters: { lightId: '3' } },
        apiBase: '',
        readonly: true,
      },
    })
    await wrapper.get('button').trigger('click')
    expect(execute).not.toHaveBeenCalled()
    wrapper.unmount()
  })
})
