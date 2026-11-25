/**
 * useShortcuts — atajos de teclado de BunDeck (Fase 1: in-app).
 *
 * - IDs estables + combos por defecto (mostrar/ocultar panel, perfil
 *   siguiente/anterior, silenciar todo, entrar/salir de kiosco).
 * - Parser/matcher puros (testeables sin DOM), detección de conflictos,
 *   persistencia (localStorage + sincronización best-effort con el daemon
 *   vía `settings` clave `shortcuts.config`).
 * - Listener global keydown: ignora focos de edición y el modo recaptura.
 *
 * Fase 2 (globales con la ventana sin foco): el launcher Rust lee
 * `shortcuts.config` del daemon y reenvía con POST
 * `/api/v1/shortcuts/trigger`. Regla anti-doble-ejecución: el primero que
 * captura gana (ventana de 800 ms por id en el daemon + `executionId`
 * para ignorar ecos propios del broadcast `shortcut.triggered`).
 */

export type ShortcutId =
  | 'toggle-panels'
  | 'next-profile'
  | 'prev-profile'
  | 'mute-all'
  | 'toggle-kiosk'

export interface ShortcutBinding {
  combo: string
  enabled: boolean
}

export type ShortcutMap = Record<ShortcutId, ShortcutBinding>

export const SHORTCUT_IDS: ShortcutId[] = [
  'toggle-panels',
  'next-profile',
  'prev-profile',
  'mute-all',
  'toggle-kiosk',
]

export const DEFAULT_SHORTCUTS: ShortcutMap = {
  'toggle-panels': { combo: 'Ctrl+Alt+P', enabled: true },
  'next-profile': { combo: 'Ctrl+Alt+ArrowRight', enabled: true },
  'prev-profile': { combo: 'Ctrl+Alt+ArrowLeft', enabled: true },
  'mute-all': { combo: 'Ctrl+Alt+M', enabled: true },
  'toggle-kiosk': { combo: 'Ctrl+Alt+K', enabled: false },
}

export const SHORTCUTS_CONFIG_KEY = 'shortcuts.config'
const LS_KEY = 'bundeck:shortcuts:v1'

export interface ParsedCombo {
  ctrl: boolean
  alt: boolean
  shift: boolean
  meta: boolean
  /** Tecla normalizada (mayúsculas para letras, nombre para especiales). */
  key: string
}

/** Normaliza el nombre de una tecla (`KeyboardEvent.key`) o token de combo. */
export function normalizeKey(raw: string): string {
  const k = String(raw ?? '').trim()
  if (!k) return ''
  if (k.length === 1) return k.toUpperCase()
  const lower = k.toLowerCase()
  const aliases: Record<string, string> = {
    arrowleft: 'ArrowLeft',
    arrowright: 'ArrowRight',
    arrowup: 'ArrowUp',
    arrowdown: 'ArrowDown',
    ' ': 'Space',
    spacebar: 'Space',
    esc: 'Escape',
    del: 'Delete',
    ins: 'Insert',
    pgup: 'PageUp',
    pgdn: 'PageDown',
    pageup: 'PageUp',
    pagedown: 'PageDown',
    return: 'Enter',
    apps: 'ContextMenu',
  }
  if (aliases[lower]) return aliases[lower]
  // F1..F24, Enter, Tab, Escape, Space, etc.: capitaliza la primera letra.
  return k.charAt(0).toUpperCase() + k.slice(1)
}

/** Parsea "Ctrl+Alt+Shift+P" → { ctrl, alt, shift, meta, key }. Null si inválido. */
export function parseShortcut(raw: string): ParsedCombo | null {
  const parts = String(raw ?? '')
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean)
  if (parts.length === 0) return null
  let ctrl = false
  let alt = false
  let shift = false
  let meta = false
  const keys: string[] = []
  for (const p of parts) {
    const l = p.toLowerCase()
    if (l === 'ctrl' || l === 'control') ctrl = true
    else if (l === 'alt' || l === 'option') alt = true
    else if (l === 'shift') shift = true
    else if (l === 'meta' || l === 'cmd' || l === 'command' || l === 'win' || l === 'super') meta = true
    else keys.push(p)
  }
  if (keys.length !== 1) return null
  const key = normalizeKey(keys[0])
  if (!key) return null
  if (!ctrl && !alt && !shift && !meta) return null // exige al menos un modificador
  return { ctrl, alt, shift, meta, key }
}

/** Formato canónico "Ctrl+Alt+P" (orden fijo de modificadores). */
export function formatShortcut(c: ParsedCombo): string {
  const out: string[] = []
  if (c.ctrl) out.push('Ctrl')
  if (c.alt) out.push('Alt')
  if (c.shift) out.push('Shift')
  if (c.meta) out.push('Meta')
  out.push(c.key)
  return out.join('+')
}

export interface KeyEventLike {
  key: string
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  metaKey: boolean
}

/** ¿Dispara este evento el combo? Compara modificadores exactos + tecla. */
export function matchesShortcutEvent(ev: KeyEventLike, combo: string): boolean {
  const p = parseShortcut(combo)
  if (!p) return false
  return (
    !!ev.ctrlKey === p.ctrl &&
    !!ev.altKey === p.alt &&
    !!ev.shiftKey === p.shift &&
    !!ev.metaKey === p.meta &&
    normalizeKey(ev.key) === p.key
  )
}

/** Id del atajo que dispara el evento (null si ninguno). Respeta `enabled`. */
export function matchShortcutsEvent(
  ev: KeyEventLike,
  map: ShortcutMap,
): ShortcutId | null {
  for (const id of SHORTCUT_IDS) {
    const b = map[id]
    if (!b?.enabled) continue
    if (matchesShortcutEvent(ev, b.combo)) return id
  }
  return null
}

/** Ids que comparten el mismo combo normalizado (conflictos, solo habilitados). */
export function findShortcutConflicts(map: ShortcutMap): ShortcutId[][] {
  const byCombo = new Map<string, ShortcutId[]>()
  for (const id of SHORTCUT_IDS) {
    const b = map[id]
    if (!b?.enabled) continue
    const p = parseShortcut(b.combo)
    if (!p) continue
    const k = formatShortcut(p)
    const arr = byCombo.get(k) ?? []
    arr.push(id)
    byCombo.set(k, arr)
  }
  return [...byCombo.values()].filter((g) => g.length > 1)
}

export function isValidShortcutCombo(combo: string): boolean {
  return parseShortcut(combo) !== null
}

/** Construye un combo desde un KeyboardEvent (para la UI de recaptura). Null si no sirve. */
export function comboFromEvent(ev: KeyEventLike): string | null {
  const key = normalizeKey(ev.key)
  // Teclas puramente modificadoras no son asignables.
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(key)) return null
  if (!ev.ctrlKey && !ev.altKey && !ev.shiftKey && !ev.metaKey) return null
  return formatShortcut({
    ctrl: !!ev.ctrlKey,
    alt: !!ev.altKey,
    shift: !!ev.shiftKey,
    meta: !!ev.metaKey,
    key,
  })
}

// ---- Persistencia (storage inyectable para tests) ----

export interface MinimalStorage {
  getItem(k: string): string | null
  setItem(k: string, v: string): void
}

function memStorage(): MinimalStorage {
  const m = new Map<string, string>()
  return {
    getItem: (k) => (m.has(k) ? m.get(k)! : null),
    setItem: (k, v) => void m.set(k, v),
  }
}

function defaultStorage(): MinimalStorage {
  try {
    if (typeof localStorage !== 'undefined') return localStorage
  } catch {
    /* SSR/jsdom sin localStorage */
  }
  return memStorage()
}

function sanitizeMap(raw: unknown): ShortcutMap {
  const out: ShortcutMap = JSON.parse(JSON.stringify(DEFAULT_SHORTCUTS))
  if (!raw || typeof raw !== 'object') return out
  for (const id of SHORTCUT_IDS) {
    const b = (raw as Record<string, unknown>)[id] as Partial<ShortcutBinding> | undefined
    if (!b || typeof b !== 'object') continue
    if (typeof b.combo === 'string' && parseShortcut(b.combo)) out[id].combo = formatShortcut(parseShortcut(b.combo)!)
    if (typeof b.enabled === 'boolean') out[id].enabled = b.enabled
  }
  return out
}

export function loadShortcutsState(storage: MinimalStorage = defaultStorage()): ShortcutMap {
  try {
    const raw = storage.getItem(LS_KEY)
    if (!raw) return sanitizeMap(null)
    return sanitizeMap(JSON.parse(raw))
  } catch {
    return sanitizeMap(null)
  }
}

export function saveShortcutsState(
  map: ShortcutMap,
  storage: MinimalStorage = defaultStorage(),
): void {
  try {
    storage.setItem(LS_KEY, JSON.stringify(map))
  } catch {
    /* noop */
  }
}

/** Parsea el valor de `shortcuts.config` del daemon (string JSON o objeto). */
export function parseDaemonShortcutsConfig(value: unknown): ShortcutMap | null {
  try {
    const obj = typeof value === 'string' ? JSON.parse(value) : value
    const inner = obj && typeof obj === 'object' && 'shortcuts' in obj ? (obj as any).shortcuts : obj
    if (!inner || typeof inner !== 'object') return null
    return sanitizeMap(inner)
  } catch {
    return null
  }
}

export function serializeDaemonShortcutsConfig(map: ShortcutMap): string {
  return JSON.stringify({ version: 1, shortcuts: map })
}

// ---- Listener global + ejecución in-app ----

export interface ShortcutRuntime {
  /** Perfiles en orden de navegación. */
  getProfileIds: () => string[]
  getActiveProfileId: () => string | null
  onActivateProfile: (id: string) => void
  /** Muestra/oculta paneles laterales. */
  onTogglePanels: () => void
  /** Entra/sale de kiosco. */
  onToggleKiosk: () => void
  /** Silencia todo (maestro). */
  onMuteAll: () => void
  notify?: (msg: string) => void
}

/** ¿El foco está en un campo editable? (los atajos no disparan al escribir). */
export function isEditableFocus(target: unknown): boolean {
  try {
    const el = target as HTMLElement | null
    if (!el || typeof (el as HTMLElement).tagName !== 'string') return false
    const tag = (el as HTMLElement).tagName.toLowerCase()
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return true
    if ((el as HTMLElement).isContentEditable) return true
  } catch {
    /* noop */
  }
  return false
}

/** Siguiente/anterior con wrap sobre la lista de perfiles. */
export function stepProfile(ids: string[], activeId: string | null, dir: 1 | -1): string | null {
  if (ids.length === 0) return null
  if (ids.length === 1) return ids[0]
  const i = activeId ? ids.indexOf(activeId) : -1
  if (i === -1) return dir === 1 ? ids[0] : ids[ids.length - 1]
  return ids[(i + dir + ids.length) % ids.length]
}

export function executeShortcutAction(id: ShortcutId, rt: ShortcutRuntime): void {
  switch (id) {
    case 'next-profile':
    case 'prev-profile': {
      const ids = rt.getProfileIds()
      const target = stepProfile(ids, rt.getActiveProfileId(), id === 'next-profile' ? 1 : -1)
      if (target) rt.onActivateProfile(target)
      else rt.notify?.('Sin perfiles para cambiar')
      break
    }
    case 'toggle-panels':
      rt.onTogglePanels()
      break
    case 'toggle-kiosk':
      rt.onToggleKiosk()
      break
    case 'mute-all':
      rt.onMuteAll()
      break
  }
}

export interface InstallOptions {
  getMap: () => ShortcutMap
  /** Opcional: solo se usa con `executeShortcutAction` manual; el listener
   *  delega en `onTrigger` y no necesita runtime. */
  runtime?: ShortcutRuntime
  /** Cuando la UI de recaptura está capturando: no disparar. */
  isCapturing?: () => boolean
  /** Ids de ejecuciones ya vistas (ecos del broadcast): no repetir. */
  seenExecutions?: Set<string>
}

/**
 * Instala el listener keydown global. Devuelve la función de desinstalación.
 * Llama a `onTrigger(id, executionId)` con un id único por pulsación para
 * que el daemon pueda aplicar la regla "el primero que captura gana".
 */
export function installGlobalShortcuts(
  onTrigger: (id: ShortcutId, executionId: string) => void,
  opts: InstallOptions,
): () => void {
  const handler = (ev: KeyboardEvent) => {
    try {
      if (opts.isCapturing?.()) return
      if ((ev as KeyboardEvent).isComposing) return
      if (isEditableFocus(ev.target)) return
      // No robar atajos del navegador/debug (F5, F12, Ctrl+R/W/T…): solo
      // disparar si el combo incluye Alt o es nuestro formato Ctrl+Alt+*.
      const id = matchShortcutsEvent(ev as unknown as KeyEventLike, opts.getMap())
      if (!id) return
      ev.preventDefault()
      const executionId =
        typeof crypto !== 'undefined' && 'randomUUID' in crypto
          ? crypto.randomUUID()
          : `web-${Date.now()}-${Math.floor(Math.random() * 1e9)}`
      onTrigger(id, executionId)
    } catch {
      /* nunca romper el teclado de la app por un atajo */
    }
  }
  window.addEventListener('keydown', handler)
  return () => window.removeEventListener('keydown', handler)
}
