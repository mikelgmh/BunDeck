import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick, reactive } from 'vue'
import StageBoard from '../components/bundeck/StageBoard.vue'

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

interface MiniBtn {
  id: string
  position: number
  label: string
}

function mountBoard(buttons: MiniBtn[], gridCols = 2, gridRows = 1) {
  const getButton = (position: number) => buttons.find((button) => button.position === position)
  const getButtonData = (position: number) => {
    const b = getButton(position)
    return b ? { label: b.label, actions: [{ type: 'shell.shell' }] } : { label: '', actions: [] }
  }
  const wrapper = mount(StageBoard, {
    props: {
      gridCols,
      gridRows,
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
    },
    global: {
      stubs: { ContextMenu: true },
    },
  })
  return wrapper
}

async function flush(times = 3) {
  for (let i = 0; i < times; i++) await nextTick()
}

describe('StageBoard optimistic DOM reconciliation', () => {
  beforeEach(() => {
    createSwapyMock.mockReset()
    createSwapyMock.mockImplementation(() => ({
      onSwapEnd: vi.fn(),
      destroy: vi.fn(),
      update: vi.fn(),
    }))
  })

  it('rebuilds Swapy-moved DOM from optimistic state without reload', async () => {
    const buttons = reactive<MiniBtn[]>([
      { id: 'A', position: 0, label: 'Shell' },
      { id: 'B', position: 1, label: 'HTTP' },
    ])
    const wrapper = mountBoard(buttons)
    // initializeSwapy es async (import dinámico de swapy): esperar al bind.
    await vi.waitFor(() => {
      expect(createSwapyMock).toHaveBeenCalledTimes(1)
    })

    const plate = wrapper.element.querySelector('[data-swapy-container]')!
    const slots = plate.querySelectorAll<HTMLElement>('[data-swapy-slot]')
    const itemA = slots[0].querySelector<HTMLElement>('[data-swapy-item]')!
    const itemB = slots[1].querySelector<HTMLElement>('[data-swapy-item]')!

    // Swapy mueve los nodos DOM sin esperar al render de Vue.
    slots[0].appendChild(itemB)
    slots[1].appendChild(itemA)
    expect(slots[0].querySelector('[data-swapy-item]')?.getAttribute('data-swapy-item')).toBe('item-B')
    expect(slots[1].querySelector('[data-swapy-item]')?.getAttribute('data-swapy-item')).toBe('item-A')

    // El estado optimista se aplica al soltar, sin hacer reload ni esperar API.
    // El watcher de firma detecta el cambio y re-vincula Swapy una sola vez.
    buttons[0].position = 1
    buttons[1].position = 0
    await flush()

    const rebuiltPlate = wrapper.element.querySelector('[data-swapy-container]')!
    expect(rebuiltPlate).not.toBe(plate)
    const rebuiltSlots = rebuiltPlate.querySelectorAll<HTMLElement>('[data-swapy-slot]')
    expect(rebuiltSlots[0].querySelector('[data-swapy-item]')?.getAttribute('data-swapy-item')).toBe('item-B')
    expect(rebuiltSlots[1].querySelector('[data-swapy-item]')?.getAttribute('data-swapy-item')).toBe('item-A')
    expect(rebuiltSlots[0].textContent).toContain('HTTP')
    expect(rebuiltSlots[1].textContent).toContain('Shell')

    // Una sola re-vinculación (la del watcher): el usuario no recarga.
    await vi.waitFor(() => {
      expect(createSwapyMock).toHaveBeenCalledTimes(2)
    })
    wrapper.unmount()
  })

  it('re-binds Swapy when buttons arrive after mount (async API load)', async () => {
    // El mount ocurre con el grid vacío; los botones llegan por API después.
    // Sin re-vinculación, el mapa interno de Swapy quedaría todo `empty` y
    // el primer drag operaría sobre ese mapa rancio (la tecla "vuelve").
    const buttons = reactive<MiniBtn[]>([])
    const wrapper = mountBoard(buttons)
    // initializeSwapy es async (import dinámico de swapy): esperar al bind.
    await vi.waitFor(() => {
      expect(createSwapyMock).toHaveBeenCalledTimes(1)
    })

    buttons.push(
      { id: 'A', position: 0, label: 'Shell' },
      { id: 'B', position: 1, label: 'HTTP' },
    )
    await flush()
    await vi.waitFor(() => {
      expect(createSwapyMock).toHaveBeenCalledTimes(2)
    })
    const plate = wrapper.element.querySelector('[data-swapy-container]')!
    const slots = plate.querySelectorAll<HTMLElement>('[data-swapy-slot]')
    expect(slots[0].querySelector('[data-swapy-item]')?.getAttribute('data-swapy-item')).toBe('item-A')
    expect(slots[1].querySelector('[data-swapy-item]')?.getAttribute('data-swapy-item')).toBe('item-B')
    expect(slots[0].textContent).toContain('Shell')
    wrapper.unmount()
  })
})
