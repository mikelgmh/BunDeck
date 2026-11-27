import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { GridStack } from 'gridstack'
import StageBoard from '../components/bundeck/StageBoard.vue'

vi.mock('../composables/useI18n', () => ({
  useI18nStore: () => ({
    t: (key: string) => key,
    currentLocale: { value: 'es' },
    setLocale: () => {},
    loadSavedLocale: () => {}
  })
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
      getCellFromPixel: vi.fn(() => ({ x: 3, y: 2 })),
    })),
  },
}))

const buttons = [
  { id: 'a', page_id: 'p', position: 0, x: 0, y: 0, w: 2, h: 1, data: { label: 'A', actions: [] } },
  { id: 'b', page_id: 'p', position: 1, x: 2, y: 0, w: 1, h: 1, data: { label: 'B', actions: [] } }
] as any

const baseProps = {
  gridCols: 5,
  gridRows: 3,
  keySize: 76,
  selectedButton: null,
  executingButtons: [],
  buttonConfig: {},
  getButton: (pos: number) => buttons.find((b: any) => b.position === pos),
  allButtons: buttons,
  getButtonData: (pos: number) => buttons.find((b: any) => b.position === pos)?.data ?? null,
  displayData: () => null,
  mode: 'edit',
  labelMode: 'a',
  currentPages: [],
  currentPage: { id: 'p', name: 'P', data: {} },
  navTrail: [],
  profileName: '',
  busy: false
} as any

describe('StageBoard GridStack por página', () => {
  it('modo classic usa swapy y oculta gridstack', () => {
    const wrapper = mount(StageBoard, { props: { ...baseProps, layoutMode: 'classic' } })
    expect(wrapper.find('[data-cy=bd-gs-plate]').exists()).toBe(false)
    expect(wrapper.find('[data-cy=bd-layout-gridstack]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('resuelve la apariencia una sola vez por posición y reutiliza el resultado en el render', async () => {
    const displayData = vi.fn((position: number) => ({ label: `Key ${position}` }))
    const wrapper = mount(StageBoard, {
      props: { ...baseProps, displayData, layoutMode: 'classic' }
    })

    expect(displayData).toHaveBeenCalledTimes(buttons.length)
    await wrapper.setProps({ selectedButton: 0 })
    expect(displayData).toHaveBeenCalledTimes(buttons.length)
    wrapper.unmount()
  })

  it('modo gridstack pinta las mismas teclas con span (1×1 por defecto)', async () => {
    const wrapper = mount(StageBoard, { props: { ...baseProps, layoutMode: 'gridstack' } })
    const plate = wrapper.find('[data-cy=bd-gs-plate]')
    expect(plate.exists()).toBe(true)
    const keys = wrapper.findAll('[data-cy=bd-gs-plate] [data-cy=bd-key]')
    expect(keys.length).toBe(2)
    // La primera ocupa 2 columnas: mismo botón, misma interfaz.
    const first = plate.find('.grid-stack-item')
    expect(first.attributes('gs-w')).toBe('2')
    // Sin rejilla de "+" por celda: no hay solape con widgets.
    expect(wrapper.findAll('[data-cy=bd-gs-empty-key]').length).toBe(0)
    wrapper.unmount()
  })

  it('muestra un solo botón Añadir en la barra, también cuando la página está vacía', async () => {
    const wrapper = mount(StageBoard, {
      props: {
        ...baseProps,
        allButtons: [],
        getButton: () => undefined,
        getButtonData: () => null,
        layoutMode: 'gridstack'
      }
    })
    expect(wrapper.find('[data-cy=bd-gs-empty-state]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('bd.gsEmpty')
    // Botón blanco único en la barra central; no hay mensaje ni botón duplicado.
    expect(wrapper.find('[data-cy=bd-gs-add-tool]').exists()).toBe(true)
    expect(wrapper.find('[data-cy=bd-gs-empty-add]').exists()).toBe(false)
    await wrapper.find('[data-cy=bd-gs-add-tool]').trigger('click')
    expect(wrapper.emitted('gs-add')).toHaveLength(1)
    wrapper.unmount()
  })

  it('soltar una acción en el espacio vacío emite la celda y el tipo de acción', async () => {
    const wrapper = mount(StageBoard, {
      props: {
        ...baseProps,
        allButtons: [],
        getButton: () => undefined,
        getButtonData: () => null,
        layoutMode: 'gridstack'
      }
    })
    await vi.waitFor(() => expect(GridStack.init).toHaveBeenCalled())
    await nextTick()
    const getData = vi.fn(() => JSON.stringify({ type: 'utility.delay', name: 'Delay' }))
    await wrapper.find('[data-cy=bd-gs-plate]').trigger('drop', {
      clientX: 180,
      clientY: 140,
      dataTransfer: { getData, types: ['application/json'] }
    })
    expect(wrapper.emitted('action-drop-empty')).toEqual([[3, 2, 'utility.delay']])
    wrapper.unmount()
  })

  it('no muestra el botón Añadir en modo uso', () => {
    const wrapper = mount(StageBoard, {
      props: { ...baseProps, allButtons: [], layoutMode: 'gridstack', mode: 'use' }
    })
    expect(wrapper.find('[data-cy=bd-gs-add-tool]').exists()).toBe(false)
    expect(wrapper.find('[data-cy=bd-gs-empty-state]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('deshabilita Añadir tecla mientras hay una operación de página en curso', async () => {
    const wrapper = mount(StageBoard, {
      props: { ...baseProps, allButtons: [], layoutMode: 'gridstack', busy: false }
    })
    const btn = () => wrapper.find('[data-cy=bd-gs-add-tool]')
    expect(btn().exists()).toBe(true)
    expect(btn().attributes('disabled')).toBeUndefined()
    // Sin pageBusy el clic llega al padre (nada de silent-skip).
    await btn().trigger('click')
    expect(wrapper.emitted('gs-add')).toHaveLength(1)
    // Con pageBusy el botón se deshabilita: el usuario ve por qué no actúa.
    await wrapper.setProps({ busy: true })
    expect(btn().attributes('disabled')).toBeDefined()
    wrapper.unmount()
  })

  it('conserva una celda cuadrada y placa desplazable como el HTML de referencia', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/styles/bundeck.css'), 'utf8')
    const component = readFileSync(resolve(process.cwd(), 'src/components/bundeck/StageBoard.vue'), 'utf8')
    expect(css).toMatch(/\.bd-gs-viewport\s*\{[^}]*overflow-x:\s*auto/s)
    expect(css).toContain('width: calc(var(--bd-c, 5) * var(--bd-gs-unit, calc(var(--bd-ks) + 12px)) + 48px)')
    expect(css).toContain('background-size: var(--bd-gs-unit, calc(var(--bd-ks) + 12px))')
    expect(css).not.toContain('background-size: 104px')
    // Unidad = tecla + 12; margen 6 por lado deja una tecla 1×1 del mismo tamaño.
    expect(component).toMatch(/const GS_GUTTER = 12/)
    expect(component).toMatch(/const GS_MARGIN = 6/)
    expect(component).toMatch(/cellHeight:\s*gsCellSize\.value/)
  })

  it('mantiene visibles widgets cuya geometría excede el ancho actual', () => {
    const oversized = {
      id: 'c',
      page_id: 'p',
      position: 2,
      x: 7,
      y: 1,
      w: 2,
      h: 1,
      data: { label: 'C', actions: [] }
    }
    const wrapper = mount(StageBoard, {
      props: { ...baseProps, allButtons: [...buttons, oversized], layoutMode: 'gridstack' }
    })
    const item = wrapper.find('[gs-id="c"]')
    expect(item.exists()).toBe(true)
    expect(item.attributes('gs-x')).toBe('3')
    expect(item.attributes('gs-w')).toBe('2')
    wrapper.unmount()
  })

  it('toggle emite layout-mode-change', async () => {
    const wrapper = mount(StageBoard, { props: { ...baseProps, layoutMode: 'classic' } })
    await wrapper.find('[data-cy=bd-layout-gridstack]').trigger('click')
    expect(wrapper.emitted('layout-mode-change')).toEqual([['gridstack']])
    wrapper.unmount()
  })

  it('no muestra ningún aviso de hardware en modo libre', () => {
    const plain = mount(StageBoard, { props: { ...baseProps, layoutMode: 'gridstack' } })
    expect(plain.find('[data-cy=bd-gs-hw-warn]').exists()).toBe(false)
    plain.unmount()
  })

  it('inicializa libre en 5×3 con celdas cuadradas y sin juntar widgets', async () => {
    const mockedInit = vi.mocked(GridStack.init)
    mockedInit.mockClear()
    const wrapper = mount(StageBoard, { props: { ...baseProps, layoutMode: 'gridstack' } })
    await nextTick()
    await vi.waitFor(() => {
      expect(mockedInit).toHaveBeenCalled()
    })
    const opts = mockedInit.mock.calls[0]?.[0] as any
    expect(opts.float).toBe(true)
    expect(opts.column).toBe(5)
    expect(opts.minRow).toBe(3)
    expect(opts.cellHeight).toBe(88)
    expect(opts.margin).toBe(6)
    // 88px de unidad - margen 6px por cada lado = 76px, igual al key size.
    expect(opts.cellHeight - opts.margin * 2).toBe(76)
    // Sin compactación con gravedad: los widgets se quedan donde están.
    const instance = mockedInit.mock.results[0]?.value as any
    expect(instance?.compact ?? null).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('conserva widgets en esquinas opuestas sin juntarlos', () => {
    const corners = [
      { id: 'nw', page_id: 'p', position: 0, x: 0, y: 0, w: 1, h: 1, data: { label: 'NW', actions: [] } },
      { id: 'se', page_id: 'p', position: 14, x: 4, y: 2, w: 1, h: 1, data: { label: 'SE', actions: [] } }
    ] as any
    const wrapper = mount(StageBoard, {
      props: {
        ...baseProps,
        allButtons: corners,
        getButton: (pos: number) => corners.find((b: any) => b.position === pos),
        getButtonData: (pos: number) => corners.find((b: any) => b.position === pos)?.data ?? null,
        layoutMode: 'gridstack'
      }
    })
    const nw = wrapper.find('[gs-id="nw"]')
    const se = wrapper.find('[gs-id="se"]')
    expect(nw.exists()).toBe(true)
    expect(se.exists()).toBe(true)
    expect(nw.attributes('gs-x')).toBe('0')
    expect(nw.attributes('gs-y')).toBe('0')
    expect(se.attributes('gs-x')).toBe('4')
    expect(se.attributes('gs-y')).toBe('2')
    wrapper.unmount()
  })

  it('la retícula de puntitos tiene fase estable (no se desplaza al crecer la placa)', () => {
    // Regresión: con `background-position: center` la fase de los puntitos
    // dependía de la altura total (offset = (H-88)/2 mod 88), así que al
    // mover/redimensionar widgets los puntitos "saltaban" media celda y el
    // grid parecía descuadrado respecto a las teclas. Con origen fijo la
    // retícula coincide siempre con el paso de GridStack (unidad 88px).
    const css = readFileSync(resolve(process.cwd(), 'src/styles/bundeck.css'), 'utf8')
    const bdGs = css.match(/\.bundeck\s+\.bd-gs\s*\{[^}]*\}/s)?.[0] ?? ''
    expect(bdGs).toContain('background-position: left top')
    expect(bdGs).not.toContain('background-position: center')
  })

  it('en kiosco la unidad libre es cuadrada (fit): puntitos unit×unit sin scroll interno', () => {
    // Antes la placa de kiosco era fluida (100%) con cellHeight fijo: las
    // celdas no eran cuadradas y los puntitos repartían el ancho con
    // `calc(100%/cols)`. Ahora updateKioskGsFit encaja unit=min(ancho,alto)
    // y la propaga a gs.cellHeight: celdas cuadradas, puntitos unit×unit y
    // sin scroll interno (el scroll lo absorbe .bd-floor).
    const css = readFileSync(resolve(process.cwd(), 'src/styles/bundeck.css'), 'utf8')
    expect(css).toContain('.bundeck.bd-kiosk .bd-gs')
    const kioskGs = css.match(/\.bundeck\.bd-kiosk\s+\.bd-gs\s*\{[^}]*\}/s)?.[0] ?? ''
    expect(kioskGs).toContain('background-size: var(--bd-gs-unit, calc(var(--bd-ks) + 12px)) var(--bd-gs-unit, calc(var(--bd-ks) + 12px))')
    expect(kioskGs).not.toContain('calc(100% / var(--bd-c')
    const kioskViewport = css.match(/\.bundeck\.bd-kiosk\s+\.bd-gs-viewport\s*\{[^}]*\}/s)?.[0] ?? ''
    expect(kioskViewport).toContain('overflow: visible')
    const kioskWrap = css.match(/\.bundeck\.bd-kiosk\s+\.bd-gs-wrap\s*\{[^}]*\}/s)?.[0] ?? ''
    expect(kioskWrap).toContain('var(--bd-gs-unit')
  })

  it('persiste geometría solo al soltar el gesto, nunca al montar (sin "change")', async () => {
    // Regresión: persistir el evento 'change' de GridStack reescribía la
    // geometría guardada en cada visita (init/makeWidget/column emiten
    // 'change' al adoptar y resolver colisiones heredadas: widgets
    // teletransportados por el clamp, solapes "resueltos", nodos fantasma
    // `<id>_1` con PUTs 500). Solo dragstop/resizestop persisten.
    const mockedInit = vi.mocked(GridStack.init)
    mockedInit.mockClear()
    const wrapper = mount(StageBoard, { props: { ...baseProps, layoutMode: 'gridstack' } })
    await vi.waitFor(() => {
      expect(mockedInit).toHaveBeenCalled()
    })
    const instance = mockedInit.mock.results[0]?.value as any
    const wired = (instance.on.mock.calls as any[]).map((c) => c[0])
    expect(wired).toContain('dragstop')
    expect(wired).toContain('resizestop')
    expect(wired).not.toContain('change')
    // Y al soltar emite layout-change con la geometría final del gesto.
    const dragstop = (instance.on.mock.calls as any[]).find((c) => c[0] === 'dragstop')?.[1]
    const el = document.createElement('div')
    el.setAttribute('gs-id', 'a')
    ;(el as any).gridstackNode = { id: 'a', x: 3, y: 1, w: 2, h: 2 }
    dragstop(null, el)
    await vi.waitFor(() => {
      expect(wrapper.emitted('layout-change')).toBeTruthy()
    })
    expect(wrapper.emitted('layout-change')?.[0]).toEqual([[{ id: 'a', x: 3, y: 1, w: 2, h: 2 }]])
    wrapper.unmount()
  })
})
