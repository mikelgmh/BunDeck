import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import StageBoard from '../components/bundeck/StageBoard.vue'
import {
  classicPositionsFit,
  freeContentBounds,
  gridResizeFits,
} from '../composables/useDeckLayouts'
import { GridStack } from 'gridstack'

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

function classicBoard(positions: number[], cols = 5, rows = 3) {
  const set = new Set(positions)
  return mount(StageBoard, {
    props: {
      ...baseProps,
      gridCols: cols,
      gridRows: rows,
      layoutMode: 'classic',
      getButton: (pos: number) => (set.has(pos) ? ({ id: `b${pos}`, position: pos } as any) : undefined),
    },
  })
}

function freeBoard(allButtons: any[], cols = 5, rows = 3) {
  return mount(StageBoard, {
    props: {
      ...baseProps,
      gridCols: cols,
      gridRows: rows,
      layoutMode: 'gridstack',
      allButtons,
    },
  })
}

const decRow = (w: any) => w.find('[data-d="r-1"]')
const decCol = (w: any) => w.find('[data-d="c-1"]')

describe('classicPositionsFit / freeContentBounds', () => {
  it('clásico: la última tecla marca el mínimo', () => {
    expect(classicPositionsFit([0, 1, 14], 5, 3)).toBe(true)
    expect(classicPositionsFit([0, 1, 14], 5, 2)).toBe(false)
    expect(classicPositionsFit([0, 1, 14], 4, 3)).toBe(false)
    expect(classicPositionsFit([], 5, 3)).toBe(true)
  })

  it('libre: la extensión manda sobre filas y columnas', () => {
    const buttons = [{ position: 0, x: 4, y: 2, w: 1, h: 1 }]
    expect(freeContentBounds(buttons, 5)).toEqual({ cols: 5, rows: 3 })
    // Sin geometría deriva de position con las columnas candidatas.
    const legacy = [{ position: 14 }]
    expect(freeContentBounds(legacy, 5)).toEqual({ cols: 5, rows: 3 })
    expect(freeContentBounds(legacy, 4).cols).toBeLessThanOrEqual(4)
  })

  it('libre: la geometría explícita fuera del candidato bloquea (sin reubicar)', () => {
    // El render/GridStack reubicarían el widget, pero la guarda no encoge
    // a espaldas del usuario: x=5 no cabe en 5 columnas.
    const buttons = [{ position: 0, x: 5, y: 0, w: 1, h: 1 }]
    expect(freeContentBounds(buttons, 5)).toEqual({ cols: 6, rows: 1 })
    expect(gridResizeFits('gridstack', [], buttons, 5, 4)).toBe(false)
    expect(gridResizeFits('gridstack', [], buttons, 6, 4)).toBe(true)
  })

  it('gridResizeFits elige criterio según el modo', () => {
    expect(gridResizeFits('classic', [14], [], 5, 2)).toBe(false)
    expect(gridResizeFits('classic', [14], [], 5, 3)).toBe(true)
    const buttons = [{ position: 0, x: 0, y: 2, w: 1, h: 1 }]
    expect(gridResizeFits('gridstack', [], buttons, 5, 2)).toBe(false)
    expect(gridResizeFits('gridstack', [], buttons, 5, 3)).toBe(true)
  })
})

describe('StageBoard: steppers − bloqueados por contenido (reproduce el bug)', () => {
  beforeEach(() => {
    createSwapyMock.mockReset()
    createSwapyMock.mockImplementation(() => ({
      onSwapEnd: vi.fn(),
      destroy: vi.fn(),
      update: vi.fn(),
    }))
    vi.mocked(GridStack.init).mockClear()
  })

  it('clásico 5×3 lleno: no se puede quitar fila ni columna', async () => {
    const full = Array.from({ length: 15 }, (_, i) => i)
    const w = classicBoard(full)
    await nextTick()
    // Incidente real: Filas − bajaba el stepper a 2 pero la placa seguía
    // igual (y la tecla 14 quedaba fuera del grid).
    expect(decRow(w).attributes('disabled')).not.toBeUndefined()
    expect(decCol(w).attributes('disabled')).not.toBeUndefined()
    w.unmount()
  })

  it('clásico con hueco: reducir sí está permitido', async () => {
    const w = classicBoard([0, 1, 2])
    await nextTick()
    expect(decRow(w).attributes('disabled')).toBeUndefined()
    expect(decCol(w).attributes('disabled')).toBeUndefined()
    w.unmount()
  })

  it('libre: el widget de abajo bloquea quitar fila pero no columna', async () => {
    const widgets = [{ id: 'w', position: 0, x: 0, y: 2, w: 2, h: 1, data: {} }]
    const w = freeBoard(widgets)
    await nextTick()
    expect(decRow(w).attributes('disabled')).not.toBeUndefined()
    expect(decCol(w).attributes('disabled')).toBeUndefined()
    w.unmount()
  })

  it('libre: GridStack recibe maxRow para que el arrastre no extienda filas', async () => {
    const widgets = [{ id: 'w', position: 0, x: 0, y: 3, w: 1, h: 1, data: {} }]
    const w = freeBoard(widgets)
    await vi.waitFor(() => {
      expect(GridStack.init).toHaveBeenCalled()
    })
    const opts = vi.mocked(GridStack.init).mock.calls[0][0] as any
    // El desbordamiento ya existente se tolera (no se recoloca nada)…
    expect(opts.maxRow).toBe(4)
    expect(opts.column).toBe(5)
    w.unmount()
  })

  it('libre sin desbordamiento: maxRow es el de la config', async () => {
    const widgets = [{ id: 'w', position: 0, x: 0, y: 0, w: 1, h: 1, data: {} }]
    const w = freeBoard(widgets)
    await vi.waitFor(() => {
      expect(GridStack.init).toHaveBeenCalled()
    })
    const opts = vi.mocked(GridStack.init).mock.calls[0][0] as any
    expect(opts.maxRow).toBe(3)
    w.unmount()
  })
})
