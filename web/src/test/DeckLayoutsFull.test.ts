import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import {
  useDeckLayouts,
  migrateLegacyGrid,
  firstFreeSpot,
  canPlace,
  clampWidget,
  getDeckUiMode,
  setDeckUiMode,
  DECK_COLS_DEFAULT,
  DECK_ROWS_DEFAULT,
  type DeckWidget
} from '../composables/useDeckLayouts'
import DeckLayoutGrid from '../components/bundeck/DeckLayoutGrid.vue'
import DeckEditor from '../components/bundeck/DeckEditor.vue'
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

describe('store: CRUD de layouts', () => {
  it('crea, renombra, duplica y borra layouts con persistencia', () => {
    const s = useDeckLayouts()
    const l = s.createLayout('Principal')
    expect(l.cols).toBe(DECK_COLS_DEFAULT)
    expect(l.rows).toBe(DECK_ROWS_DEFAULT)
    expect(l.widgets).toEqual([])
    s.renameLayout(l.id, '  Nuevo nombre  ')
    expect(s.getLayout(l.id)?.name).toBe('Nuevo nombre')
    s.renameLayout(l.id, '   ')
    expect(s.getLayout(l.id)?.name).toBe('Nuevo nombre')
    const copy = s.duplicateLayout(l.id)
    expect(copy).not.toBeNull()
    expect(copy!.id).not.toBe(l.id)
    expect(copy!.name).toContain('copia')
    // Persistencia: una instancia nueva lee lo guardado.
    const s2 = useDeckLayouts()
    expect(s2.getLayout(l.id)?.name).toBe('Nuevo nombre')
    expect(s2.getLayout(copy!.id)).not.toBeUndefined()
    s.deleteLayout(l.id)
    expect(s.getLayout(l.id)).toBeUndefined()
    expect(s.duplicateLayout('nope')).toBeNull()
  })

  it('redimensiona el layout y clampa widgets dentro', () => {
    const s = useDeckLayouts()
    const l = s.createLayout('R')
    const w = s.addWidget(l.id, 'slider')!
    expect(w.w).toBe(2)
    s.resizeLayout(l.id, 2, 2)
    const after = s.getLayout(l.id)!
    expect(after.cols).toBe(2)
    expect(after.rows).toBe(2)
    for (const x of after.widgets) {
      expect(x.x + x.w).toBeLessThanOrEqual(2)
      expect(x.y + x.h).toBeLessThanOrEqual(2)
    }
    s.resizeLayout(l.id, 99, 99)
    expect(s.getLayout(l.id)!.cols).toBeLessThanOrEqual(12)
  })

  it('ensureMigrated no duplica el seed de la misma página', () => {
    const s = useDeckLayouts()
    const seed = migrateLegacyGrid({ name: 'P', cols: 4, rows: 4, usedPositions: [0, 1], pageId: 'pg1' })
    const a = s.ensureMigrated(seed)
    const b = s.ensureMigrated(seed)
    expect(a.id).toBe(b.id)
    expect(s.layouts.value.filter((l) => l.pageId === 'pg1')).toHaveLength(1)
  })
})

describe('store: addWidget coloca sin solapar y respeta anchos', () => {
  it('slider ocupa 2×1 desde el primer hueco libre', () => {
    const s = useDeckLayouts()
    const l = s.createLayout('S', { cols: 6, rows: 4 })
    const w = s.addWidget(l.id, 'slider')!
    expect(w).toMatchObject({ x: 0, y: 0, w: 2, h: 1 })
    const w2 = s.addWidget(l.id, 'action')!
    expect(w2).toMatchObject({ x: 2, y: 0 })
  })

  it('respeta patch w/h y devuelve null si no cabe', () => {
    const s = useDeckLayouts()
    const l = s.createLayout('F', { cols: 2, rows: 1 })
    expect(s.addWidget(l.id, 'action', { w: 1, h: 1 })).not.toBeNull()
    expect(s.addWidget(l.id, 'action', { w: 1, h: 1 })).not.toBeNull()
    expect(s.addWidget(l.id, 'action')).toBeNull()
    expect(s.addWidget('nope', 'action')).toBeNull()
  })

  it('update/move/resize/remove con anti-solape', () => {
    const s = useDeckLayouts()
    const l = s.createLayout('M', { cols: 4, rows: 4 })
    const a = s.addWidget(l.id, 'action')!
    const b = s.addWidget(l.id, 'action')!
    expect(s.updateWidget(l.id, a.id, { label: 'Go', icon: 'Play' })).toBe(true)
    expect(s.getLayout(l.id)!.widgets.find((w) => w.id === a.id)?.label).toBe('Go')
    expect(s.updateWidget(l.id, 'nope', { label: 'x' })).toBe(false)
    // Mover b encima de a falla; a un hueco libre funciona.
    expect(s.moveWidget(l.id, b.id, a.x, a.y)).toBe(false)
    expect(s.moveWidget(l.id, b.id, 3, 3)).toBe(true)
    expect(s.moveWidget(l.id, 'nope', 0, 0)).toBe(false)
    // Resize que solapa falla; resize libre funciona.
    expect(s.resizeWidget(l.id, a.id, 4, 4)).toBe(false)
    expect(s.resizeWidget(l.id, a.id, 1, 1)).toBe(true)
    expect(s.resizeWidget(l.id, 'nope', 1, 1)).toBe(false)
    s.removeWidget(l.id, a.id)
    expect(s.getLayout(l.id)!.widgets.some((w) => w.id === a.id)).toBe(false)
  })
})

describe('helpers puros', () => {
  it('migrateLegacyGrid conserva geometría legacy', () => {
    const layout = migrateLegacyGrid({ name: 'P1', cols: 5, rows: 3, usedPositions: [0, 6, 14] })
    expect(layout.widgets).toHaveLength(3)
    expect(layout.widgets[0]).toMatchObject({ x: 0, y: 0, w: 1, h: 1, kind: 'action', buttonPosition: 0 })
    expect(layout.widgets[1]).toMatchObject({ x: 1, y: 1 })
    expect(migrateLegacyGrid({ name: 'V', cols: 2, rows: 2, usedPositions: [] }).widgets).toEqual([])
  })

  it('clamp/canPlace/firstFreeSpot cubren bordes y solapes', () => {
    const w: DeckWidget = { id: 'a', kind: 'action', x: 9, y: 9, w: 4, h: 4 }
    const c = clampWidget(w, 6, 4)
    expect(c.x + c.w).toBeLessThanOrEqual(6)
    expect(c.y + c.h).toBeLessThanOrEqual(4)
    const widgets: DeckWidget[] = [{ id: 'a', kind: 'action', x: 0, y: 0, w: 2, h: 1 }]
    expect(canPlace(widgets, { id: 'b', kind: 'action', x: 1, y: 0, w: 1, h: 1 }, 6, 4)).toBe(false)
    expect(canPlace(widgets, { id: 'b', kind: 'action', x: 2, y: 0, w: 1, h: 1 }, 6, 4)).toBe(true)
    // El clamp que desplaza se considera "no cabe ahí".
    expect(canPlace(widgets, { id: 'b', kind: 'action', x: 6, y: 0, w: 1, h: 1 }, 6, 4)).toBe(false)
    expect(firstFreeSpot(widgets, 6, 4, 1, 1)).toEqual({ x: 2, y: 0 })
    const full: DeckWidget[] = [
      { id: 'a', kind: 'action', x: 0, y: 0, w: 1, h: 1 },
      { id: 'b', kind: 'action', x: 1, y: 0, w: 1, h: 1 }
    ]
    expect(firstFreeSpot(full, 2, 1, 1, 1)).toBeNull()
    expect(firstFreeSpot(full, 2, 1, 2, 1)).toBeNull()
  })

  it('flag de UI persiste y respeta default legacy', () => {
    expect(getDeckUiMode()).toBe('legacy')
    setDeckUiMode('layouts')
    expect(getDeckUiMode()).toBe('layouts')
    setDeckUiMode('legacy')
    expect(getDeckUiMode()).toBe('legacy')
  })
})

describe('DeckWidgetView: los 4 tipos', () => {
  it('action muestra label/icono y emite press', async () => {
    const wrapper = mount(DeckWidgetView, {
      props: { widget: { id: 'a', kind: 'action', x: 0, y: 0, w: 1, h: 1, label: 'Go' } }
    })
    expect(wrapper.find('[data-cy="bd-widget-action-btn"]').exists()).toBe(true)
    const style = wrapper.attributes('style') ?? ''
    // jsdom >=31 serializa grid-column/grid-row como shorthand grid-area.
    expect(style).toMatch(/grid-(column|area): 1 \/ (span 1|1 \/ span 1 \/ span 1)/)
    await wrapper.find('[data-cy="bd-widget-action-btn"]').trigger('click')
    expect(wrapper.emitted('action-press')).toBeTruthy()
    wrapper.unmount()
  })

  it('slider se enlaza a variable y emite cambios', async () => {
    const wrapper = mount(DeckWidgetView, {
      props: { widget: { id: 's', kind: 'slider', x: 0, y: 0, w: 2, h: 1, varName: 'contador', min: 0, max: 10 } }
    })
    const input = wrapper.find('[data-cy="bd-widget-slider-input"]')
    expect(input.exists()).toBe(true)
    expect(input.attributes('min')).toBe('0')
    expect(input.attributes('max')).toBe('10')
    await input.setValue('4')
    expect(wrapper.emitted('slider-change')).toBeTruthy()
    wrapper.unmount()
  })

  it('slider sin varName no rompe', async () => {
    const wrapper = mount(DeckWidgetView, {
      props: { widget: { id: 's', kind: 'slider', x: 0, y: 0, w: 2, h: 1 } }
    })
    await wrapper.find('[data-cy="bd-widget-slider-input"]').setValue('5')
    expect(wrapper.emitted('slider-change')).toBeFalsy()
    wrapper.unmount()
  })

  it('clock pinta HH:MM y timer cuenta, pausa y resetea', async () => {
    const clock = mount(DeckWidgetView, {
      props: { widget: { id: 'c', kind: 'clock', x: 0, y: 0, w: 1, h: 1 }, now: new Date('2026-01-02T03:04:05').getTime() }
    })
    expect(clock.find('[data-cy="bd-widget-clock"]').exists()).toBe(true)
    expect(clock.text()).toContain('03:04')
    clock.unmount()

    const timer = mount(DeckWidgetView, {
      props: { widget: { id: 't', kind: 'timer', x: 0, y: 0, w: 1, h: 1, seconds: 60 } }
    })
    expect(timer.find('[data-cy="bd-widget-timer-val"]').text()).toBe('1:00')
    await timer.find('[data-cy="bd-widget-timer-start"]').trigger('click')
    await timer.find('[data-cy="bd-widget-timer-start"]').trigger('click')
    await timer.find('[data-cy="bd-widget-timer-reset"]').trigger('click')
    expect(timer.find('[data-cy="bd-widget-timer-val"]').text()).toBe('1:00')
    timer.unmount()
  })
})

describe('DeckLayoutGrid: rejilla real y edición', () => {
  const mk = (over: any = {}) => ({
    id: 'l1',
    name: 'L',
    cols: 4,
    rows: 3,
    widgets: [
      { id: 'a', kind: 'action', x: 0, y: 0, w: 1, h: 1, label: 'Go' },
      { id: 's', kind: 'slider', x: 1, y: 0, w: 2, h: 1, label: 'Vol', varName: 'contador' }
    ],
    ...over
  }) as any

  it('pinta un widget por entidad con span real y celdas libres', () => {
    const wrapper = mount(DeckLayoutGrid, { props: { layout: mk() } })
    expect(wrapper.find('[data-cy="bd-deck-grid"]').exists()).toBe(true)
    expect(wrapper.find('[data-cy="bd-deck-plate"]').exists()).toBe(true)
    // Sin duplicados: 2 widgets aunque el slider ocupe 2 celdas.
    expect(wrapper.findAll('[data-cy="bd-widget-action"]').length).toBe(1)
    expect(wrapper.findAll('[data-cy="bd-widget-slider"]').length).toBe(1)
    const slider = wrapper.find('[data-cy="bd-widget-slider"]')
    expect(slider.attributes('style')).toContain('span 2')
    // 4×3=12 celdas menos 3 ocupadas = 9 libres.
    expect(wrapper.findAll('.bd-deck-cell.is-free').length).toBe(9)
    wrapper.unmount()
  })

  it('click selecciona en edición y pulsa en solo-lectura', async () => {
    const edit = mount(DeckLayoutGrid, { props: { layout: mk() } })
    await edit.find('[data-cy="bd-widget-action"]').trigger('click')
    expect(edit.emitted('widget-select')).toBeTruthy()
    expect(edit.emitted('widget-press')).toBeFalsy()
    edit.unmount()

    const ro = mount(DeckLayoutGrid, { props: { layout: mk(), readonly: true } })
    await ro.find('[data-cy="bd-widget-action"]').trigger('click')
    expect(ro.emitted('widget-press')).toBeTruthy()
    // En solo-lectura no hay inspector ni drop.
    expect(ro.find('[data-cy="bd-deck-selected"]').exists()).toBe(false)
    ro.unmount()
  })

  it('inspector con resize/delete y navegación por teclado', async () => {
    const wrapper = mount(DeckLayoutGrid, {
      props: { layout: mk(), selectedWidgetId: 'a' }
    })
    expect(wrapper.find('[data-cy="bd-deck-selected"]').exists()).toBe(true)
    await wrapper.find('[data-cy="bd-widget-w-inc"]').trigger('click')
    expect(wrapper.emitted('resize-widget')).toBeTruthy()
    await wrapper.find('[data-cy="bd-widget-delete"]').trigger('click')
    expect(wrapper.emitted('remove-widget')).toEqual([['a']])
    await wrapper.find('[data-cy="bd-deck-plate"]').trigger('keydown', { key: 'ArrowRight' })
    expect(wrapper.emitted('widget-move')).toBeTruthy()
    wrapper.unmount()
  })

  it('drop de paleta emite kind+celda y respeta readonly', async () => {
    const wrapper = mount(DeckLayoutGrid, { props: { layout: mk() } })
    const free = wrapper.find('.bd-deck-cell.is-free')
    expect(free.exists()).toBe(true)
    await free.trigger('drop', {
      dataTransfer: { getData: () => JSON.stringify({ deckKind: 'clock' }) }
    })
    expect(wrapper.emitted('widget-drop-new')).toBeTruthy()
    wrapper.unmount()
  })

  it('botones de filas/columnas emiten resize de layout', async () => {
    const wrapper = mount(DeckLayoutGrid, { props: { layout: mk() } })
    await wrapper.find('[data-cy="bd-deck-cols-inc"]').trigger('click')
    expect(wrapper.emitted('resize-layout')).toEqual([[5, 3]])
    wrapper.unmount()
  })
})

describe('DeckEditor: paleta, layouts e inspector', () => {
  const layouts = () => [
    { id: 'l1', name: 'Uno', cols: 4, rows: 3, widgets: [{ id: 'a', kind: 'action', x: 0, y: 0, w: 1, h: 1, label: 'Go' }] },
    { id: 'l2', name: 'Dos', cols: 4, rows: 3, widgets: [] }
  ] as any

  it('paleta añade por click y crea/duplica/borra layouts', async () => {
    const wrapper = mount(DeckEditor, {
      props: { layouts: layouts(), activeId: 'l1', selectedWidgetId: 'a' }
    })
    for (const k of ['action', 'slider', 'clock', 'timer']) {
      expect(wrapper.find(`[data-cy="bd-deck-kind-${k}"]`).exists()).toBe(true)
    }
    await wrapper.find('[data-cy="bd-deck-kind-clock"]').trigger('click')
    expect(wrapper.emitted('add-widget')).toEqual([['clock']])
    await wrapper.find('[data-cy="bd-deck-create"]').trigger('click')
    expect(wrapper.emitted('create-layout')).toBeTruthy()
    wrapper.unmount()
  })

  it('inspector edita título y campos según kind', async () => {
    const wrapper = mount(DeckEditor, {
      props: { layouts: layouts(), activeId: 'l1', selectedWidgetId: 'a' }
    })
    expect(wrapper.find('[data-cy="bd-deck-inspector"]').exists()).toBe(true)
    await wrapper.find('[data-cy="bd-deck-widget-label"]').setValue('Nuevo')
    expect(wrapper.emitted('update-widget')).toBeTruthy()
    wrapper.unmount()

    const s = mount(DeckEditor, {
      props: {
        layouts: [{ id: 'l1', name: 'U', cols: 4, rows: 3, widgets: [{ id: 's', kind: 'slider', x: 0, y: 0, w: 2, h: 1, varName: 'v' }] }],
        activeId: 'l1',
        selectedWidgetId: 's'
      }
    })
    expect(s.find('[data-cy="bd-deck-widget-var"]').exists()).toBe(true)
    expect(s.find('[data-cy="bd-deck-widget-min"]').exists()).toBe(true)
    s.unmount()
  })

  it('sin layout activo muestra vacío', () => {
    const wrapper = mount(DeckEditor, {
      props: { layouts: [], activeId: null }
    })
    expect(wrapper.find('[data-cy="bd-deck-editor"]').exists()).toBe(true)
    expect(wrapper.find('[data-cy="bd-deck-plate"]').exists()).toBe(false)
    wrapper.unmount()
  })
})

describe('DeckUseView: solo-uso limpio', () => {
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

  it('sin controles de edición y con press en action', async () => {
    const wrapper = mount(DeckUseView, { props: { layout } })
    expect(wrapper.find('[data-cy="bd-deck-use"]').exists()).toBe(true)
    expect(wrapper.find('[data-cy="bd-deck-editor"]').exists()).toBe(false)
    expect(wrapper.find('[data-cy="bd-deck-inspector"]').exists()).toBe(false)
    expect(wrapper.find('[data-cy="bd-widget-delete"]').exists()).toBe(false)
    expect(wrapper.findAll('[data-cy="bd-widget-action"]').length).toBe(1)
    expect(wrapper.findAll('[data-cy="bd-widget-slider"]').length).toBe(1)
    await wrapper.find('[data-cy="bd-widget-action-btn"]').trigger('click')
    expect(wrapper.emitted('widget-press')).toBeTruthy()
    wrapper.unmount()
  })
})
