import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import StageBoard from '../components/bundeck/StageBoard.vue'
import { createKeyEngine } from '../composables/useKeyEngine'
import { setVarValue, getVar, displayTick } from '../composables/useVars'

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
      column: vi.fn(),
      updateOptions: vi.fn(),
    })),
  },
}))

const buttons = [
  { id: 'a', page_id: 'p', position: 0, x: 0, y: 0, w: 1, h: 1, data: { label: 'A', actions: [] } },
  { id: 'b', page_id: 'p', position: 1, x: 1, y: 0, w: 1, h: 1, data: { label: 'B', actions: [] } },
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
  busy: false,
} as any

describe('render perf (fase A)', () => {
  it('displayData se llama 1x por tecla visible aunque el template lea N props, y el tick no lo invalida', async () => {
    const displayData = vi.fn((position: number) => ({ label: `Key ${position}` }))
    const wrapper = mount(StageBoard, {
      props: { ...baseProps, displayData, layoutMode: 'classic' },
    })
    // 2 teclas ocupadas de 15 celdas: ni las vacías ni los ~10 helpers por tecla re-llaman.
    expect(displayData).toHaveBeenCalledTimes(2)
    // Forzar re-render completo: los helpers leen de los Maps, sin re-evaluar.
    await (wrapper.vm as any).$forceUpdate()
    await nextTick()
    expect(displayData).toHaveBeenCalledTimes(2)
    // El tick global de 1 s tampoco re-dispara displayData por sí solo.
    displayTick.value++
    await nextTick()
    expect(displayData).toHaveBeenCalledTimes(2)
    wrapper.unmount()
  })

  it('resolveDisplay memoiza teclas estaticas entre ticks e invalida por vars usadas', () => {
    const prev = getVar('contador')?.v ?? 0
    try {
      const store = new Map<number, any>([
        [0, { label: 'Fija', icon: 'Zap', actions: [] }],
        [1, { label: 'N: {{contador}}', icon: 'Zap', actions: [] }],
        [2, { label: 'Base', icon: 'Zap', looks: [{ cond: 'contador > 10', t: 'Grande', i: 'Zap' }], actions: [] }],
        [3, { label: 'T', icon: 'Zap', looks: [{ cond: 'segundo >= 0', t: 'S', i: 'Zap' }], actions: [] }],
      ])
      const engine = createKeyEngine({
        getButton: (pos: number) => ({ id: `k${pos}` }) as any,
        getExecData: (pos: number) => store.get(pos) ?? null,
        execRemote: async () => {},
        toast: () => {},
        noActionsToast: () => {},
        profileName: () => 'P',
        pageName: () => 'Pg',
        pageId: () => 'p',
        executing: { value: [] },
      })

      // Estática: mismo objeto entre ticks (sin reevaluar).
      const s1 = engine.resolveDisplay(0)
      displayTick.value++
      const s2 = engine.resolveDisplay(0)
      expect(s2).toBe(s1)

      // Dinámica por var: reacciona al cambio y luego memoiza entre ticks.
      setVarValue('contador', 5)
      const d1 = engine.resolveDisplay(1)
      expect(d1.label).toBe('N: 5')
      displayTick.value++
      const d2 = engine.resolveDisplay(1)
      expect(d2).toBe(d1)
      // Otra var no usada no invalida.
      setVarValue('modoDirecto', 'noche')
      const d3 = engine.resolveDisplay(1)
      expect(d3).toBe(d1)

      // Looks condicional: cambia con la var observada.
      const l1 = engine.resolveDisplay(2)
      expect(l1.label).toBe('Base')
      setVarValue('contador', 20)
      const l2 = engine.resolveDisplay(2)
      expect(l2.label).toBe('Grande')
      expect(l2).not.toBe(l1)

      // Dependiente del tiempo: el tick sí invalida.
      const t1 = engine.resolveDisplay(3)
      displayTick.value++
      const t2 = engine.resolveDisplay(3)
      expect(t2).not.toBe(t1)
    } finally {
      setVarValue('contador', prev)
    }
  })
})
