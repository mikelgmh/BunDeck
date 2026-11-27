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

const volActions = [{ id: 'a1', type: 'audio-mixer.volume-control', parameters: {} }]

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
      ? { id: 'b-vol', page_id: 'p1', position: 0, data: { label: 'Volumen', actions: volActions } }
      : undefined,
  allButtons: [
    { id: 'b-vol', page_id: 'p1', position: 0, x: 0, y: 0, w: 1, h: 1, data: { label: 'Volumen', actions: volActions } }
  ],
  getButtonData: (position: number) =>
    position === 0 ? { label: 'Volumen', actions: volActions } : {},
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

describe('StageBoard modo libre: control por acción', () => {
  it('renderiza el control cuando la tecla tiene la acción volume-control', async () => {
    const free = mount(StageBoard, { props: baseProps() as any })
    expect(free.find('[data-cy="bd-key-vol"]').exists()).toBe(true)
    expect(free.find('[data-cy="vol-range-stub"]').exists()).toBe(true)
    // La tecla normal no aparece para esa posición: solo HTML del control.
    expect(free.findAll('[data-cy="bd-key"]').length).toBe(0)
    free.unmount()
  })

  it('acepta el legado widget_type volume sin acción', async () => {
    const legacy = mount(StageBoard, {
      props: baseProps({
        getButton: () => ({ id: 'b-vol', page_id: 'p1', position: 0, widget_type: 'volume', data: { label: 'Volumen', actions: [] } }),
        getButtonData: () => ({ label: 'Volumen', actions: [] })
      }) as any
    })
    expect(legacy.find('[data-cy="bd-key-vol"]').exists()).toBe(true)
    legacy.unmount()
  })

  it('en modo clásico el control no se representa (tecla estándar)', async () => {
    const classic = mount(StageBoard, {
      props: baseProps({ layoutMode: 'classic' }) as any
    })
    expect(classic.find('[data-cy="bd-key-vol"]').exists()).toBe(false)
    classic.unmount()
  })

  it('sin acción de control pinta tecla estándar con icono/texto', async () => {
    const plain = mount(StageBoard, {
      props: baseProps({
        getButton: () => ({ id: 'b1', page_id: 'p1', position: 0, data: { label: 'Play', actions: [{ id: 'x', type: 'shell.shell', parameters: { command: 'true' } }] } }),
        getButtonData: () => ({ label: 'Play', actions: [] })
      }) as any
    })
    expect(plain.find('[data-cy="bd-key-vol"]').exists()).toBe(false)
    plain.unmount()
  })

  it('no hay botón especial de volumen: se añade desde la biblioteca como acción', async () => {
    const freeEdit = mount(StageBoard, { props: baseProps({ mode: 'edit' }) as any })
    expect(freeEdit.find('[data-cy="bd-gs-add-tool"]').exists()).toBe(true)
    expect(freeEdit.find('[data-cy="bd-gs-add-vol"]').exists()).toBe(false)
    expect(freeEdit.emitted('gs-add-volume')).toBeUndefined()
    freeEdit.unmount()
  })

  it('pulsar la tecla de volumen en edición la selecciona (emite su posición)', async () => {
    // Regresión: el template llamaba onKeyClick(b.position) sin $event, así
    // que `position` llegaba como undefined, la selección se perdía y añadir
    // acciones desde la biblioteca no creaba tecla ni guardaba nada.
    const freeEdit = mount(StageBoard, { props: baseProps({ mode: 'edit' }) as any })
    await freeEdit.find('[data-cy="bd-key-vol"]').trigger('click')
    expect(freeEdit.emitted('button-click')).toEqual([[0]])
    freeEdit.unmount()
  })

  it('pulsar la tecla de volumen en uso no dispara la tecla (se usa el slider)', async () => {
    const freeUse = mount(StageBoard, { props: baseProps({ mode: 'use' }) as any })
    await freeUse.find('[data-cy="bd-key-vol"]').trigger('click')
    expect(freeUse.emitted('button-tap')).toBeUndefined()
    expect(freeUse.emitted('button-click')).toBeUndefined()
    freeUse.unmount()
  })

  it('el clic dentro del control (elemento interno) selecciona la tecla en edición', async () => {
    // Regresión fiel al navegador: el clic real cae en elementos INTERNOS de
    // la superficie. Con el `@click.stop` incondicional nunca burbujeaba a
    // `.bd-key-vol` y el inspector no se abría ("Elige una tecla"); el test
    // anterior disparaba el clic sobre el propio wrapper, donde el stop no
    // interviene, y por eso pasaba en verde con el bug presente.
    const freeEdit = mount(StageBoard, { props: baseProps({ mode: 'edit' }) as any })
    await freeEdit.find('[data-cy="vol-range-stub"]').trigger('click')
    expect(freeEdit.emitted('button-click')).toEqual([[0]])
    freeEdit.unmount()
  })

  it('el clic dentro del control no dispara nada en uso', async () => {
    const freeUse = mount(StageBoard, { props: baseProps({ mode: 'use' }) as any })
    await freeUse.find('[data-cy="vol-range-stub"]').trigger('click')
    expect(freeUse.emitted('button-tap')).toBeUndefined()
    expect(freeUse.emitted('button-click')).toBeUndefined()
    freeUse.unmount()
  })
})
