import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import StageBoard from '../components/bundeck/StageBoard.vue'

vi.mock('../composables/useI18n', () => ({
  useI18nStore: () => ({
    t: (key: string) => key,
    currentLocale: { value: 'es' },
    setLocale: () => {},
    loadSavedLocale: () => {},
  }),
}))

vi.mock('../composables/useKeyShare', () => ({
  assetUrl: () => '',
  isAssetRef: () => false,
}))

const gridPage = { id: 'g1', profile_id: 'p', name: 'Inicio', order_idx: 0, is_folder: 0, data: {} }
const deck = { id: 'd1', name: 'Deck', kind: 'deck', model: 'mk2', cols: 5, rows: 3, hw_path: null, source: 'hardware', online: true }
const phone = { id: 'm1', name: 'Móvil', kind: 'phone', model: null, cols: null, rows: null, hw_path: null, online: true, source: 'browser' }
const browser = { id: 'b1', name: 'Navegador', kind: 'browser', model: null, cols: null, rows: null, hw_path: null, online: true, source: 'browser' }

const baseProps = {
  gridCols: 5,
  gridRows: 3,
  selectedButton: null,
  executingButtons: [],
  buttonConfig: {},
  getButton: () => undefined,
  allButtons: [],
  getButtonData: () => null,
  mode: 'edit',
  labelMode: 'a',
  currentPages: [gridPage],
  currentPage: gridPage,
  navTrail: [],
  profileName: 'Principal',
  busy: false,
} as any

describe('StageBoard bd-free-note: solo con Stream Deck detectado', () => {
  it('(a) modo libre + edición + hay deck → chip visible', () => {
    const wrapper = mount(StageBoard, {
      props: { ...baseProps, layoutMode: 'gridstack', devices: [deck, phone] },
    })
    expect(wrapper.find('[data-cy=bd-free-note]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('(a2) modo libre + edición + solo hwConnected (sin fila lógica) → chip visible', () => {
    const wrapper = mount(StageBoard, {
      props: { ...baseProps, layoutMode: 'gridstack', devices: [phone], hwConnected: true },
    })
    expect(wrapper.find('[data-cy=bd-free-note]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('(b) modo libre + edición + sin deck (solo phone/browser o lista vacía) → chip oculto', () => {
    const onlyPhone = mount(StageBoard, {
      props: { ...baseProps, layoutMode: 'gridstack', devices: [phone, browser] },
    })
    expect(onlyPhone.find('[data-cy=bd-free-note]').exists()).toBe(false)
    onlyPhone.unmount()

    const empty = mount(StageBoard, {
      props: { ...baseProps, layoutMode: 'gridstack', devices: [] },
    })
    expect(empty.find('[data-cy=bd-free-note]').exists()).toBe(false)
    empty.unmount()
  })

  it('(c) modo clásico + edición (+ deck) → oculto (comportamiento previo intacto)', () => {
    const wrapper = mount(StageBoard, {
      props: { ...baseProps, layoutMode: 'classic', devices: [deck] },
    })
    expect(wrapper.find('[data-cy=bd-free-note]').exists()).toBe(false)
    wrapper.unmount()
  })
})
