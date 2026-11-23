import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import MobileDeck from '../components/bundeck/MobileDeck.vue'
import DeckPairingQr from '../components/bundeck/DeckPairingQr.vue'
import DeckUseView from '../components/bundeck/DeckUseView.vue'

vi.mock('../composables/useI18n', () => ({
  useI18nStore: () => ({
    t: (key: string) => key,
    currentLocale: { value: 'es' },
    setLocale: () => {},
    loadSavedLocale: () => {}
  })
}))

vi.mock('qrcode.vue', () => ({
  default: { name: 'QrcodeVue', template: '<svg data-cy="bd-deck-pair-qr-mock" />' }
}))

beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true } as any)))
})

describe('DeckPairingQr: URL de solo-uso', () => {
  it('construye /use?layout=<id> con el host actual', () => {
    const wrapper = mount(DeckPairingQr, { props: { layoutId: 'abc 123' } })
    const url = wrapper.find('[data-cy="bd-deck-pair-url"]').attributes('value') ?? ''
    expect(url).toContain('/use?layout=')
    expect(url).toContain(encodeURIComponent('abc 123'))
    wrapper.unmount()
  })

  it('copiar emite notify', async () => {
    Object.assign(navigator, { clipboard: { writeText: vi.fn(async () => {}) } })
    const wrapper = mount(DeckPairingQr, { props: { layoutId: 'l1' } })
    await wrapper.find('[data-cy="bd-deck-pair-copy"]').trigger('click')
    expect(wrapper.emitted('notify')).toBeTruthy()
    wrapper.unmount()
  })
})

describe('MobileDeck: solo-uso sin editor', () => {
  it('sin layouts muestra vacío y sin controles de edición', () => {
    const wrapper = mount(MobileDeck)
    expect(wrapper.find('[data-cy="bd-mobile-use"]').exists()).toBe(true)
    expect(wrapper.find('[data-cy="bd-mobile-empty"]').exists()).toBe(true)
    expect(wrapper.find('[data-cy="bd-deck-editor"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('con layout en localStorage pinta el board y pulsa action', async () => {
    localStorage.setItem('bundeck:deck-layouts-v1', JSON.stringify([
      {
        id: 'l1',
        name: 'Móvil',
        cols: 3,
        rows: 2,
        widgets: [{ id: 'a', kind: 'action', x: 0, y: 0, w: 1, h: 1, label: 'Go', buttonPosition: 0 }]
      }
    ]))
    Object.defineProperty(window, 'location', {
      value: { href: 'http://x/use?layout=l1', protocol: 'http:', hostname: 'x', host: 'x' },
      writable: true
    })
    const wrapper = mount(MobileDeck)
    expect(wrapper.find('[data-cy="bd-deck-use"]').exists()).toBe(true)
    await wrapper.find('[data-cy="bd-widget-action-btn"]').trigger('click')
    expect(vi.mocked(fetch)).toHaveBeenCalled()
    wrapper.unmount()
  })

  it('layoutId desconocido muestra vacío', () => {
    localStorage.setItem('bundeck:deck-layouts-v1', JSON.stringify([
      { id: 'otro', name: 'O', cols: 2, rows: 2, widgets: [] }
    ]))
    Object.defineProperty(window, 'location', {
      value: { href: 'http://x/use?layout=nope', protocol: 'http:', hostname: 'x', host: 'x' },
      writable: true
    })
    const wrapper = mount(MobileDeck)
    expect(wrapper.find('[data-cy="bd-mobile-empty"]').exists()).toBe(true)
    wrapper.unmount()
  })
})

describe('DeckUseView: placa de solo-uso', () => {
  it('respeta cols/rows y no expone edición', () => {
    const layout = {
      id: 'l1',
      name: 'U',
      cols: 4,
      rows: 3,
      widgets: [
        { id: 'a', kind: 'action', x: 0, y: 0, w: 2, h: 2, label: 'Big' },
        { id: 'c', kind: 'clock', x: 2, y: 0, w: 1, h: 1 }
      ]
    } as any
    const wrapper = mount(DeckUseView, { props: { layout } })
    const plate = wrapper.find('[data-cy="bd-deck-use-plate"]')
    expect(plate.attributes('style')).toContain('--bd-c: 4')
    expect(wrapper.find('[data-cy="bd-widget-action"]').exists()).toBe(true)
    expect(wrapper.find('[data-cy="bd-widget-clock"]').exists()).toBe(true)
    wrapper.unmount()
  })
})
