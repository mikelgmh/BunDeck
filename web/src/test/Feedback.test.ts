import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import StageBoard from '../components/bundeck/StageBoard.vue'
import { __resetFeedbackAudio, playClick, vibrate, pressFeedback } from '../composables/useFeedback'
import { bdClickSound, bdHaptic, bdSetClickSound, bdSetHaptic } from '../composables/useBunDeckUi'

vi.mock('../composables/useI18n', () => ({
  useI18nStore: () => ({
    t: (key: string) => key,
    currentLocale: { value: 'es' },
    setLocale: () => {},
    loadSavedLocale: () => {},
  }),
}))

// ---- Mocks de Web Audio ----
function makeAudioMocks() {
  const osc = {
    type: '',
    frequency: { setValueAtTime: vi.fn() },
    connect: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  }
  const gainParam = { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() }
  const gain = { gain: gainParam, connect: vi.fn() }
  osc.connect.mockReturnValue({ connect: vi.fn() })
  const instances: any[] = []
  class MockAC {
    currentTime = 10
    state = 'running'
    destination = {}
    resume = vi.fn().mockResolvedValue(undefined)
    createOscillator() {
      instances.push(osc)
      return osc
    }
    createGain() {
      return gain
    }
  }
  return { osc, gain, gainParam, instances, MockAC }
}

const VIB_KEY = 'vibrate'
let origVibrateDesc: PropertyDescriptor | undefined
let origAC: unknown

beforeEach(() => {
  __resetFeedbackAudio()
  origVibrateDesc = Object.getOwnPropertyDescriptor(navigator, VIB_KEY)
  origAC = (window as any).AudioContext
  bdSetClickSound(false)
  bdSetHaptic(true)
  vi.useRealTimers()
})

afterEach(() => {
  // Restaurar navigator.vibrate a su estado original
  try {
    if (origVibrateDesc) Object.defineProperty(navigator, VIB_KEY, origVibrateDesc)
    else delete (navigator as any)[VIB_KEY]
  } catch { /* noop */ }
  ;(window as any).AudioContext = origAC
  bdSetClickSound(false)
  bdSetHaptic(true)
  vi.useRealTimers()
  vi.unstubAllGlobals?.()
})

const uiKey = () => JSON.parse(localStorage.getItem('bundeck:ui') ?? '{}')

describe('useFeedback: toggles + Web Audio', () => {
  it('playClick no hace nada si el sonido está apagado', () => {
    const { MockAC, instances } = makeAudioMocks()
    ;(window as any).AudioContext = MockAC
    bdSetClickSound(false)
    playClick()
    expect(instances.length).toBe(0)
    expect(bdClickSound.value).toBe(false)
  })

  it('playClick suena (oscilador corto) si está activado', () => {
    const { MockAC, osc, instances } = makeAudioMocks()
    ;(window as any).AudioContext = MockAC
    bdSetClickSound(true)
    playClick()
    expect(instances.length).toBe(1)
    expect(osc.frequency.setValueAtTime).toHaveBeenCalled()
    expect(osc.start).toHaveBeenCalled()
    expect(osc.stop).toHaveBeenCalled()
  })

  it('playClick no revienta sin AudioContext', () => {
    ;(window as any).AudioContext = undefined
    bdSetClickSound(true)
    expect(() => playClick()).not.toThrow()
  })
})

describe('useFeedback: vibrate con guard', () => {
  it('no vibra si el toggle háptico está apagado', () => {
    const fn = vi.fn().mockReturnValue(true)
    Object.defineProperty(navigator, VIB_KEY, { value: fn, configurable: true })
    bdSetHaptic(false)
    expect(vibrate(20)).toBe(false)
    expect(fn).not.toHaveBeenCalled()
  })

  it('no vibra si el navegador no lo soporta', () => {
    // jsdom no trae navigator.vibrate: `'vibrate' in navigator` es false
    expect('vibrate' in navigator).toBe(false)
    bdSetHaptic(true)
    expect(vibrate(20)).toBe(false)
  })

  it('vibra con el patrón dado si está activado y soportado', () => {
    const fn = vi.fn().mockReturnValue(true)
    Object.defineProperty(navigator, VIB_KEY, { value: fn, configurable: true })
    bdSetHaptic(true)
    expect(vibrate([15, 30, 25])).toBe(true)
    expect(fn).toHaveBeenCalledWith([15, 30, 25])
  })
})

describe('useFeedback: pressFeedback por tipo', () => {
  it('long combina clic + patrón largo', () => {
    const { MockAC, instances } = makeAudioMocks()
    ;(window as any).AudioContext = MockAC
    const fn = vi.fn().mockReturnValue(true)
    Object.defineProperty(navigator, VIB_KEY, { value: fn, configurable: true })
    bdSetClickSound(true)
    bdSetHaptic(true)
    pressFeedback('long')
    expect(instances.length).toBe(1)
    expect(fn).toHaveBeenCalledWith([25, 40, 60])
  })

  it('respeta ambos toggles apagados (silencio total)', () => {
    const { MockAC, instances } = makeAudioMocks()
    ;(window as any).AudioContext = MockAC
    const fn = vi.fn().mockReturnValue(true)
    Object.defineProperty(navigator, VIB_KEY, { value: fn, configurable: true })
    bdSetClickSound(false)
    bdSetHaptic(false)
    pressFeedback('double')
    expect(instances.length).toBe(0)
    expect(fn).not.toHaveBeenCalled()
  })
})

describe('useFeedback: persistencia en bundeck:ui', () => {
  it('los toggles se guardan en bundeck:ui (no en el mock)', () => {
    bdSetClickSound(true)
    bdSetHaptic(false)
    const saved = uiKey()
    expect(saved.clickSound).toBe(true)
    expect(saved.haptic).toBe(false)
  })
})

// ---- Integración StageBoard ----
const buttons = [
  {
    id: 'a',
    page_id: 'p',
    position: 0,
    data: {
      label: 'A',
      actions: [{ id: 'c1', type: 'shell', parameters: {} }],
      rules: [{ id: 'r1', on: true, when: 'long', cond: '', then: [], else: [] }],
    },
  },
] as any

const baseProps = {
  gridCols: 5,
  gridRows: 3,
  keySize: 76,
  layoutMode: 'classic',
  selectedButton: null,
  executingButtons: [],
  buttonConfig: {},
  getButton: (pos: number) => buttons.find((b: any) => b.position === pos),
  allButtons: buttons,
  getButtonData: (pos: number) => buttons.find((b: any) => b.position === pos)?.data ?? null,
  mode: 'use',
  labelMode: 'a',
  currentPages: [],
  currentPage: { id: 'p', name: 'P', data: {} },
  navTrail: [],
  profileName: '',
  busy: false,
  longPressMs: 200,
} as any

describe('StageBoard llama al feedback si está activado', () => {
  it('tap corto: vibra + clic con toggles on; silencio con toggles off', async () => {
    const { MockAC, instances } = makeAudioMocks()
    ;(window as any).AudioContext = MockAC
    const fn = vi.fn().mockReturnValue(true)
    Object.defineProperty(navigator, VIB_KEY, { value: fn, configurable: true })
    bdSetClickSound(true)
    bdSetHaptic(true)

    const wrapper = mount(StageBoard, { props: { ...baseProps } })
    const key = wrapper.find('[data-cy="bd-key"]')
    await key.trigger('pointerdown', { button: 0, clientX: 10, clientY: 10 })
    await key.trigger('pointerup', { button: 0, clientX: 10, clientY: 10 })
    expect(wrapper.emitted('button-tap')).toEqual([[0]])
    expect(fn).toHaveBeenCalled()
    expect(instances.length).toBe(1)

    // Toggles off → la pulsación sigue emitiendo pero sin feedback
    fn.mockClear()
    instances.length = 0
    __resetFeedbackAudio()
    bdSetClickSound(false)
    bdSetHaptic(false)
    await key.trigger('pointerdown', { button: 0, clientX: 10, clientY: 10 })
    await key.trigger('pointerup', { button: 0, clientX: 10, clientY: 10 })
    expect(wrapper.emitted('button-tap')?.length).toBe(2)
    expect(fn).not.toHaveBeenCalled()
    expect(instances.length).toBe(0)
    wrapper.unmount()
  })

  it('long-press: vibra con el patrón largo', async () => {
    vi.useFakeTimers()
    const { MockAC } = makeAudioMocks()
    ;(window as any).AudioContext = MockAC
    const fn = vi.fn().mockReturnValue(true)
    Object.defineProperty(navigator, VIB_KEY, { value: fn, configurable: true })
    bdSetClickSound(false)
    bdSetHaptic(true)

    const wrapper = mount(StageBoard, { props: { ...baseProps } })
    const key = wrapper.find('[data-cy="bd-key"]')
    await key.trigger('pointerdown', { button: 0, clientX: 10, clientY: 10 })
    await vi.advanceTimersByTimeAsync(250)
    expect(wrapper.emitted('button-long-press')).toEqual([[0]])
    expect(fn).toHaveBeenCalledWith([25, 40, 60])
    wrapper.unmount()
  })
})
