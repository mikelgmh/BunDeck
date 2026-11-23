import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import StageBoard from '../components/bundeck/StageBoard.vue'
import { clampDropCell, planFreeCell } from '../composables/useDeckLayouts'

const { createSwapyMock } = vi.hoisted(() => ({
  createSwapyMock: vi.fn(),
}))

vi.mock('swapy', () => ({
  createSwapy: createSwapyMock,
}))

vi.mock('../composables/useI18n', () => ({
  useI18nStore: () => ({
    t: (key: string) => key,
    currentLocale: { value: 'es' },
    setLocale: () => {},
    loadSavedLocale: () => {},
  }),
}))

vi.mock('gridstack', () => ({
  GridStack: {
    init: vi.fn(() => ({
      on: vi.fn(),
      destroy: vi.fn(),
      setStatic: vi.fn(),
      makeWidget: vi.fn(),
      compact: vi.fn(),
      column: vi.fn(),
      updateOptions: vi.fn(),
      getCellFromPixel: vi.fn(() => ({ x: 0, y: 0 })),
    })),
  },
}))

const baseProps = {
  gridCols: 5,
  gridRows: 3,
  keySize: 76,
  selectedButton: null,
  executingButtons: [],
  buttonConfig: {},
  getButton: () => undefined,
  allButtons: [],
  getButtonData: () => null,
  displayData: () => null,
  mode: 'edit',
  labelMode: 'a',
  currentPages: [],
  currentPage: { id: 'p', name: 'P', data: {} },
  navTrail: [],
  profileName: '',
  busy: false,
} as any

describe('clampDropCell (drops acotados al grid visible)', () => {
  it('recorta coordenadas fuera del grid', () => {
    expect(clampDropCell(2, 1, 5, 3)).toEqual({ x: 2, y: 1 })
    // Suelta debajo de la placa: antes persistía y=50 y el grid crecía a
    // decenas de filas con el stepper en 3.
    expect(clampDropCell(2, 50, 5, 3)).toEqual({ x: 2, y: 2 })
    expect(clampDropCell(99, 99, 5, 3)).toEqual({ x: 4, y: 2 })
    expect(clampDropCell(-3, -1, 5, 3)).toEqual({ x: 0, y: 0 })
  })

  it('tolera no-numéricos sin NaN', () => {
    expect(clampDropCell(undefined, null, 5, 3)).toEqual({ x: 0, y: 0 })
    expect(clampDropCell(2.9, 1.7, 5, 3)).toEqual({ x: 2, y: 1 })
  })
})

describe('planFreeCell acotado', () => {
  it('con el grid lleno extiende como mucho una fila, nunca 50', () => {
    const full: any[] = []
    for (let pos = 0; pos < 15; pos++) {
      full.push({ id: `b${pos}`, position: pos, x: pos % 5, y: Math.floor(pos / 5), w: 1, h: 1, data: {} })
    }
    const spot = planFreeCell(full, 5, 3)
    expect(spot).not.toBeNull()
    expect(spot!.y).toBeLessThanOrEqual(3)
  })

  it('ignora la position legacy para la ocupación (caso position 99)', () => {
    const buttons = [
      { id: 'a', position: 0, x: null, y: null, w: 1, h: 1, data: {} },
      { id: 'stale', position: 99, x: null, y: null, w: 1, h: 1, data: {} },
    ] as any
    const spot = planFreeCell(buttons, 5, 3)
    // La tecla 99 ocupa su celda derivada, pero el primer hueco sigue
    // estando dentro del grid configurado.
    expect(spot).not.toBeNull()
    expect(spot!.y).toBeLessThanOrEqual(3)
  })
})

describe('StageBoard filas renderizadas == filas configuradas', () => {
  beforeEach(() => {
    createSwapyMock.mockReset()
    createSwapyMock.mockImplementation(() => ({
      onSwapEnd: vi.fn(),
      destroy: vi.fn(),
      update: vi.fn(),
    }))
  })

  it('una tecla legacy con position fuera del grid no estira la placa', async () => {
    // Reproducción del incidente real: position 99 en 5×3 caía en y=19 y
    // --bd-total-r salía 20 ("tropecientas filas" con el stepper en 3).
    const legacy = { id: 'stale', page_id: 'p', position: 99, x: null, y: null, w: 1, h: 1, data: { label: 'S', actions: [] } }
    const first = { id: 'a', page_id: 'p', position: 0, x: 0, y: 0, w: 1, h: 1, data: { label: 'A', actions: [] } }
    const wrapper = mount(StageBoard, {
      props: {
        ...baseProps,
        allButtons: [first, legacy],
        getButton: (pos: number) => [first, legacy].find((b: any) => b.position === pos),
        getButtonData: (pos: number) => [first, legacy].find((b: any) => b.position === pos)?.data ?? null,
        layoutMode: 'gridstack',
      },
    })
    await nextTick()
    const wrap = wrapper.find('.bd-gs-wrap')
    expect(wrap.attributes('style') ?? '').toContain('--bd-total-r: 3')
    const stale = wrapper.find('[gs-id="stale"]')
    expect(stale.exists()).toBe(true)
    // Envuelta a las filas configuradas en vez de y=19.
    expect(Number(stale.attributes('gs-y'))).toBeLessThan(3)
    wrapper.unmount()
  })

  it('la placa libre no se pinta sin posicionar (sin flash)', async () => {
    const wrapper = mount(StageBoard, {
      props: { ...baseProps, layoutMode: 'gridstack' },
    })
    const plate = () => wrapper.find('[data-cy=bd-gs-plate]')
    // Antes de que GridStack adopte los nodos: oculta pero con sitio.
    expect(plate().attributes('style') ?? '').toContain('visibility: hidden')
    expect(plate().classes()).not.toContain('bd-gs--ready')
    await vi.waitFor(() => {
      expect(plate().classes()).toContain('bd-gs--ready')
    })
    expect(plate().attributes('style') ?? '').not.toContain('visibility: hidden')
    wrapper.unmount()
  })

  it('volver de Libre a Fija re-vincula Swapy (el drag no queda muerto)', async () => {
    const wrapper = mount(StageBoard, { props: { ...baseProps, layoutMode: 'classic' } })
    await vi.waitFor(() => {
      expect(createSwapyMock).toHaveBeenCalledTimes(1)
    })
    const firstInstance = createSwapyMock.mock.results[0]?.value

    // Ida a Libre: se suelta Swapy (su DOM se desmonta).
    await wrapper.setProps({ layoutMode: 'gridstack' })
    await nextTick()
    expect(firstInstance.destroy).toHaveBeenCalled()

    // Vuelta a Fija: Swapy se crea de nuevo sobre la placa remontada.
    // Antes la instancia vieja (atada a nodos muertos) bloqueaba el re-bind
    // y el drag & drop clásico quedaba bloqueado tras el round-trip.
    await wrapper.setProps({ layoutMode: 'classic' })
    await vi.waitFor(() => {
      expect(createSwapyMock).toHaveBeenCalledTimes(2)
    })
    wrapper.unmount()
  })
})
