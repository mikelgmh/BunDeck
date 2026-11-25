import { ref } from 'vue'
import { ev, evb, intp, usedVarNames, type LookLike } from './useExpressions'
import { getVar, setVarValue, toggleVar, vars, getEnv, displayTick, varsVersion } from './useVars'
import { getOrCreateDeviceId } from '../utils/sessionRouting'
import type { ButtonEntity } from '../types/streamdeck'
import {
  TAP_WINDOW_MS,
  getActionsForKind,
  hasKindContent,
  hasMultiTapContent,
  type PressKind,
} from './usePressActions'

/** Acciones locales (grupo «Lógica»): se ejecutan en el cliente, nunca en el daemon. */
export const LOCAL_ACTIONS = [
  { type: 'local.set-var', icon: 'Variable', nameKey: 'bd.varSet', defaults: { name: '', expr: '' } },
  { type: 'local.toggle-var', icon: 'ToggleLeft', nameKey: 'bd.varToggle', defaults: { name: '' } },
  { type: 'local.toast', icon: 'MessageSquare', nameKey: 'bd.varToast', defaults: { text: '' } }
] as const

export type Trigger = 'press' | 'long' | 'double' | 'triple' | 'load' | 'timer' | 'var'

export interface EngineDeps {
  getButton: (pos: number) => ButtonEntity | undefined
  /** Datos a ejecutar: config editada si es la seleccionada, si no lo guardado. */
  getExecData: (pos: number) => any | null
  /** Ejecuta una acción remota contra el daemon. */
  execRemote: (action: any, ctx: Record<string, any>) => Promise<any>
  toast: (msg: string) => void
  noActionsToast: () => void
  profileName: () => string
  pageName: () => string
  pageId: () => string
  executing: { value: number[] }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const uid = () => 'g' + Math.random().toString(36).slice(2, 7)

export function createKeyEngine(deps: EngineDeps) {
  const altIndex = new Map<string, number>()
  let depth = 0

  /** Un solo Date por tick para todo el barrido de teclas (antes: uno por tecla). */
  let envTickSeen = -1
  let envSharedNow: Date | null = null
  const env = () => {
    const tick = displayTick.value
    if (tick !== envTickSeen || !envSharedNow) {
      envTickSeen = tick
      envSharedNow = new Date()
    }
    return getEnv(deps.profileName(), deps.pageName(), envSharedNow)
  }

  const interpParams = (params: Record<string, any>, E: Record<string, any>) => {
    const out: Record<string, any> = { ...params }
    for (const k of Object.keys(out)) {
      if (k === 'pageId' || k === 'page_id') continue
      if (typeof out[k] === 'string') out[k] = intp(out[k], E)
    }
    return out
  }

  async function perform(o: any, ctx: Record<string, any>): Promise<void> {
    const E = env()
    try {
      switch (o?.type) {
        case 'local.set-var': {
          const name = String(o?.parameters?.name ?? '').trim()
          if (!name) throw new Error('Elige una variable')
          if (!getVar(name)) throw new Error(`Variable desconocida «${name}»`)
          setVarValue(name, ev(String(o?.parameters?.expr ?? ''), E))
          break
        }
        case 'local.toggle-var': {
          const name = String(o?.parameters?.name ?? '').trim()
          if (!name) throw new Error('Elige una variable')
          if (!getVar(name)) throw new Error(`Variable desconocida «${name}»`)
          toggleVar(name)
          break
        }
        case 'local.toast': {
          deps.toast(intp(String(o?.parameters?.text ?? ''), E) || '(mensaje vacío)')
          break
        }
        default: {
          await deps.execRemote({ ...o, parameters: interpParams(o?.parameters ?? {}, E) }, ctx)
        }
      }
    } catch (e: any) {
      deps.toast(`Error: ${e?.message ?? e}`)
    }
  }

  async function runList(L: any[], parallel: boolean, ctx: Record<string, any>): Promise<void> {
    const list = Array.isArray(L) ? L : []
    if (parallel) {
      await Promise.all(list.map((o) => perform(o, ctx)))
      return
    }
    for (const o of list) {
      await perform(o, ctx)
      const d = Math.min(+o?.waitMs || 0, 10000)
      if (d) await sleep(d)
    }
  }

  async function runRule(K: any, r: any, ctx: Record<string, any>): Promise<void> {
    let ok = true
    try {
      ok = (r?.cond || '').trim() ? !!ev(r.cond, env()) : true
    } catch (e: any) {
      deps.toast(`Regla: ${e?.message ?? e}`)
      return
    }
    if (depth < 4) {
      depth++
      try {
        await runList(ok ? r.then : r.else, false, ctx)
      } finally {
        depth--
      }
    }
  }

  function ctxFor(pos: number, trigger?: Trigger): Record<string, any> {
    const b = deps.getButton(pos)
    return {
      buttonId: b?.id ?? null,
      pageId: deps.pageId(),
      profileId: '',
      position: pos,
      pressType: trigger ?? 'press',
      deviceId: getOrCreateDeviceId(),
      source: 'web',
    }
  }

  async function execKey(pos: number, trigger: Trigger = 'press'): Promise<void> {
    const K = deps.getExecData(pos)
    if (!K) return
    // Un long consume el tap pendiente (no debe caer después un click).
    if (trigger === 'long') cancelTap(pos)
    const rules = Array.isArray(K.rules) ? K.rules : []
    const kind: PressKind =
      trigger === 'double' ? 'double' : trigger === 'triple' ? 'triple' : trigger === 'long' ? 'long' : 'click'
    const acts = getActionsForKind(K, kind)
    if (kind === 'click' && !acts.length && !rules.some((r: any) => r?.on && r?.when === 'press')) {
      deps.noActionsToast()
      return
    }
    if ((kind === 'double' || kind === 'triple' || kind === 'long') && !hasKindContent(K, kind)) {
      return
    }
    if (!deps.executing.value.includes(pos)) deps.executing.value.push(pos)
    try {
      const ctx = ctxFor(pos, trigger)
      if (acts.length) {
        if ((K.mode ?? 'seq') === 'par') await runList(acts, true, ctx)
        // `alt` (rotar) solo aplica al click, igual que el daemon.
        else if (kind === 'click' && (K.mode ?? 'seq') === 'alt') {
          const key = `${deps.pageId()}:${pos}`
          const i = altIndex.get(key) ?? 0
          const o = acts[i % acts.length]
          altIndex.set(key, i + 1)
          if (o) await perform(o, ctx)
        } else await runList(acts, false, ctx)
      }
      const when = trigger === 'press' ? 'press' : trigger
      for (const r of rules) {
        if (r?.on && r?.when === when) await runRule(K, r, ctx)
      }
    } finally {
      setTimeout(() => {
        const i = deps.executing.value.indexOf(pos)
        if (i > -1) deps.executing.value.splice(i, 1)
      }, 400)
    }
  }

  // ---- Multi-tap con debounce (Fase B) ----
  // El click simple espera TAP_WINDOW_MS solo si la tecla tiene contenido
  // double/triple; sin él se ejecuta al instante (sin penalizar latencia).
  // Documentado: el single-click tarda ~340 ms en teclas multi-tap.
  const tapState = new Map<number, { n: number; t: ReturnType<typeof setTimeout> | null }>()

  function fireTap(pos: number): void {
    const st = tapState.get(pos)
    tapState.delete(pos)
    if (!st) return
    const kind: PressKind = st.n >= 3 ? 'triple' : st.n === 2 ? 'double' : 'click'
    const trigger: Trigger = kind === 'click' ? 'press' : kind
    void execKey(pos, trigger)
  }

  /** Un toque corto: debounce a click/double/triple según la tecla. */
  function tapKey(pos: number): void {
    const K = deps.getExecData(pos)
    if (!K) return
    if (!hasMultiTapContent(K)) {
      void execKey(pos, 'press')
      return
    }
    const prev = tapState.get(pos)
    if (prev?.t) clearTimeout(prev.t)
    const n = Math.min(3, (prev?.n ?? 0) + 1)
    tapState.set(pos, {
      n,
      t: setTimeout(() => fireTap(pos), TAP_WINDOW_MS),
    })
  }

  /** Cancela el tap pendiente (el long lo consume; también al desmontar). */
  function cancelTap(pos?: number): void {
    if (pos === undefined) {
      for (const [, st] of tapState) if (st.t) clearTimeout(st.t)
      tapState.clear()
      return
    }
    const st = tapState.get(pos)
    if (st?.t) clearTimeout(st.t)
    tapState.delete(pos)
  }

  /** Solo para tests: nº de toques acumulados pendientes. */
  function pendingTaps(pos: number): number {
    return tapState.get(pos)?.n ?? 0
  }

  /** Reglas «load» de la página actual (tras abrirla). */
  function runLoad(getPositions: () => number[]): void {
    if (depth > 2) return
    depth++
    try {
      for (const pos of getPositions()) {
        const K = deps.getExecData(pos)
        if (!K) continue
        for (const r of K.rules ?? []) {
          if (r?.on && r?.when === 'load') void runRule(K, r, ctxFor(pos, 'load'))
        }
      }
    } finally {
      setTimeout(() => { depth-- }, 0)
    }
  }

  /** Tic de 1 s: temporizadores. Devuelve si algo cambió (para re-render). */
  function onTick(getPositions: () => number[]): void {
    displayTick.value++
    for (const pos of getPositions()) {
      const K = deps.getExecData(pos)
      if (!K) continue
      for (const r of K.rules ?? []) {
        if (r?.on && r?.when === 'timer') {
          const every = Math.max(1, Math.round(+r.every || 5))
          if (displayTick.value % every === 0) void runRule(K, r, ctxFor(pos, 'timer'))
        }
      }
    }
  }

  /** Al cambiar una variable: reglas «var» que la observan. */
  function onVarChange(name: string, getPositions: () => number[]): void {
    if (depth >= 4) return
    depth++
    try {
      for (const pos of getPositions()) {
        const K = deps.getExecData(pos)
        if (!K) continue
        for (const r of K.rules ?? []) {
          if (r?.on && r?.when === 'var' && r?.vn === name) void runRule(K, r, ctxFor(pos, 'var'))
        }
      }
    } finally {
      setTimeout(() => { depth-- }, 0)
    }
  }

  /** Apariencia efectiva de una tecla (looks + {{vars}} en el título).
   *
   *  Memoización por tecla: el template lee ~10 props por tecla y el tick
   *  global re-dispara el render cada segundo. Para teclas estáticas (sin
   *  conds en looks ni {{}} en textos) se reutiliza el último resultado sin
   *  reevaluar nada. Para teclas dinámicas, la caché se invalida solo si
   *  cambia el contenido, los valores de las vars que usa, o el tick cuando
   *  usa incorporadas de tiempo (hora/minuto/segundo/dia).
   */
  interface DispEntry {
    sig: string
    result: any
    usedVars: string[]
    timeDep: boolean
    envSig: string
  }
  const dispCache = new Map<string, DispEntry>()
  /** Incorporadas que cambian con el tiempo: solo entonces el tick invalida. */
  const TIME_RE = /(^|[^\p{L}\p{N}_])(hora|minuto|segundo|dia)(?![\p{L}\p{N}_])/u
  /** perfil/pagina también van al env: si cambian, la caché debe invalidar. */
  const SCOPE_RE = /(^|[^\p{L}\p{N}_])(perfil|pagina)(?![\p{L}\p{N}_])/u

  const dispTextOf = (raw: any): string => {
    const parts: string[] = []
    for (const l of (Array.isArray(raw?.looks) ? raw.looks : [])) {
      parts.push(String(l?.cond ?? ''), String(l?.t ?? ''))
    }
    parts.push(
      String(raw?.label ?? ''), String(raw?.textTop ?? ''),
      String(raw?.textBottom ?? ''), String(raw?.title ?? '')
    )
    return parts.join('\n')
  }
  const rawSigOf = (raw: any): string => {
    try {
      return JSON.stringify([
        raw?.label, raw?.textTop, raw?.textBottom, raw?.title,
        raw?.icon, raw?.iconImage, raw?.emoji, raw?.textColor,
        raw?.backgroundColor, raw?.fontSize, raw?.showTitle,
        raw?.dynamicValue,
        (Array.isArray(raw?.looks) ? raw.looks : []).map((l: any) => [l?.cond, l?.t, l?.i, l?.c, l?.bg]),
      ])
    } catch {
      return String((raw?.label ?? '') + (raw?.icon ?? '') + (raw?.looks?.length ?? 0))
    }
  }

  function resolveDisplay(pos: number): any {
    const raw = deps.getExecData(pos)
    if (!raw) return raw
    const btn = deps.getButton(pos)
    const key = btn?.id ? `id:${btn.id}` : `pos:${pos}`
    const sig = rawSigOf(raw)
    const cached = dispCache.get(key)
    // Suscribirse al tick y a la versión de vars: sin estas lecturas el
    // computed padre no re-renderiza al pasar un segundo o cambiar una var.
    const tick = displayTick.value
    void varsVersion.value

    let usedVars: string[]
    let timeDep: boolean
    if (cached && cached.sig === sig) {
      usedVars = cached.usedVars
      timeDep = cached.timeDep
      // Sin cambios relevantes: reutilizar sin reevaluar.
      let envSig = timeDep ? `t${tick}\u0000` : ''
      for (const n of usedVars) envSig += String(getVar(n)?.v ?? '') + '\u0000'
      if (envSig === cached.envSig) return cached.result
    } else {
      const text = dispTextOf(raw)
      const names = vars.value.map((v) => v.n)
      usedVars = usedVarNames(text, names)
      timeDep = TIME_RE.test(text) || SCOPE_RE.test(text)
    }

    const E = env()
    const looks = Array.isArray(raw.looks) ? raw.looks : []
    const L = looks.find((l: any) => l?.cond && evb(l.cond, E))
    let result: any
    if (!L) {
      const hasTpl = /\{\{/.test(String(raw.label ?? '') + String(raw.textTop ?? '') + String(raw.textBottom ?? ''))
      result = hasTpl || usedVars.length || timeDep
        ? { ...raw, label: intp(raw.label ?? '', E) }
        : { ...raw }
    } else {
      result = {
        ...raw,
        label: intp(L.t || raw.label || '', E),
        icon: L.i || raw.icon || 'zap',
        textColor: L.c != null ? (COLORS[L.c] ?? raw.textColor) : raw.textColor,
        backgroundColor: L.bg ? (BGS[L.bg] ?? raw.backgroundColor) : raw.backgroundColor
      }
    }
    let envSig = timeDep ? `t${tick}\u0000` : ''
    for (const n of usedVars) envSig += String(getVar(n)?.v ?? '') + '\u0000'
    const entry: DispEntry = { sig, result, usedVars, timeDep, envSig }
    dispCache.set(key, entry)
    if (dispCache.size > 500) {
      const first = dispCache.keys().next()
      if (!first.done) dispCache.delete(first.value)
    }
    return result
  }

  /** Solo para tests: vacía la caché de apariencia. */
  function clearDisplayCache(): void {
    dispCache.clear()
  }

  return { execKey, tapKey, cancelTap, pendingTaps, runLoad, onTick, onVarChange, resolveDisplay, clearDisplayCache, uid }
}

export const COLORS = ['#e8e9eb', '#e8b04e', '#86cba5', '#82b4ea', '#ec8e7f', '#c7a6e0']
const BGS: Array<string | undefined> = [undefined, '#5a2b2b', '#2b5a3a', '#2b3f5a', '#5a4a24', '#4b315e']

/** Variables usadas por una tecla (acciones + reglas + looks) y sus páginas. */
export function keyUsedVars(key: any, pages: Array<{ buttons: Array<{ data: any }> }>, allNames: string[]): string[] {
  const parts: string[] = []
  const push = (a: any) => {
    parts.push(JSON.stringify(a?.parameters ?? {}), String(a?.type ?? ''))
    if (typeof a?.waitMs === 'number') parts.push('')
  }
  for (const a of key?.actions ?? []) push(a)
  for (const pa of Object.values(key?.pressActions ?? {})) {
    if (Array.isArray(pa)) for (const a of pa) push(a)
  }
  for (const r of key?.rules ?? []) {
    parts.push(String(r?.cond ?? ''), String(r?.vn ?? ''))
    for (const a of r?.then ?? []) push(a)
    for (const a of r?.else ?? []) push(a)
  }
  for (const l of key?.looks ?? []) parts.push(String(l?.cond ?? ''), String(l?.t ?? ''))
  for (const p of pages ?? []) for (const b of p.buttons ?? []) {
    for (const a of b?.data?.actions ?? []) push(a)
    for (const r of b?.data?.rules ?? []) {
      parts.push(String(r?.cond ?? ''))
      for (const a of r?.then ?? []) push(a)
      for (const a of r?.else ?? []) push(a)
    }
    for (const l of b?.data?.looks ?? []) parts.push(String(l?.cond ?? ''), String(l?.t ?? ''))
  }
  return usedVarNames(parts.join('\n'), allNames)
}

export type { LookLike }
export { vars, getVar }
