import { ref } from 'vue'
import { IDRE, RES, baseEnv } from './useExpressions'
import type { VarDef } from '../types/streamdeck'

const LS_KEY = 'libredeck:vars'

export const vars = ref<VarDef[]>(load())
/** Tick de visualización: lo incrementa el motor cada segundo para reevaluar condiciones. */
export const displayTick = ref(0)
/** Versión de variables: se incrementa con cada mutación (para invalidar cachés). */
export const varsVersion = ref(0)

const bumpVars = () => { varsVersion.value++ }

type Listener = (name: string) => void
const listeners = new Set<Listener>()
export function onVarChange(cb: Listener): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

function load(): VarDef[] {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_KEY) ?? 'null')
    if (Array.isArray(raw)) {
      return raw
        .filter((v) => v && typeof v.n === 'string' && IDRE.test(v.n) && !RES.includes(v.n.toLowerCase()))
        .slice(0, 64)
        .map((v) => ({ n: v.n.slice(0, 40), t: v.t === 'bool' ? 'bool' : v.t === 'txt' ? 'txt' : 'num', v: coerceVal(v.t, v.v) }))
    }
  } catch { /* noop */ }
  return defaultVars()
}

function persist() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(vars.value))
  } catch { /* noop */ }
}

export function defaultVars(): VarDef[] {
  return [
    { n: 'contador', t: 'num', v: 0 },
    { n: 'micSilenciado', t: 'bool', v: false },
    { n: 'modoDirecto', t: 'txt', v: 'charla' }
  ]
}

export function coerceVal(t: VarDef['t'], v: any): number | string | boolean {
  if (t === 'num') { const x = +v; return Number.isFinite(x) ? x : 0 }
  if (t === 'bool') return v === true || v === 'true' || (typeof v === 'number' && v !== 0)
  return String(v ?? '')
}

export function persistVars(): void {
  persist()
}

export function getVar(name: string): VarDef | undefined {
  return vars.value.find((x) => x.n === name)
}

export function setVarValue(name: string, val: any): boolean {
  const v = getVar(name)
  if (!v) return false
  const nv = v.t === 'num' ? (Number.isFinite(+val) ? +val : 0) : v.t === 'bool' ? !!val : String(val)
  if (nv === v.v) return false
  v.v = nv as any
  persist()
  bumpVars()
  listeners.forEach((cb) => { try { cb(name) } catch { /* noop */ } })
  return true
}

export function toggleVar(name: string): boolean {
  const v = getVar(name)
  if (!v) return false
  const nv = v.t === 'bool' ? !v.v : v.t === 'num' ? (v.v ? 0 : 1) : v.v ? '' : 'sí'
  return setVarValue(name, nv)
}

export function addVar(n?: string): VarDef {
  let i = 1
  let name = (n || '').trim()
  if (!name || !IDRE.test(name) || RES.includes(name.toLowerCase()) || getVar(name)) {
    while (getVar(`variable${i}`)) i++
    name = `variable${i}`
  }
  const v: VarDef = { n: name.slice(0, 40), t: 'num', v: 0 }
  vars.value.push(v)
  persist()
  bumpVars()
  return v
}

export function removeVar(name: string): VarDef | null {
  const i = vars.value.findIndex((x) => x.n === name)
  if (i < 0) return null
  const [v] = vars.value.splice(i, 1)
  persist()
  bumpVars()
  return v
}

/**
 * Funde un valor del daemon (WS `variable.changed`, servicio de variables
 * tipadas) en el store local sin recargar. Crea la variable si no existe
 * (las expuestas por acciones nacen en el daemon, no en Ajustes).
 * Tipos daemon → locales: bool→bool, numeric→num, text/color→txt.
 */
export function upsertRemoteVar(name: string, value: unknown, type?: string): void {
  if (typeof name !== 'string' || !IDRE.test(name) || RES.includes(name.toLowerCase())) return
  const t: VarDef['t'] = type === 'bool' || type === 'boolean' ? 'bool' : type === 'numeric' || type === 'num' ? 'num' : 'txt'
  const v = getVar(name)
  const nv = coerceVal(t, value)
  if (!v) {
    vars.value.push({ n: name.slice(0, 40), t, v: nv })
    persist()
    bumpVars()
    listeners.forEach((cb) => { try { cb(name) } catch { /* noop */ } })
    return
  }
  if (v.t !== t) v.t = t
  if (nv !== v.v) {
    v.v = nv
    persist()
    bumpVars()
    listeners.forEach((cb) => { try { cb(name) } catch { /* noop */ } })
  }
}

export function importVar(def: { n: string; t: VarDef['t']; v: any }): boolean {
  if (getVar(def.n)) return false
  if (!IDRE.test(def.n) || RES.includes(def.n.toLowerCase())) return false
  vars.value.push({ n: def.n.slice(0, 40), t: def.t === 'bool' ? 'bool' : def.t === 'txt' ? 'txt' : 'num', v: coerceVal(def.t, def.v) })
  persist()
  bumpVars()
  return true
}

/** Entorno de evaluación: variables + incorporadas. `now` reutiliza un Date
 *  ya creado (el motor crea uno por tick en vez de uno por tecla). */
export function getEnv(perfil = '', pagina = '', now?: Date): Record<string, any> {
  return baseEnv(vars.value, perfil, pagina, now)
}
