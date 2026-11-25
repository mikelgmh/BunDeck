import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import StageBoard from '../components/bundeck/StageBoard.vue'
import KeyInspector from '../components/bundeck/KeyInspector.vue'
import ActionsPanel from '../components/bundeck/ActionsPanel.vue'

const { createSwapyMock } = vi.hoisted(() => ({
  createSwapyMock: vi.fn(),
}))

vi.mock('swapy', () => ({
  createSwapy: createSwapyMock,
}))

vi.mock('../composables/useI18n', () => ({
  useI18nStore: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('../components/SchemaForm.vue', () => ({
  default: { name: 'SchemaForm', template: '<div class="schema-stub" />' },
}))

beforeEach(() => {
  createSwapyMock.mockReset()
  createSwapyMock.mockImplementation(() => ({
    onSwapEnd: vi.fn(),
    destroy: vi.fn(),
    update: vi.fn(),
  }))
})

const boardProps = (buttons: Array<{ id: string; position: number }>) => {
  const getButton = (position: number) => buttons.find((b) => b.position === position) as any
  const getButtonData = (position: number) => {
    const b = getButton(position)
    return b ? { label: 'X', actions: [{ type: 'shell', parameters: {} }] } : { label: '', actions: [] }
  }
  return {
    gridCols: 2,
    gridRows: 1,
    selectedButton: null,
    executingButtons: [],
    buttonConfig: {},
    getButton,
    getButtonData,
    mode: 'edit',
    labelMode: 'a',
    currentPages: [],
    currentPage: null,
    navTrail: [],
    profileName: 'Test',
    busy: false,
  } as any
}

describe('StageBoard contextmenu de registros', () => {
  it('clic derecho muestra bd-ctx-logs y emite button-logs con la posición', async () => {
    const wrapper = mount(StageBoard, { props: boardProps([{ id: 'b1', position: 0 }]) })
    await flushPromises()

    const key = wrapper.findAll('[data-cy="bd-key"]')[0]
    await key.trigger('contextmenu', { clientX: 10, clientY: 20 } as any)
    await flushPromises()

    const logsItem = wrapper.find('[data-cy="bd-ctx-logs"]')
    expect(logsItem.exists()).toBe(true)
    await logsItem.trigger('click')
    await flushPromises()

    expect(wrapper.emitted('button-logs')).toEqual([[0]])
    wrapper.unmount()
  })

  it('sin botón no hay item de registros', async () => {
    const wrapper = mount(StageBoard, { props: boardProps([]) })
    await flushPromises()

    const key = wrapper.findAll('[data-cy="bd-key"]')[0]
    await key.trigger('contextmenu', { clientX: 10, clientY: 20 } as any)
    await flushPromises()

    expect(wrapper.find('[data-cy="bd-ctx-logs"]').exists()).toBe(false)
    expect(wrapper.emitted('button-logs')).toBeFalsy()
    wrapper.unmount()
  })
})

describe('KeyInspector registros', () => {
  const inspectorProps = {
    mode: 'edit',
    selectedPosition: 0,
    hasButton: true,
    row: 0,
    col: 0,
    plugins: [],
    availablePages: [],
    buttonConfig: {
      label: 'X',
      actions: [{ id: 'a1', type: 'shell', parameters: {} }],
    },
  } as any

  it('el menú de la tecla tiene «Ver registros» (bd-key-menu-logs → view-logs)', async () => {
    const wrapper = mount(KeyInspector, { props: inspectorProps })
    await wrapper.find('[aria-label="bd.keyOptions"]').trigger('click')

    const logs = wrapper.find('[data-cy="bd-key-menu-logs"]')
    expect(logs.exists()).toBe(true)
    await logs.trigger('click')
    expect(wrapper.emitted('view-logs')).toHaveLength(1)
    wrapper.unmount()
  })

  it('contextmenu en la fila de acción emite action-logs {kind,index,actionType}', async () => {
    const wrapper = mount(KeyInspector, { props: inspectorProps })
    await flushPromises()

    const row = wrapper.find('[data-cy="bd-action-row"]')
    expect(row.exists()).toBe(true)
    await row.trigger('contextmenu', { clientX: 10, clientY: 20 } as any)
    await flushPromises()

    const item = wrapper.find('[data-cy="bd-ctx-action-logs"]')
    expect(item.exists()).toBe(true)
    await item.trigger('click')
    expect(wrapper.emitted('action-logs')).toEqual([
      [{ kind: 'click', index: 0, actionType: 'shell' }],
    ])
    wrapper.unmount()
  })
})

describe('ActionsPanel registros', () => {
  const plugins = [
    [
      'page',
      {
        manifest: { name: 'Page Navigation' },
        actions: [['page', { name: 'Navigate', icon: 'FileText' }]],
      },
    ],
  ] as any

  it('la fila lleva data-action-type y el contextmenu emite action-logs', async () => {
    const wrapper = mount(ActionsPanel, { props: { plugins } })
    const rows = wrapper.findAll('[data-cy="bd-action-item"]')
    // 3 locales + 1 de plugin.
    expect(rows).toHaveLength(4)
    const pageRow = rows[3]
    expect(pageRow.attributes('data-action-type')).toBe('page.page')

    await pageRow.trigger('contextmenu', { clientX: 10, clientY: 20 } as any)
    await flushPromises()

    const item = wrapper.find('[data-cy="bd-ctx-action-logs"]')
    expect(item.exists()).toBe(true)
    await item.trigger('click')
    expect(wrapper.emitted('action-logs')).toEqual([[{ actionType: 'page.page' }]])
    wrapper.unmount()
  })
})
