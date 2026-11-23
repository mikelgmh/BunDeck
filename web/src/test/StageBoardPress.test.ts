import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import StageBoard from '../components/bundeck/StageBoard.vue'

vi.mock('../composables/useI18n', () => ({
  useI18nStore: () => ({
    t: (key: string) => key,
    currentLocale: { value: 'es' },
    setLocale: () => {},
    loadSavedLocale: () => {},
  }),
}))

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

describe('StageBoard pulsación + FX (modo uso, classic)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('toque corto: emite button-tap y pinta fx de click', async () => {
    const wrapper = mount(StageBoard, { props: { ...baseProps } })
    const key = wrapper.find('[data-cy="bd-key"]')
    await key.trigger('pointerdown', { button: 0, clientX: 10, clientY: 10 })
    await key.trigger('pointerup', { button: 0, clientX: 10, clientY: 10 })
    expect(wrapper.emitted('button-tap')).toEqual([[0]])
    expect(key.classes()).toContain('bd-fx-click')
    // El clic sintético posterior del navegador se consume (no duplica).
    await key.trigger('click')
    expect(wrapper.emitted('button-tap')?.length).toBe(1)
    expect(wrapper.emitted('button-execute')).toBeUndefined()
    wrapper.unmount()
  })

  it('hold: emite button-long-press y el tap posterior se consume', async () => {
    const wrapper = mount(StageBoard, { props: { ...baseProps } })
    const key = wrapper.find('[data-cy="bd-key"]')
    await key.trigger('pointerdown', { button: 0, clientX: 10, clientY: 10 })
    expect(key.classes()).toContain('bd-fx-holding')
    await vi.advanceTimersByTimeAsync(250)
    expect(wrapper.emitted('button-long-press')).toEqual([[0]])
    await key.trigger('pointerup', { button: 0 })
    expect(wrapper.emitted('button-tap')).toBeUndefined()
    // El click posterior al long también se consume.
    await key.trigger('click')
    expect(wrapper.emitted('button-tap')).toBeUndefined()
    wrapper.unmount()
  })

  it('sin contenido long no hay hold ni long-press (tap directo)', async () => {
    const noLong = {
      ...baseProps,
      getButtonData: () => ({ label: 'B', actions: [{ id: 'c1', type: 'shell', parameters: {} }], rules: [] }),
    }
    const wrapper = mount(StageBoard, { props: { ...noLong } })
    const key = wrapper.find('[data-cy="bd-key"]')
    await key.trigger('pointerdown', { button: 0 })
    await vi.advanceTimersByTimeAsync(500)
    expect(wrapper.emitted('button-long-press')).toBeUndefined()
    await key.trigger('pointerup', { button: 0 })
    expect(wrapper.emitted('button-tap')).toEqual([[0]])
    wrapper.unmount()
  })

  it('modo gridstack: el tap también emite button-tap', async () => {
    const gsButtons = [{ ...buttons[0], x: 0, y: 0, w: 1, h: 1 }]
    const wrapper = mount(StageBoard, {
      props: {
        ...baseProps,
        layoutMode: 'gridstack',
        allButtons: gsButtons,
        getButton: (pos: number) => gsButtons.find((b: any) => b.position === pos),
      },
    })
    const key = wrapper.find('[data-cy="bd-key"]')
    expect(key.exists()).toBe(true)
    await key.trigger('pointerdown', { button: 0 })
    await key.trigger('pointerup', { button: 0 })
    expect(wrapper.emitted('button-tap')).toEqual([[0]])
    wrapper.unmount()
  })
})
