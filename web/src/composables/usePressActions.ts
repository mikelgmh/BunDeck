/**
 * Acciones por tipo de pulsación.
 *
 * Modelo: `pressActions?: { click, double, triple, long }` dentro del `data`
 * de la tecla. `actions[]` legacy equivale a `click` y se migra en lectura
 * (nunca se borra al guardar: se conserva como espejo de `click` para que
 * versiones viejas / el daemon sin actualizar sigan ejecutando el click).
 *
 * Las reglas `when: double|triple` conviven con estas listas: la lista del
 * subtab es la acción directa de ese tipo de pulsación (azúcar sobre
 * `actions` para click); las reglas con el mismo `when` se ejecutan DESPUÉS
 * de la lista, igual que `when: press/long` lo hacen hoy tras `actions`.
 * No hay doble semántica: lista primero, reglas después.
 */

export type PressKind = 'click' | 'double' | 'triple' | 'long'

export const PRESS_KINDS: PressKind[] = ['click', 'double', 'triple', 'long']

/** Ventana multi-tap del prototipo (340 ms, máx 3 toques). */
export const TAP_WINDOW_MS = 340
export const TAP_MAX = 3

export interface PressActions {
  click?: any[]
  double?: any[]
  triple?: any[]
  long?: any[]
}

const asList = (v: unknown): any[] => (Array.isArray(v) ? v : [])

function cleanList(l: unknown, cap = 32): any[] {
  return asList(l).slice(0, cap).filter((a) => a && typeof a === 'object')
}

/** Normaliza `pressActions` migrando `actions[]` legacy a `click`. */
export function normalizePressActions(data: any): Record<PressKind, any[]> {
  const legacy = cleanList(data?.actions)
  const pa = (data?.pressActions ?? {}) as PressActions
  return {
    click: cleanList(pa.click).length ? cleanList(pa.click) : legacy.slice(),
    double: cleanList(pa.double),
    triple: cleanList(pa.triple),
    long: cleanList(pa.long),
  }
}

/** Lista de acciones directas para un tipo de pulsación. */
export function getActionsForKind(data: any, kind: PressKind): any[] {
  if (!data) return []
  // El click efectivo es pressActions.click si tiene contenido, si no
  // actions[] (espejo legacy; ver ensurePressMirror). Las teclas creadas
  // fuera del editor (API/MCP/imports) pueden no traer el espejo.
  if (kind === 'click') {
    const pa = cleanList((data as any)?.pressActions?.click)
    if (pa.length) return pa
    return cleanList(data.actions)
  }
  const pa = (data?.pressActions ?? {}) as PressActions
  return cleanList(pa[kind])
}

/** Fija la lista de un tipo; mantiene `actions[]` como espejo de `click`. */
export function setActionsForKind(data: any, kind: PressKind, list: any[]): any {
  const base = data && typeof data === 'object' ? { ...data } : {}
  const lists = normalizePressActions(base)
  lists[kind] = cleanList(list)
  const next: any = { ...base, pressActions: { ...lists } }
  if (kind === 'click') next.actions = cleanList(list)
  // `actions[]` legacy siempre espeja `click` (compat versiones viejas).
  if (kind !== 'click' && !cleanList(next.actions).length && lists.click.length) {
    next.actions = lists.click.slice()
  }
  if (kind !== 'click' && !next.actions) next.actions = lists.click.slice()
  return next
}

/** ¿La tecla tiene algo que distinga doble/triple (lista o regla)? */export function hasMultiTapContent(data: any): boolean {
  if (!data) return false
  const pa = (data?.pressActions ?? {}) as PressActions
  if (cleanList(pa.double).length || cleanList(pa.triple).length) return true
  const rules = asList(data?.rules)
  return rules.some((r: any) => r?.on !== false && (r?.when === 'double' || r?.when === 'triple'))
}

/** ¿La tecla tiene algo ejecutable para un tipo (lista o regla)? */
export function hasKindContent(data: any, kind: PressKind): boolean {
  if (!data) return false
  if (getActionsForKind(data, kind).length) return true
  const when = kind === 'click' ? 'press' : kind
  return asList(data?.rules).some((r: any) => r?.on !== false && (r?.when ?? 'press') === when)
}

/** ¿La tecla tiene reglas `long` (para el hold)? Incluye lista long. */
export function hasLongContent(data: any): boolean {
  if (!data) return false
  if (getActionsForKind(data, 'long').length) return true
  return asList(data?.rules).some((r: any) => r?.on !== false && r?.when === 'long')
}

/**
 * Mantiene `actions[]` y `pressActions.click` como espejos (compat hacia
 * atrás: lectores viejos y el daemon sin actualizar solo ven `actions[]`).
 * El click efectivo es `pressActions.click` si tiene contenido, si no
 * `actions[]`; tras normalizar ambos quedan iguales.
 */
export function ensurePressMirror(data: any): any {
  if (!data || typeof data !== 'object') return data
  const actions = cleanList(data?.actions)
  const raw = data?.pressActions && typeof data.pressActions === 'object' ? data.pressActions : {}
  const click = cleanList(raw.click)
  const merged = (click.length ? click : actions).slice()
  return {
    ...data,
    actions: merged.slice(),
    pressActions: {
      click: merged.slice(),
      double: cleanList(raw.double),
      triple: cleanList(raw.triple),
      long: cleanList(raw.long),
    },
  }
}

/** Nº de acciones en listas distintas de click (para hasContent). */
export function pressExtraCount(data: any): number {
  const raw = data?.pressActions
  if (!raw || typeof raw !== 'object') return 0
  let n = 0
  for (const k of ['double', 'triple', 'long'] as const) {
    if (Array.isArray(raw[k])) n += raw[k].length
  }
  return n
}
