/**
 * Exportar / importar teclas como datos (nunca código).
 * El JSON se recorta y valida en el borde; eso no sustituye revisar el origen.
 */

import { IDRE, RES } from './useExpressions'

export interface SharedAction {
  id?: string
  type: string
  pluginId?: string | null
  parameters?: Record<string, any>
  waitMs?: number
}

export interface SharedRule {
  id?: string
  on?: boolean
  when?: string
  every?: number
  vn?: string
  cond?: string
  then?: SharedAction[]
  else?: SharedAction[]
}

export interface SharedLook {
  cond?: string
  t?: string
  i?: string
  /** Índice de paleta (0-5) o color libre `#rrggbb`. */
  c?: number | string | null
  /** Índice de fondo (0 = base) o color libre `#rrggbb`. */
  bg?: number | string
}

export interface SharedVar {
  n: string
  t: 'num' | 'txt' | 'bool'
  v: number | string | boolean
}

export interface SharedButtonData {
  label: string
  textTop?: string
  textBottom?: string
  fontSize?: number
  emoji?: string
  icon?: string
  iconImage?: string
  backgroundColor?: string
  textColor?: string
  showTitle?: boolean
  mode?: string
  longPress?: string
  confirm?: boolean
  actions: SharedAction[]
  /** Listas por tipo de pulsación (Fase B). `actions` = click (legacy). */
  pressActions?: {
    click?: SharedAction[]
    double?: SharedAction[]
    triple?: SharedAction[]
    long?: SharedAction[]
  }
  rules?: SharedRule[]
  looks?: SharedLook[]
  /** Variable numérica de N estados (`variable == i`). */
  stateVar?: string
  [k: string]: any
}

export interface SharedPageButton {
  position: number
  data: SharedButtonData
}

export interface SharedPage {
  id: string
  name: string
  is_folder: number
  buttons: SharedPageButton[]
}

export interface SharedPlugin {
  id: string
  name: string
  version: string
  by?: string
  icon?: string
  manifest?: any
  actions?: Array<[string, any]>
  marketplaceUrl?: string | null
}

export interface SharedDoc {
  libredeck: 1
  type: 'key'
  app: string
  key: SharedButtonData
  pages: SharedPage[]
  plugins: SharedPlugin[]
  vars: SharedVar[]
}

const str = (v: any, n: number) => String(v ?? '').slice(0, n)
/**
 * Normaliza la base de la API: acepta tanto el origen (`http://host:3001`)
 * como la base con prefijo (`http://host:3001/api/v1`, la forma de `API_BASE`
 * en BunDeckApp). Sin esto la subida concatenaba `/api/v1/api/v1/assets`
 * y el daemon respondía 404 `API endpoint not found`.
 */
export function normalizeApiBase(apiBase: unknown): string {
  const base = typeof apiBase === 'string' ? apiBase.replace(/\/+$/, '') : ''
  return base.replace(/\/api\/v1$/, '')
}
/** URL absoluta de un asset `/assets/…` contra la base de la API (puerto 3001). */
export function assetUrl(apiBase: unknown, rel: unknown): string {
  if (typeof rel !== 'string' || !rel) return ''
  if (/^https?:\/\//i.test(rel) || rel.startsWith('data:')) return rel
  if (!rel.startsWith('/')) return rel
  const base = normalizeApiBase(apiBase)
  return `${base}${rel}`
}
/** file → `/assets/…` validado (un segmento, extensión de imagen). */
export function isAssetRef(v: unknown): v is string {
  if (typeof v !== 'string' || !v.startsWith('/assets/')) return false
  const base = v.split('?')[0].slice('/assets/'.length)
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]*\.(png|jpe?g|webp|gif|svg)$/i.test(base)
}
const num = (v: any, lo: number, hi: number, fb: number) => {
  const x = Number(v)
  if (!Number.isFinite(x)) return fb
  return Math.min(hi, Math.max(lo, x))
}

const MODES = ['seq', 'par', 'alt']
const LONGPRESS = ['none', 'folder', 'repeat', 'mute']
const WHEN = ['press', 'double', 'triple', 'long', 'load', 'timer', 'var']
const VARTYPES = ['num', 'txt', 'bool']
/** Color libre `#rrggbb`: se conserva tal cual en exportar/importar. */
const isHexColor = (v: unknown): v is string => typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v)

export function cleanAction(a: any): SharedAction {
  const type = str(a?.type, 96)
  const params = a?.parameters && typeof a.parameters === 'object' ? { ...a.parameters } : {}
  // Recorta parámetros textuales largos (datos, nunca código ejecutable).
  for (const k of Object.keys(params)) {
    if (typeof params[k] === 'string') params[k] = params[k].slice(0, 500)
  }
  return {
    id: str(a?.id ?? Date.now().toString(), 48),
    type,
    pluginId: a?.pluginId == null ? null : str(a.pluginId, 64),
    parameters: params,
    waitMs: num(a?.waitMs, 0, 10000, 0)
  }
}

const cleanActions = (l: any): SharedAction[] =>
  (Array.isArray(l) ? l : []).slice(0, 32).map(cleanAction)

export function cleanRule(r: any): SharedRule {
  return {
    id: str(r?.id, 48),
    on: r?.on !== false,
    when: WHEN.includes(r?.when) ? r.when : 'press',
    every: num(r?.every, 1, 3600, 5),
    vn: str(r?.vn, 40),
    cond: str(r?.cond, 300),
    then: cleanActions(r?.then),
    else: cleanActions(r?.else)
  }
}

export function cleanLook(l: any): SharedLook {
  return {
    cond: str(l?.cond, 300),
    t: str(l?.t, 40),
    i: typeof l?.i === 'string' ? l.i.slice(0, 48) : '',
    c: isHexColor(l?.c) ? l.c : (l?.c != null ? num(l.c, 0, 5, 0) : null),
    bg: isHexColor(l?.bg) ? l.bg : (l?.bg ? num(l.bg, 0, 5, 0) : 0)
  }
}

export function cleanVar(v: any): SharedVar | null {
  if (!v || typeof v.n !== 'string' || !IDRE.test(v.n) || RES.includes(v.n.toLowerCase())) return null
  if (!VARTYPES.includes(v.t)) return null
  return {
    n: v.n.slice(0, 40),
    t: v.t,
    v: v.t === 'num' ? num(v.v, -1e12, 1e12, 0) : v.t === 'bool' ? !!v.v : str(v.v, 200)
  }
}

export function cleanKey(k: any): SharedButtonData {
  const rawPa = k?.pressActions && typeof k.pressActions === 'object' ? k.pressActions : {}
  const cleanPa = {
    click: cleanActions(rawPa.click),
    double: cleanActions(rawPa.double),
    triple: cleanActions(rawPa.triple),
    long: cleanActions(rawPa.long),
  }
  const actions = cleanActions(k?.actions)
  // Espejo click legacy: el que tenga contenido manda; si no, vacío.
  const click = cleanPa.click.length ? cleanPa.click : actions
  return {
    label: str(k?.label, 40),
    textTop: str(k?.textTop, 40),
    textBottom: str(k?.textBottom, 40),
    fontSize: num(k?.fontSize, 8, 48, 14),
    emoji: str(k?.emoji, 8),
    icon: str(k?.icon, 48),
    iconImage: isAssetRef(k?.iconImage) ? k.iconImage.slice(0, 200) : '',
    backgroundColor: str(k?.backgroundColor ?? '', 24),
    textColor: str(k?.textColor || '#e8e9eb', 24),
    showTitle: k?.showTitle !== false,
    mode: MODES.includes(k?.mode) ? k.mode : 'seq',
    longPress: LONGPRESS.includes(k?.longPress) ? k.longPress : 'none',
    confirm: !!k?.confirm,
    actions: click.length ? click : actions,
    pressActions: cleanPa,
    rules: (Array.isArray(k?.rules) ? k.rules : []).slice(0, 16).map(cleanRule),
    looks: (Array.isArray(k?.looks) ? k.looks : []).slice(0, 16).map(cleanLook),
    stateVar: str(k?.stateVar ?? '', 40)
  }
}

const eachKeyAction = (key: SharedButtonData, fn: (a: SharedAction) => void) => {
  for (const a of key.actions ?? []) fn(a)
  for (const l of Object.values(key.pressActions ?? {})) {
    if (Array.isArray(l)) for (const a of l) fn(a)
  }
  for (const r of key.rules ?? []) {
    for (const a of r.then ?? []) fn(a)
    for (const a of r.else ?? []) fn(a)
  }
}

export function collectPageIds(key: SharedButtonData): string[] {
  const ids = new Set<string>()
  eachKeyAction(key, (a) => {
    const pid = a?.parameters?.pageId
    if (typeof pid === 'string' && pid) ids.add(pid)
  })
  return [...ids]
}

export function parseSharedDoc(text: string): { doc?: SharedDoc; error?: string } {
  const t = (text ?? '').trim()
  if (!t) return {}
  if (t.length > 200000) return { error: 'codeTooBig' }
  let d: any
  try {
    d = JSON.parse(t)
  } catch {
    return { error: 'notValidJson' }
  }
  if (!d || d.libredeck !== 1 || d.type !== 'key' || !d.key || !Array.isArray(d.key.actions)) {
    return { error: 'invalidKeyCode' }
  }
  const pages: SharedPage[] = (Array.isArray(d.pages) ? d.pages : [])
    .slice(0, 16)
    .filter((x: any) => x && typeof x.id === 'string')
    .map((x: any) => ({
      id: str(x.id, 64),
      name: str(x.name || 'Página', 60),
      is_folder: x.is_folder === 1 ? 1 : 0,
      buttons: (Array.isArray(x.buttons) ? x.buttons : [])
        .filter((b: any) => b && Number.isInteger(b.position))
        .slice(0, 64)
        .map((b: any) => ({ position: b.position, data: cleanKey(b.data) }))
    }))
  const plugins: SharedPlugin[] = (Array.isArray(d.plugins) ? d.plugins : [])
    .slice(0, 16)
    .filter((p: any) => p && typeof p.id === 'string')
    .map((p: any) => ({
      id: str(p.id, 64),
      name: str(p.name || p.id, 60),
      version: str(p.version || '0.0.0', 16),
      by: p.by ? str(p.by, 60) : undefined,
      icon: p.icon ? str(p.icon, 48) : undefined,
      manifest: p.manifest && typeof p.manifest === 'object' ? p.manifest : undefined,
      actions: Array.isArray(p.actions) ? p.actions.slice(0, 32) : undefined,
      marketplaceUrl: typeof p.marketplaceUrl === 'string' ? p.marketplaceUrl.slice(0, 500) : null
    }))
  const vars: SharedVar[] = (Array.isArray(d.vars) ? d.vars : [])
    .slice(0, 32)
    .map(cleanVar)
    .filter((v): v is SharedVar => v !== null)
  return { doc: { libredeck: 1, type: 'key', app: str(d.app || 'LibreDeck', 60), key: cleanKey(d.key), pages, plugins, vars } }
}

/** Posición del primer hueco libre, o null si no hay. */
export function firstFreePosition(total: number, taken: Set<number>): number | null {
  for (let i = 0; i < total; i++) if (!taken.has(i)) return i
  return null
}
