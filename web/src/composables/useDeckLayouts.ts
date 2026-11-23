import { ref } from 'vue'

export type DeckWidgetKind = 'action' | 'slider' | 'clock' | 'timer'

export interface DeckWidget {
  id: string
  kind: DeckWidgetKind
  /** Posición en celdas del grid (origen 0,0). */
  x: number
  y: number
  /** Tamaño en celdas. */
  w: number
  h: number
  /** Título visible. */
  label?: string
  /** Icono lucide (kebab o PascalCase). */
  icon?: string
  /** Color de texto / acento. */
  color?: string
  /** Fondo propio. */
  bg?: string
  /** action: posición de tecla legacy o id de botón; slider: variable enlazada. */
  buttonPosition?: number | null
  varName?: string
  min?: number
  max?: number
  step?: number
  /** timer: segundos iniciales / modo. */
  seconds?: number
  timerMode?: 'countdown' | 'stopwatch'
  /** clock: formato. */
  clockFormat?: 'HH:MM' | 'HH:MM:SS'
}

export interface DeckLayout {
  id: string
  name: string
  /** Página legacy de la que migra (opcional). */
  pageId?: string | null
  profileId?: string | null
  cols: number
  rows: number
  widgets: DeckWidget[]
}

export const DECK_COLS_DEFAULT = 6
export const DECK_ROWS_DEFAULT = 4
export const DECK_COLS_MAX = 12
export const DECK_ROWS_MAX = 12
const LS_KEY = 'bundeck:deck-layouts-v1'

export const uid = (p = 'w'): string =>
  `${p}${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-4)}`

export function clampWidget(w: DeckWidget, cols: number, rows: number): DeckWidget {
  const cw = Math.min(Math.max(1, Math.round(w.w) || 1), cols)
  const ch = Math.min(Math.max(1, Math.round(w.h) || 1), rows)
  const cx = Math.min(Math.max(0, Math.round(w.x) || 0), Math.max(0, cols - cw))
  const cy = Math.min(Math.max(0, Math.round(w.y) || 0), Math.max(0, rows - ch))
  return { ...w, x: cx, y: cy, w: cw, h: ch }
}

export function rectsOverlap(a: DeckWidget, b: DeckWidget): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

/** ¿Cabe el widget en (x,y) sin solapar a otros? */
export function canPlace(widgets: DeckWidget[], candidate: DeckWidget, cols: number, rows: number, ignoreId?: string): boolean {
  const c = clampWidget(candidate, cols, rows)
  // El clamp puede moverlo: si cambió la posición pedida, no cabe ahí.
  if (c.x !== candidate.x || c.y !== candidate.y) return false
  for (const w of widgets) {
    if (w.id === (ignoreId ?? candidate.id)) continue
    if (rectsOverlap(c, w)) return false
  }
  return true
}

/** Primera posición libre para un widget de wxh (barrido por filas). */
export function firstFreeSpot(widgets: DeckWidget[], cols: number, rows: number, ww = 1, wh = 1): { x: number; y: number } | null {
  for (let y = 0; y <= rows - wh; y++) {
    for (let x = 0; x <= cols - ww; x++) {
      const cand: DeckWidget = { id: '__probe__', kind: 'action', x, y, w: ww, h: wh }
      let clash = false
      for (const w of widgets) {
        if (rectsOverlap(cand, w)) { clash = true; break }
      }
      if (!clash) return { x, y }
    }
  }
  return null
}

/** Migración suave: el grid fijo legacy (cols×rows, N teclas) se convierte en un layout. */
export function migrateLegacyGrid(opts: {
  name: string
  cols: number
  rows: number
  usedPositions: number[]
  pageId?: string | null
  profileId?: string | null
}): DeckLayout {
  const { name, cols, rows, usedPositions, pageId = null, profileId = null } = opts
  const widgets: DeckWidget[] = usedPositions.slice(0, cols * rows).map((pos) => ({
    id: uid('w'),
    kind: 'action',
    x: pos % cols,
    y: Math.floor(pos / cols),
    w: 1,
    h: 1,
    buttonPosition: pos
  }))
  return { id: uid('l'), name, pageId, profileId, cols, rows, widgets }
}

function load(): DeckLayout[] {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_KEY) ?? 'null')
    if (Array.isArray(raw)) {
      return raw.filter((l) => l && typeof l.id === 'string' && Array.isArray(l.widgets))
    }
  } catch { /* noop */ }
  return []
}

function persist(layouts: DeckLayout[]) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(layouts))
  } catch { /* noop */ }
}

/** Store singleton: layouts por perfil/página, flag de UI nueva. */
export function useDeckLayouts() {
  const layouts = ref<DeckLayout[]>(load())
  const save = () => persist(layouts.value)

  const getLayout = (id: string): DeckLayout | undefined =>
    layouts.value.find((l) => l.id === id)

  const createLayout = (name: string, init?: Partial<DeckLayout>): DeckLayout => {
    const layout: DeckLayout = {
      id: uid('l'),
      name: name.trim() || `Layout ${layouts.value.length + 1}`,
      pageId: null,
      profileId: null,
      cols: DECK_COLS_DEFAULT,
      rows: DECK_ROWS_DEFAULT,
      widgets: [],
      ...init,
      id: init?.id ?? uid('l'),
      widgets: init?.widgets ?? []
    }
    layouts.value.push(layout)
    save()
    return layout
  }

  const duplicateLayout = (id: string): DeckLayout | null => {
    const src = getLayout(id)
    if (!src) return null
    const copy: DeckLayout = {
      ...JSON.parse(JSON.stringify(src)),
      id: uid('l'),
      name: `${src.name} (copia)`,
      widgets: src.widgets.map((w) => ({ ...w, id: uid('w') }))
    }
    layouts.value.push(copy)
    save()
    return copy
  }

  const deleteLayout = (id: string) => {
    layouts.value = layouts.value.filter((l) => l.id !== id)
    save()
  }

  const renameLayout = (id: string, name: string) => {
    const l = getLayout(id)
    if (!l || !name.trim()) return
    l.name = name.trim()
    save()
  }

  const resizeLayout = (id: string, cols: number, rows: number) => {
    const l = getLayout(id)
    if (!l) return
    l.cols = Math.min(Math.max(1, cols), DECK_COLS_MAX)
    l.rows = Math.min(Math.max(1, rows), DECK_ROWS_MAX)
    l.widgets = l.widgets.map((w) => clampWidget(w, l.cols, l.rows))
    // Si el clamp genera solapes, se conservan (el editor los marca); no se pierde nada.
    save()
  }

  const addWidget = (layoutId: string, kind: DeckWidgetKind, patch?: Partial<DeckWidget>): DeckWidget | null => {
    const l = getLayout(layoutId)
    if (!l) return null
    const ww = Math.max(1, Math.round(patch?.w ?? (kind === 'slider' ? 2 : 1)))
    const wh = Math.max(1, Math.round(patch?.h ?? 1))
    const spot = firstFreeSpot(l.widgets, l.cols, l.rows, ww, wh)
    if (!spot) return null
    const widget: DeckWidget = clampWidget({
      id: uid('w'),
      kind,
      x: spot.x,
      y: spot.y,
      w: ww,
      h: wh,
      ...patch,
      id: patch?.id ?? uid('w')
    } as DeckWidget, l.cols, l.rows)
    // Re-clavar origen al hueco encontrado (ya validado para ww×wh).
    widget.x = spot.x
    widget.y = spot.y
    l.widgets.push(widget)
    save()
    return widget
  }

  const updateWidget = (layoutId: string, widgetId: string, patch: Partial<DeckWidget>): boolean => {
    const l = getLayout(layoutId)
    if (!l) return false
    const w = l.widgets.find((x) => x.id === widgetId)
    if (!w) return false
    Object.assign(w, patch, { id: w.id, kind: patch.kind ?? w.kind })
    const clamped = clampWidget(w, l.cols, l.rows)
    Object.assign(w, clamped)
    save()
    return true
  }

  const moveWidget = (layoutId: string, widgetId: string, x: number, y: number): boolean => {
    const l = getLayout(layoutId)
    if (!l) return false
    const w = l.widgets.find((x) => x.id === widgetId)
    if (!w) return false
    const cand = { ...w, x, y }
    if (!canPlace(l.widgets, cand, l.cols, l.rows, w.id)) return false
    w.x = cand.x
    w.y = cand.y
    save()
    return true
  }

  const resizeWidget = (layoutId: string, widgetId: string, w: number, h: number): boolean => {
    const l = getLayout(layoutId)
    if (!l) return false
    const widget = l.widgets.find((x) => x.id === widgetId)
    if (!widget) return false
    const cand = clampWidget({ ...widget, w, h }, l.cols, l.rows)
    // El tamaño pide más de lo que cabe: rechazar si el clamp lo recorta.
    if (cand.w !== Math.max(1, Math.round(w)) || cand.h !== Math.max(1, Math.round(h))) return false
    if (!canPlace(l.widgets, cand, l.cols, l.rows, widget.id)) return false
    widget.w = cand.w
    widget.h = cand.h
    save()
    return true
  }

  const removeWidget = (layoutId: string, widgetId: string) => {
    const l = getLayout(layoutId)
    if (!l) return
    l.widgets = l.widgets.filter((w) => w.id !== widgetId)
    save()
  }

  const ensureMigrated = (seed: DeckLayout): DeckLayout => {
    const existing = seed.pageId
      ? layouts.value.find((l) => l.pageId === seed.pageId)
      : undefined
    if (existing) return existing
    layouts.value.push(seed)
    save()
    return seed
  }

  return {
    layouts,
    getLayout,
    createLayout,
    duplicateLayout,
    deleteLayout,
    renameLayout,
    resizeLayout,
    addWidget,
    updateWidget,
    moveWidget,
    resizeWidget,
    removeWidget,
    ensureMigrated
  }
}

/** Flag de la UI nueva: 'legacy' (grid fijo) o 'layouts'. Migración suave, sin romper el editor. */
const DECK_UI_KEY = 'bundeck:deck-ui'
export function getDeckUiMode(): 'legacy' | 'layouts' {
  try {
    const v = localStorage.getItem(DECK_UI_KEY)
    if (v === 'layouts' || v === 'legacy') return v
    const env = (import.meta as any)?.env?.VITE_BD_LAYOUTS
    if (env === '1' || env === 'on') return 'layouts'
  } catch { /* noop */ }
  return 'legacy'
}
export function setDeckUiMode(m: 'legacy' | 'layouts') {
  try {
    localStorage.setItem(DECK_UI_KEY, m)
  } catch { /* noop */ }
}
