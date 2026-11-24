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
const freePage = {
  id: 'g2', profile_id: 'p', name: 'Libre', order_idx: 1, is_folder: 0,
  data: { layoutMode: 'gridstack' },
}
const deck = { id: 'd1', name: 'Deck', kind: 'deck', model: 'mk2', cols: 5, rows: 3, hw_path: null, source: 'hardware', online: true }
const mobile = { id: 'm1', name: 'Móvil', kind: 'phone', model: null, cols: null, rows: null, hw_path: null, online: true, source: 'browser' }

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
  currentPages: [gridPage, freePage],
  currentPage: gridPage,
  navTrail: [],
  profileName: 'Principal',
  busy: false,
} as any

describe('StageBoard: dispositivos y pantallas', () => {
  it('muestra filas/columnas también en modo libre y píldora + añadir', async () => {
    const free = mount(StageBoard, { props: { ...baseProps, layoutMode: 'gridstack' } })
    expect(free.find('[data-cy=bd-free-note]').exists()).toBe(true)
    expect(free.find('[data-cy=bd-gs-add-tool]').exists()).toBe(true)
    // El tamaño de la cuadrícula se puede cambiar también en modo libre.
    expect(free.find('[data-cy=bd-grid-rows]').exists()).toBe(true)
    expect(free.find('[data-cy=bd-grid-cols]').exists()).toBe(true)
    const classic = mount(StageBoard, { props: { ...baseProps, layoutMode: 'classic' } })
    expect(classic.find('[data-cy=bd-free-note]').exists()).toBe(false)
    expect(classic.find('[data-cy=bd-grid-rows]').exists()).toBe(true)
    // En modo uso los steppers se ocultan.
    const use = mount(StageBoard, { props: { ...baseProps, layoutMode: 'classic', mode: 'use' } })
    expect(use.find('[data-cy=bd-grid-rows]').exists()).toBe(false)
    expect(use.find('[data-cy=bd-grid-cols]').exists()).toBe(false)
    free.unmount()
    classic.unmount()
    use.unmount()
  })

  it('trigger de dispositivos con badge y popover con selectores', async () => {
    const wrapper = mount(StageBoard, {
      props: { ...baseProps, devices: [deck, mobile], assignments: { d1: 'g1' } },
    })
    expect(wrapper.find('[data-cy=bd-devices-btn]').exists()).toBe(true)
    // 1 de 2 sin pantalla → aviso.
    expect(wrapper.find('[data-cy=bd-devices-badge]').text()).toContain('1/2')
    await wrapper.find('[data-cy=bd-devices-btn]').trigger('click')
    expect(wrapper.find('[data-cy=bd-devices-pop]').exists()).toBe(true)
    const sel = wrapper.find('[data-cy=bd-device-page-d1]')
    expect(sel.exists()).toBe(true)
    // La página libre está deshabilitada para el deck.
    const opts = sel.findAll('option')
    const free = opts.find((o) => (o.element as HTMLOptionElement).value === 'g2')
    expect((free!.element as HTMLOptionElement).disabled).toBe(true)
    // …pero no para el móvil.
    const msel = wrapper.find('[data-cy=bd-device-page-m1]')
    const mfree = msel.findAll('option').find((o) => (o.element as HTMLOptionElement).value === 'g2')
    expect((mfree!.element as HTMLOptionElement).disabled).toBe(false)
    // Asignar emite device-assign.
    await sel.setValue('g1')
    expect(wrapper.emitted('device-assign')).toEqual([[ 'd1', 'g1' ]])
    wrapper.unmount()
  })

  it('sin dispositivos no hay trigger', () => {
    const wrapper = mount(StageBoard, { props: { ...baseProps, devices: [] } })
    expect(wrapper.find('[data-cy=bd-devices-btn]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('en modo uso el chip incompatible se deshabilita y sin pantalla avisa', async () => {
    const wrapper = mount(StageBoard, {
      props: {
        ...baseProps,
        mode: 'use',
        devices: [deck, mobile],
        assignments: { m1: 'g1' },
        previewDeviceId: 'd1',
      },
    })
    // El deck simulado no tiene pantalla → estado sin pantalla.
    expect(wrapper.find('[data-cy=bd-no-screen]').exists()).toBe(true)
    // …y la página libre aparece deshabilitada en la lista.
    const chip = wrapper.find('[data-cy=bd-page-g2]')
    expect((chip.element as HTMLButtonElement).disabled).toBe(true)
    // Selector "Probar en" emite el cambio.
    await wrapper.find('[data-cy=bd-preview-dev] select').setValue('m1')
    expect(wrapper.emitted('preview-device-change')).toEqual([[ 'm1' ]])
    wrapper.unmount()
  })

  it('chips muestran un solo icono aunque haya varios dispositivos asignados', () => {
    const mobile = { id: 'm1', name: 'Móvil', kind: 'phone', model: null, cols: null, rows: null, hw_path: null, online: true, source: 'browser' }
    const wrapper = mount(StageBoard, {
      props: { ...baseProps, devices: [deck, mobile], assignments: { d1: 'g1', m1: 'g1' } },
    })
    const chip = wrapper.find('[data-cy=bd-page-g1]')
    expect(chip.find('.bd-dvs').exists()).toBe(true)
    // Un solo icono (el tooltip conserva la lista completa de nombres).
    expect(chip.findAll('.bd-dvs > *').length).toBe(1)
    expect(chip.find('.bd-dvs').attributes('title')).toBeTruthy()
    wrapper.unmount()
  })

  it('navegador acepta modo libre y muestra presencia online', async () => {
    const browser = { id: 'b1', name: 'Navegador', kind: 'browser', model: null, cols: null, rows: null, hw_path: null, online: true, source: 'browser' }
    const wrapper = mount(StageBoard, {
      props: { ...baseProps, devices: [deck, browser], assignments: { d1: 'g1' } },
    })
    await wrapper.find('[data-cy=bd-devices-btn]').trigger('click')
    // El navegador sí puede mostrar la página libre.
    const bsel = wrapper.find('[data-cy=bd-device-page-b1]')
    const bfree = bsel.findAll('option').find((o) => (o.element as HTMLOptionElement).value === 'g2')
    expect((bfree!.element as HTMLOptionElement).disabled).toBe(false)
    // Punto verde de presencia en su fila.
    const row = wrapper.find('[data-cy=bd-device-row-b1]')
    expect(row.find('.bd-dot.bd-ok').exists()).toBe(true)
    wrapper.unmount()
  })

  it('el desplegable solo muestra lo que está en línea', async () => {
    const hwOff = { ...deck, online: false }
    const ghost = { id: 'g9', name: 'Navegador', kind: 'browser', model: null, cols: null, rows: null, hw_path: null, online: false, source: 'browser' }
    const ownOff = { id: 'own', name: 'Este', kind: 'browser', model: null, cols: null, rows: null, hw_path: null, online: false, source: 'browser' }
    const wrapper = mount(StageBoard, {
      props: { ...baseProps, devices: [hwOff, ghost, ownOff, mobile], assignments: {} },
    })
    await wrapper.find('[data-cy=bd-devices-btn]').trigger('click')
    // Solo el móvil en línea; ni hardware apagado, ni fantasmas, ni el propio en gris.
    expect(wrapper.find('[data-cy=bd-device-row-d1]').exists()).toBe(false)
    expect(wrapper.find('[data-cy=bd-device-row-g9]').exists()).toBe(false)
    expect(wrapper.find('[data-cy=bd-device-row-own]').exists()).toBe(false)
    expect(wrapper.find('[data-cy=bd-device-row-m1]').exists()).toBe(true)
    // El badge cuenta solo lo visible.
    expect(wrapper.find('[data-cy=bd-devices-badge]').text()).toContain('1')
    wrapper.unmount()
  })
})
