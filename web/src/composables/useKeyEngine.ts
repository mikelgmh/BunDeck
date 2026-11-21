import { ref } from 'vue'
import { ev, evb, intp, usedVarNames, type LookLike } from './useExpressions'
import { getVar, setVarValue, toggleVar, vars, getEnv, displayTick } from './useVars'
import type { ButtonEntity } from '../types/streamdeck'

/** Acciones locales (grupo «Lógica»): se ejecutan en el cliente, nunca en el daemon. */
export const LOCAL_ACTIONS = [
  { type: 'local.set-var', icon: 'Variable', nameKey: 'bd.varSet', defaults: { name: '', expr: '' } },
  { type: 'local.toggle-var', icon: 'ToggleLeft', nameKey: 'bd.varToggle', defaults: { name: '' } },
  { type: 'local.toast', icon: 'MessageSquare', nameKey: 'bd.varToast', defaults: { text: '' } }
] as const

export type Trigger = 'press' | 'long' | 'load' | 'timer' | 'var'

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

  const env = () => getEnv(deps.profileName(), deps.pageName())

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

  function ctxFor(pos: number): Record<string, any> {
    const b = deps.getButton(pos)
    return { buttonId: b?.id ?? null, pageId: deps.pageId(), profileId: '', position: pos }
  }

  async function execKey(pos: number, trigger: Trigger = 'press'): Promise<void> {
    const K = deps.getExecData(pos)
    if (!K) return
    const rules = Array.isArray(K.rules) ? K.rules : []
    const acts = Array.isArray(K.actions) ? K.actions : []
    if (trigger === 'press' && !acts.length && !rules.some((r: any) => r?.on && r?.when === 'press')) {
      deps.noActionsToast()
      return
    }
    if (!deps.executing.value.includes(pos)) deps.executing.value.push(pos)
    try {
      const ctx = ctxFor(pos)
      if (trigger === 'press' && acts.length) {
        if ((K.mode ?? 'seq') === 'par') await runList(acts, true, ctx)
        else if ((K.mode ?? 'seq') === 'alt') {
          const key = `${deps.pageId()}:${pos}`
          const i = altIndex.get(key) ?? 0
          const o = acts[i % acts.length]
          altIndex.set(key, i + 1)
          if (o) await perform(o, ctx)
        } else await runList(acts, false, ctx)
      }
      for (const r of rules) {
        if (r?.on && r?.when === trigger) await runRule(K, r, ctx)
      }
    } finally {
      setTimeout(() => {
        const i = deps.executing.value.indexOf(pos)
        if (i > -1) deps.executing.value.splice(i, 1)
      }, 400)
    }
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
          if (r?.on && r?.when === 'load') void runRule(K, r, ctxFor(pos))
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
          if (displayTick.value % every === 0) void runRule(K, r, ctxFor(pos))
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
          if (r?.on && r?.when === 'var' && r?.vn === name) void runRule(K, r, ctxFor(pos))
        }
      }
    } finally {
      setTimeout(() => { depth-- }, 0)
    }
  }

  /** Apariencia efectiva de una tecla (looks + {{vars}} en el título). */
  function resolveDisplay(pos: number): any {
    const raw = deps.getExecData(pos)
    if (!raw) return raw
    // Leer tick para reevaluar cada segundo (hora, temporizadores).
    void displayTick.value
    const E = env()
    const L = (raw.looks ?? []).find((l: any) => l?.cond && evb(l.cond, E))
    if (!L) return { ...raw, label: intp(raw.label ?? '', E) }
    return {
      ...raw,
      label: intp(L.t || raw.label || '', E),
      icon: L.i || raw.icon || 'zap',
      textColor: L.c != null ? (COLORS[L.c] ?? raw.textColor) : raw.textColor,
      backgroundColor: L.bg ? (BGS[L.bg] ?? raw.backgroundColor) : raw.backgroundColor
    }
  }

  return { execKey, runLoad, onTick, onVarChange, resolveDisplay, uid }
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
