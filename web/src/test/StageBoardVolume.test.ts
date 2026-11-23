import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import StageBoard from '../components/bundeck/StageBoard.vue'

vi.mock('../components/bundeck/VolumeRange.vue', () => ({
  default: {
    name: 'VolumeRange',
    props: ['apiBase', 'app', 'label', 'readonly'],
    template: '<div data-cy="vol-range-stub">{{ label }}</div>'
  }
}))

const baseProps = (overrides: any = {}) => ({
  gridCols: 4,
  gridRows: 3,
  keySize: 76,
  layoutMode: 'gridstack',
  selectedButton: null,
  executingButtons: [],
  buttonConfig: {},
  getButton: (position: number) =>
    position === 0
      ? { id: 'b-vol', page_id: 'p1', position: 0, widget_type: 'volume', data: { label: 'Volumen', component: 'volume' } }
      : undefined,
  allButtons: [
    { id: 'b-vol', page_id: 'p1', position: 0, widget_type: 'volume', x: 0, y: 0, w: 1, h: 1, data: { label: 'Volumen' } }
  ],
  getButtonData: () => ({}),
  mode: 'use',
  labelMode: 'a',
  currentPages: [],
  currentPage: { id: 'p1', name: 'P' },
  navTrail: [],
  profileName: 'P',
  busy: false,
  apiBase: '',
  ...overrides
})

describe('StageBoard modo libre: volumen', () => {
  it('renderiza VolumeRange solo en modo libre y solo para widget_type volume', async () => {
    const free = mount(StageBoard, { props: baseProps() as any })
    expect(free.find('[data-cy="bd-key-vol"]').exists()).toBe(true)
    expect(free.find('[data-cy="vol-range-stub"]').exists()).toBe(true)
    // La tecla normal no aparece para esa posición.
    expect(free.findAll('[data-cy="bd-key"]').length).toBe(0)
    free.unmount()

    // En modo clásico el volumen no existe: rejilla fija estándar.
    const classic = mount(StageBoard, {
      props: baseProps({ layoutMode: 'classic', allButtons: [], getButton: () => undefined }) as any
    })
    expect(classic.find('[data-cy="bd-key-vol"]').exists()).toBe(false)
    classic.unmount()
  })

  it('muestra el botón Añadir volumen solo en modo libre + edición', () => {
    const freeEdit = mount(StageBoard, { props: baseProps({ mode: 'edit' }) as any })
    expect(freeEdit.find('[data-cy="bd-gs-add-vol"]').exists()).toBe(true)
    freeEdit.unmount()
    const freeUse = mount(StageBoard, { props: baseProps({ mode: 'use' }) as any })
    expect(freeUse.find('[data-cy="bd-gs-add-vol"]').exists()).toBe(false)
    freeUse.unmount()
    const classicEdit = mount(StageBoard, {
      props: baseProps({ mode: 'edit', layoutMode: 'classic', getButton: () => undefined, allButtons: [] }) as any
    })
    expect(classicEdit.find('[data-cy="bd-gs-add-vol"]').exists()).toBe(false)
    classicEdit.unmount()
  })

  it('emite gs-add-volume al pulsar Añadir volumen', async () => {
    const wrapper = mount(StageBoard, { props: baseProps({ mode: 'edit' }) as any })
    await wrapper.find('[data-cy="bd-gs-add-vol"]').trigger('click')
    expect(wrapper.emitted('gs-add-volume')).toBeTruthy()
    wrapper.unmount()
  })
})
