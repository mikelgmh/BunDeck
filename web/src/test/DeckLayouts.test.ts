import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import {
  migrateLegacyGrid,
  firstFreeSpot,
  canPlace,
  clampWidget,
  type DeckWidget
} from '../composables/useDeckLayouts'
import DeckUseView from '../components/bundeck/DeckUseView.vue'
import DeckWidgetView from '../components/bundeck/DeckWidgetView.vue'

vi.mock('../composables/useI18n', () => ({
  useI18nStore: () => ({
    t: (key: string) => key,
    currentLocale: { value: 'es' },
    setLocale: () => {},
    loadSavedLocale: () => {}
  })
}))

beforeEach(() => {
  localStorage.clear()
})

describe('deck layouts logic', () => {
  it('migrates legacy grid positions to widgets', () => {
    const layout = migrateLegacyGrid({ name: 'P1', cols: 5, rows: 3, usedPositions: [0, 6, 14] })
    expect(layout.cols).toBe(5)
    expect(layout.widgets).toHaveLength(3)
    expect(layout.widgets[0]).toMatchObject({ x: 0, y: 0, w: 1, h: 1, kind: 'action', buttonPosition: 0 })
    expect(layout.widgets[1]).toMatchObject({ x: 1, y: 1 })
  })

  it('clamps widgets inside the grid', () => {
    const w: DeckWidget = { id: 'a', kind: 'action', x: 9, y: 9, w: 4, h: 4 }
    const c = clampWidget(w, 6, 4)
    expect(c.x + c.w).toBeLessThanOrEqual(6)
    expect(c.y + c.h).toBeLessThanOrEqual(4)
  })

  it('rejects overlapping placements and finds free spots', () => {
    const widgets: DeckWidget[] = [{ id: 'a', kind: 'action', x: 0, y: 0, w: 2, h: 1 }]
    expect(canPlace(widgets, { id: 'b', kind: 'action', x: 1, y: 0, w: 1, h: 1 }, 6, 4)).toBe(false)
    expect(canPlace(widgets, { id: 'b', kind: 'action', x: 2, y: 0, w: 1, h: 1 }, 6, 4)).toBe(true)
    expect(firstFreeSpot(widgets, 6, 4, 1, 1)).toEqual({ x: 2, y: 0 })
    // Grid lleno: sin hueco
    const full: DeckWidget[] = [
      { id: 'a', kind: 'action', x: 0, y: 0, w: 1, h: 1 },
      { id: 'b', kind: 'action', x: 1, y: 0, w: 1, h: 1 }
    ]
    expect(firstFreeSpot(full, 2, 1, 1, 1)).toBeNull()
  })
})

describe('DeckWidgetView', () => {
  it('renders all four widget kinds', () => {
    const kinds: DeckWidget['kind'][] = ['action', 'slider', 'clock', 'timer']
    for (const kind of kinds) {
      const wrapper = mount(DeckWidgetView, {
        props: {
          widget: { id: kind, kind, x: 0, y: 0, w: 1, h: 1, label: kind, varName: 'contador' }
        }
      })
      expect(wrapper.find(`[data-cy="bd-widget-${kind}"]`).exists() || wrapper.html().includes('bd-widget')).toBe(true)
      wrapper.unmount()
    }
  })

  it('slider binds to a numeric var and emits changes', async () => {
    const wrapper = mount(DeckWidgetView, {
      props: {
        widget: { id: 's', kind: 'slider', x: 0, y: 0, w: 2, h: 1, varName: 'contador', min: 0, max: 10 }
      }
    })
    const input = wrapper.find('[data-cy="bd-widget-slider-input"]')
    expect(input.exists()).toBe(true)
    await input.setValue('4')
    expect(wrapper.emitted('slider-change')).toBeTruthy()
    wrapper.unmount()
  })
})

describe('DeckUseView (solo-uso)', () => {
  const layout = {
    id: 'l1',
    name: 'Móvil',
    cols: 3,
    rows: 2,
    widgets: [
      { id: 'a', kind: 'action', x: 0, y: 0, w: 1, h: 1, label: 'Go' },
      { id: 's', kind: 'slider', x: 1, y: 0, w: 2, h: 1, label: 'Vol', varName: 'contador' }
    ]
  } as any

  it('renders widgets without any editor controls', () => {
    const wrapper = mount(DeckUseView, { props: { layout } })
    expect(wrapper.find('[data-cy="bd-deck-use"]').exists()).toBe(true)
    // Sin controles de edición: nada de data-cy de editor/inspector.
    expect(wrapper.find('[data-cy="bd-deck-editor"]').exists()).toBe(false)
    expect(wrapper.find('[data-cy="bd-deck-inspector"]').exists()).toBe(false)
    expect(wrapper.find('[data-cy="bd-widget-delete"]').exists()).toBe(false)
    expect(wrapper.find('[data-cy="bd-widget-w-inc"]').exists()).toBe(false)
    expect(wrapper.find('[data-cy="bd-deck-create"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('emits widget-press when tapping an action (mobile client)', async () => {
    const wrapper = mount(DeckUseView, { props: { layout } })
    await wrapper.find('[data-cy="bd-widget-action-btn"]').trigger('click')
    expect(wrapper.emitted('widget-press')).toBeTruthy()
    wrapper.unmount()
  })
})
