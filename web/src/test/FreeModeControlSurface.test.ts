import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import StageBoard from '../components/bundeck/StageBoard.vue'
import SmartHomeControl from '../components/bundeck/widgets/SmartHomeControl.vue'

vi.mock('../composables/useI18n', () => ({
  useI18nStore: () => ({
    t: (key: string) => key,
    currentLocale: { value: 'es' },
    setLocale: () => {},
    loadSavedLocale: () => {}
  })
}))

const gridstackInstance: any = {
  on: vi.fn(),
  destroy: vi.fn(),
  setStatic: vi.fn(),
  // Como el GridStack real, makeWidget vincula el nodo al elemento.
  makeWidget: vi.fn((el: any) => {
    el.gridstackNode = el.gridstackNode ?? { id: el.getAttribute?.('gs-id') }
    return el
  }),
  column: vi.fn(),
  updateOptions: vi.fn(),
  cellHeight: vi.fn(),
  getCellFromPixel: vi.fn(() => ({ x: 0, y: 0 })),
  refreshDragHandles: vi.fn(),
}

vi.mock('gridstack', () => ({
  GridStack: {
    init: vi.fn(() => gridstackInstance),
  },
}))

const flushPromises = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

function mockResponse(result: any = {}) {
  return { ok: true, json: async () => ({ result }) } as any
}

/** Tecla 1×1 con/sin acción de superficie de control (HA "entidad"). */
function makeButtons(withEntity: boolean) {
  return [
    {
      id: 'ha-1',
      page_id: 'p',
      position: 0,
      x: 0,
      y: 0,
      w: 1,
      h: 1,
      data: withEntity
        ? { label: 'Luz', actions: [{ type: 'homeassistant.entity', parameters: { entityId: 'light.salon' } }] }
        : { label: 'Luz', actions: [] },
    },
  ] as any
}

function stageProps(buttons: any) {
  return {
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
    busy: false,
    layoutMode: 'gridstack',
  } as any
}

describe('Modo libre: la superficie de control no atasca el widget', () => {
  it('re-ata los handles de GridStack al aparecer la acción HA "entidad"', async () => {
    const { GridStack } = await import('gridstack')
    const mockedInit = vi.mocked(GridStack.init)
    mockedInit.mockClear()
    gridstackInstance.refreshDragHandles.mockClear()

    // 1. La tecla nace sin acciones (<button class="bd-key"> como handle).
    const buttons = makeButtons(false)
    const wrapper = mount(StageBoard, { props: stageProps(buttons) })
    await vi.waitFor(() => expect(mockedInit).toHaveBeenCalled())
    await nextTick()
    gridstackInstance.refreshDragHandles.mockClear()

    // 2. Soltar "entidad" sustituye el handle (<button> → <div class="vol-key">).
    //    El guardado muta `data` in-situ (misma identidad de array): la
    //    geometría no cambia, solo la superficie.
    buttons[0].data = {
      label: 'Luz',
      actions: [{ type: 'homeassistant.entity', parameters: { entityId: 'light.salon' } }],
    }
    // Forzar re-render con el mismo contenido geométrico (como el WS `button.updated`).
    await wrapper.setProps({
      allButtons: buttons.slice(),
      getButton: (pos: number) => buttons.find((b: any) => b.position === pos),
      getButtonData: (pos: number) => buttons.find((b: any) => b.position === pos)?.data ?? null,
    })
    await nextTick()
    await nextTick()

    // 3. El widget ahora es superficie de control…
    expect(wrapper.find('[data-cy=bd-key-vol]').exists()).toBe(true)
    // 4. …y GridStack re-escaneó sus handles (si no, el drag queda atado al
    //    <button> destruido y la tecla 1×2 "se atasca" hasta recargar).
    expect(gridstackInstance.refreshDragHandles).toHaveBeenCalled()
    const els = gridstackInstance.refreshDragHandles.mock.calls.map((c: any[]) => c[0])
    expect(els.some((el: any) => el?.getAttribute?.('gs-id') === 'ha-1')).toBe(true)
    wrapper.unmount()
  })

  it('la superficie de control es inerte en edición (los gestos llegan a la tecla)', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/styles/bundeck.css'), 'utf8')
    // Toda la superficie pasa los eventos a la tecla en edición…
    expect(css).toMatch(
      /\.bundeck\s+\.bd-gs\s+\.grid-stack-item:not\(\.ui-draggable-disabled\)\s+\.bd-control-surface\s*\{[^}]*pointer-events:\s*none/s
    )
    // …menos el badge de "sin configurar" (acceso al drawer)…
    expect(css).toMatch(/\.bd-control-surface\s+\.bd-needs-config\s*\{[^}]*pointer-events:\s*auto/s)
    // …y solo en edición: la regla vive bajo :not(.ui-draggable-disabled)
    // (en uso GridStack marca los items y los controles siguen vivos).
    expect(css).toMatch(/\.grid-stack-item:not\(\.ui-draggable-disabled\)\s+\.bd-control-surface\s*\{[^}]*pointer-events:\s*none/s)
  })

  it('el refresh de HA está deshabilitado en edición y no dispara red en uso al pulsarlo', async () => {
    const fetchMock = vi.fn(async () => mockResponse({ state: 'on' }))
    vi.stubGlobal('fetch', fetchMock)

    const action = { type: 'homeassistant.entity', parameters: { entityId: 'light.salon' } }
    // Edición: botón visible pero deshabilitado (no traga el gesto ni dispara).
    const edit = mount(SmartHomeControl, {
      props: { action, apiBase: 'http://localhost:3001', readonly: true },
    })
    await flushPromises()
    const refresh = edit.find('button.refresh')
    expect(refresh.exists()).toBe(true)
    expect(refresh.attributes('disabled')).toBeDefined()
    edit.unmount()

    // Uso: pulsar refresh lee el estado (`action: 'read'`).
    fetchMock.mockClear()
    const use = mount(SmartHomeControl, {
      props: { action, apiBase: 'http://localhost:3001', readonly: false },
    })
    await flushPromises()
    fetchMock.mockClear()
    await use.find('button.refresh').trigger('click')
    await flushPromises()
    expect(fetchMock).toHaveBeenCalled()
    const body = JSON.parse(fetchMock.mock.calls[0][1]!.body as string)
    expect(body.action.type).toBe('homeassistant.entity')
    expect(body.action.parameters.action).toBe('read')
    use.unmount()
    vi.unstubAllGlobals()
  })
})
