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
      cellHeight: vi.fn(),
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

describe('StageBoard kiosco + libre: la unidad encaja sin recortar 2×2', () => {
  beforeEach(() => {
    createSwapyMock.mockReset()
    createSwapyMock.mockImplementation(() => ({
      onSwapEnd: vi.fn(),
      destroy: vi.fn(),
      update: vi.fn(),
    }))
  })

  it('widget 2×2: --bd-gs-unit cabe en el viewport y se propaga a cellHeight', async () => {
    const { GridStack } = await import('gridstack')
    const initMock = GridStack.init as unknown as ReturnType<typeof vi.fn>
    initMock.mockClear()
    // Viewport determinista: sin visualViewport jsdom cae a clientWidth=0.
    const vvDesc = Object.getOwnPropertyDescriptor(window, 'visualViewport')
    Object.defineProperty(window, 'visualViewport', {
      value: { width: 1280, height: 800, addEventListener: vi.fn(), removeEventListener: vi.fn() },
      configurable: true,
    })
    try {
      const big = { id: 'big', page_id: 'p', position: 0, x: 0, y: 0, w: 2, h: 2, data: { label: 'B', actions: [] } }
      const wrapper = mount(StageBoard, {
        props: {
          ...baseProps,
          kiosk: true,
          mode: 'use',
          layoutMode: 'gridstack',
          gridCols: 5,
          gridRows: 3,
          allButtons: [big],
          getButton: (pos: number) => (pos === 0 ? big : undefined),
          getButtonData: (pos: number) => (pos === 0 ? big.data : null),
        },
      })
      await nextTick()
      await nextTick()
      await flushPromisesIfAvailable()
      // El fit de kiosco ya corrió: cols=5, total=3 → unit=min(1232/5, 752/3)=246.
      const wrap = () => wrapper.find('.bd-gs-wrap')
      let unit = NaN
      await vi.waitFor(() => {
        const style = wrap().attributes('style') ?? ''
        const m = style.match(/--bd-gs-unit:\s*(\d+)px/)
        expect(m).not.toBeNull()
        unit = Number(m![1])
        expect(unit).toBe(246)
      })
      // Cabe a lo ancho y a lo alto (wrap padding 48 por lado).
      expect(unit * 5 + 48).toBeLessThanOrEqual(1280)
      expect(unit * 3 + 48).toBeLessThanOrEqual(800)
      // GridStack recibe la unidad cuadrada: o bien en el init, o bien vía
      // el watcher de kioskFit → gs.cellHeight(unit) sin re-crear.
      await vi.waitFor(() => {
        expect(initMock).toHaveBeenCalled()
      })
      const initUnit = (initMock.mock.calls as any[])
        .map((c) => c?.[0]?.cellHeight)
        .filter((v) => typeof v === 'number')
      const pushedUnits = initMock.mock.results
        .map((r) => (r?.value as any)?.cellHeight)
        .filter((fn) => typeof fn === 'function')
        .flatMap((fn: any) => fn.mock.calls.map((c: any[]) => c?.[0]))
        .filter((v: any) => typeof v === 'number')
      expect([...initUnit, ...pushedUnits]).toContain(246)
      wrapper.unmount()
    } finally {
      if (vvDesc) Object.defineProperty(window, 'visualViewport', vvDesc)
      else delete (window as any).visualViewport
    }
  })
})

async function flushPromisesIfAvailable() {
  const { flushPromises } = await import('@vue/test-utils')
  await flushPromises()
}
