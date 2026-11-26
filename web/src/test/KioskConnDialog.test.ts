import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import KioskConnDialog from '../components/bundeck/KioskConnDialog.vue'
import type { ConnEntry } from '../utils/kioskConnLog'

vi.mock('../composables/useI18n', () => ({
  useI18nStore: () => ({
    t: (key: string) => key,
    currentLocale: { value: 'es' },
    setLocale: () => {},
    loadSavedLocale: () => {},
  }),
}))

const entries: ConnEntry[] = [
  { ts: 1700000000000, kind: 'lan-ok', detail: JSON.stringify({ ip: '192.168.1.2', ms: 12 }) },
  { ts: 1700000001000, kind: 'rtc-fallback', detail: 'handshake failed' },
]

describe('KioskConnDialog', () => {
  it('pinta título, estado y una fila por entrada (claves i18n con t identidad)', () => {
    const wrapper = mount(KioskConnDialog, {
      props: { entries, transportLabel: 'P2P', wsOk: true },
    })
    expect(wrapper.find('[data-cy="kiosk-conn-dialog"]').exists()).toBe(true)
    expect(wrapper.find('[data-cy="kiosk-conn-title"]').text()).toBe('bd.kioskConnLogTitle')
    expect(wrapper.find('[data-cy="kiosk-conn-state"]').text()).toContain('P2P')
    const rows = wrapper.findAll('[data-cy="kiosk-conn-entry"]')
    expect(rows).toHaveLength(2)
    // t está mockeado como identidad: se assertan CLAVES, no literales.
    expect(rows[0].find('span').text()).toBe('bd.kioskLogLanOk')
    expect(rows[1].find('span').text()).toBe('bd.kioskLogRtcFallback')
    // Cada fila lleva su hora.
    expect(rows[0].find('time').text().length).toBeGreaterThan(0)
    wrapper.unmount()
  })

  it('vacío honesto sin entradas', () => {
    const wrapper = mount(KioskConnDialog, {
      props: { entries: [], transportLabel: 'X', wsOk: false },
    })
    expect(wrapper.findAll('[data-cy="kiosk-conn-entry"]')).toHaveLength(0)
    expect(wrapper.find('[data-cy="kiosk-conn-empty"]').text()).toBe('bd.kioskConnLogEmpty')
    wrapper.unmount()
  })

  it('botón cerrar y Escape emiten dismiss', async () => {
    const wrapper = mount(KioskConnDialog, {
      props: { entries, transportLabel: 'P2P', wsOk: true },
    })
    await wrapper.find('[data-cy="kiosk-conn-close"]').trigger('click')
    expect(wrapper.emitted('dismiss')).toBeTruthy()
    await wrapper.find('[data-cy="kiosk-conn-dialog"]').trigger('cancel')
    expect(wrapper.emitted('dismiss')).toBeTruthy()
    wrapper.unmount()
  })
})
