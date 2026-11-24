import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import TunnelTransportBanner from '../components/bundeck/TunnelTransportBanner.vue'

vi.mock('../composables/useI18n', () => ({
  useI18nStore: () => ({
    t: (key: string) => key,
  }),
}))

describe('TunnelTransportBanner', () => {
  it('signaling/idle → probando P2P con punto pulsante', () => {
    for (const status of ['idle', 'signaling'] as const) {
      const wrapper = mount(TunnelTransportBanner, { props: { status } })
      expect(wrapper.attributes('data-status')).toBe(status)
      expect(wrapper.find('[data-cy="tunnel-transport-banner"]').exists()).toBe(true)
      expect(wrapper.find('[data-cy="tunnel-transport-label"]').text()).toBe('bd.tunnelTransportProbing')
      expect(wrapper.find('.bd-probe').exists()).toBe(true)
      wrapper.unmount()
    }
  })

  it('connected → P2P directo en verde', () => {
    const wrapper = mount(TunnelTransportBanner, { props: { status: 'connected' } })
    expect(wrapper.find('[data-cy="tunnel-transport-label"]').text()).toBe('bd.tunnelTransportP2p')
    expect(wrapper.find('.bd-ok').exists()).toBe(true)
    wrapper.unmount()
  })

  it('fallback → relay', () => {
    const wrapper = mount(TunnelTransportBanner, { props: { status: 'fallback' } })
    expect(wrapper.find('[data-cy="tunnel-transport-label"]').text()).toBe('bd.tunnelTransportRelay')
    expect(wrapper.find('.bd-relay').exists()).toBe(true)
    wrapper.unmount()
  })

  it('descartar emite dismiss', async () => {
    const wrapper = mount(TunnelTransportBanner, { props: { status: 'signaling' } })
    await wrapper.find('[data-cy="tunnel-transport-dismiss"]').trigger('click')
    expect(wrapper.emitted('dismiss')).toBeTruthy()
    wrapper.unmount()
  })
})
