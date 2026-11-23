/**
 * Expresiones de reglas y variables (intérprete propio, sin eval).
 * Operadores: + - * / % · == != < > <= >= · y/o/no (o && || !) · cond ? a : b
 * Funciones: abs min max round floor ceil aleatorio(n) longitud mayus minus
 *            contiene texto numero. Incorporadas: hora minuto segundo dia
 *            perfil pagina. En textos: {{variable}}.
 */

export const IDRE = /^[\p{L}_][\p{L}\p{N}_]*$/u
export const RES = ['y', 'o', 'no', 'and', 'or', 'not', 'true', 'false', 'verdadero', 'falso']

const FN: Record<string, (...a: any[]) => any> = {
  abs: Math.abs, min: Math.min, max: Math.max, round: Math.round,
  floor: Math.floor, ceil: Math.ceil,
  aleatorio: (n: any) => Math.floor(Math.random() * (+n || 2)),
  longitud: (s: any) => String(s).length,
  mayus: (s: any) => String(s).toUpperCase(),
  minus: (s: any) => String(s).toLowerCase(),
  contiene: (s: any, t: any) => String(s).includes(String(t)),
  texto: (v: any) => String(v),
  numero: (v: any) => +v
}

type Tok = { k: 'n' | 's' | 'id' | 'o'; v: any }

function tokenize(src: string): Tok[] {
  const t: Tok[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (/\s/.test(c)) { i++; continue }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] || ''))) {
      let j = i
      while (j < src.length && /[0-9.]/.test(src[j])) j++
      t.push({ k: 'n', v: parseFloat(src.slice(i, j)) }); i = j; continue
    }
    if (c === '"' || c === "'") {
      let j = i + 1, x = ''
      while (j < src.length && src[j] !== c) { if (src[j] === '\\' && j + 1 < src.length) j++; x += src[j]; j++ }
      if (j >= src.length) throw new Error('Texto sin cerrar')
      t.push({ k: 's', v: x }); i = j + 1; continue
    }
    const m = /^[\p{L}_][\p{L}\p{N}_]*/u.exec(src.slice(i))
    if (m) { t.push({ k: 'id', v: m[0] }); i += m[0].length; continue }
    const o = ['===', '!==', '==', '!=', '<=', '>=', '&&', '||'].find((x) => src.startsWith(x, i)) ||
      (/[+\-*/%<>!()?:,]/.test(c) ? c : null)
    if (!o) throw new Error(`Carácter no válido «${c}». Para comparar usa ==`)
    t.push({ k: 'o', v: o }); i += o.length
  }
  return t
}

type Env = Record<string, any>
type Fn = (e: Env) => any

function parse(src: string): Fn {
  const T = tokenize(src)
  let p = 0
  const nx = () => T[p++]
  const isO = (v: string) => T[p] && T[p].k === 'o' && T[p].v === v
  const kw = (a: string[]) => T[p] && T[p].k === 'id' && a.includes(String(T[p].v).toLowerCase())

  function tern(): Fn {
    const c = or()
    if (isO('?')) { p++; const a = tern(); if (!isO(':')) throw new Error('Falta «:» en el condicional'); p++; const b = tern(); return (e) => (c(e) ? a(e) : b(e)) }
    return c
  }
  function or(): Fn {
    let l = and()
    while (isO('||') || kw(['o', 'or'])) { p++; const r = and(), a = l; l = (e) => a(e) || r(e) }
    return l
  }
  function and(): Fn {
    let l = eq()
    while (isO('&&') || kw(['y', 'and'])) { p++; const r = eq(), a = l; l = (e) => a(e) && r(e) }
    return l
  }
  function eq(): Fn {
    let l = cmp()
    while (isO('==') || isO('!=') || isO('===') || isO('!==')) {
      const o = nx().v, r = cmp(), a = l
      l = (o === '==' || o === '===') ? (e) => a(e) == r(e) : (e) => a(e) != r(e)
    }
    return l
  }
  function cmp(): Fn {
    let l = add()
    while (['<', '>', '<=', '>='].some(isO)) {
      const o = nx().v, r = add(), a = l
      l = (e) => { const x = a(e), y = r(e); return o === '<' ? x < y : o === '>' ? x > y : o === '<=' ? x <= y : x >= y }
    }
    return l
  }
  function add(): Fn {
    let l = mul()
    while (isO('+') || isO('-')) {
      const o = nx().v, r = mul(), a = l
      l = o === '+' ? (e) => { const x = a(e), y = r(e); return typeof x === 'string' || typeof y === 'string' ? String(x) + String(y) : x + y } : (e) => a(e) - r(e)
    }
    return l
  }
  function mul(): Fn {
    let l = un()
    while (isO('*') || isO('/') || isO('%')) {
      const o = nx().v, r = un(), a = l
      l = o === '*' ? (e) => a(e) * r(e) : o === '/' ? (e) => a(e) / r(e) : (e) => a(e) % r(e)
    }
    return l
  }
  function un(): Fn {
    if (isO('!') || kw(['no', 'not'])) { p++; const a = un(); return (e) => !a(e) }
    if (isO('-')) { p++; const a = un(); return (e) => -a(e) }
    return pr()
  }
  function pr(): Fn {
    const t = nx()
    if (!t) throw new Error('La expresión está incompleta')
    if (t.k === 'n' || t.k === 's') { const v = t.v; return () => v }
    if (t.k === 'o' && t.v === '(') { const a = tern(); if (!isO(')')) throw new Error('Falta «)»'); p++; return a }
    if (t.k === 'id') {
      const n = t.v, l = String(n).toLowerCase()
      if (l === 'true' || l === 'verdadero') return () => true
      if (l === 'false' || l === 'falso') return () => false
      if (isO('(')) {
        p++
        const args: Fn[] = []
        if (!isO(')')) { for (;;) { args.push(tern()); if (isO(',')) { p++; continue } break } }
        if (!isO(')')) throw new Error('Falta «)»')
        p++
        const f = FN[n]
        if (!f) throw new Error(`Función desconocida «${n}»`)
        return (e) => f(...args.map((a) => a(e)))
      }
      return (e) => { if (!(n in e)) throw new Error(`Variable desconocida «${n}»`); return e[n] }
    }
    throw new Error(`No se esperaba «${t.v}»`)
  }

  const f = tern()
  if (p < T.length) throw new Error(`No se esperaba «${T[p].v}»`)
  return f
}

const CC = new Map<string, Fn>()
export function compile(src: string): Fn {
  let f = CC.get(src)
  if (!f) {
    f = parse(src)
    if (CC.size > 500) CC.clear()
    CC.set(src, f)
  }
  return f
}

export const ev = (src: string, E: Env): any => compile(String(src))(E)
export const evb = (src: string, E: Env): boolean => {
  try { return !!ev(src, E) } catch { return false }
}

export function baseEnv(vars: Array<{ n: string; v: any }>, perfil: string, pagina: string, now?: Date): Env {
  const d = now ?? new Date()
  const e: Env = {}
  vars.forEach((x) => { e[x.n] = x.v })
  return { ...e, hora: d.getHours(), minuto: d.getMinutes(), segundo: d.getSeconds(), dia: (d.getDay() + 6) % 7 + 1, perfil, pagina }
}

export const fmt = (v: any): string =>
  v === true ? 'verdadero' : v === false ? 'falso' : typeof v === 'string' ? `«${v}»` : String(v)

/** Interpola {{expresion}} en textos. */
export const intp = (str: string, E: Env): string =>
  String(str ?? '').replace(/\{\{([^}]+)\}\}/g, (m, x) => {
    try {
      const v = ev(x, E)
      return v === true ? 'sí' : v === false ? 'no' : String(v)
    } catch { return '⚠' }
  })

export interface LookLike { cond?: string; t?: string; i?: string; c?: number | null; bg?: number }
export interface KeyLike { t?: string; label?: string; i?: string; icon?: string; c?: number; textColor?: string; bg?: number; backgroundColor?: string; looks?: LookLike[] }

/** Primera condición que se cumple; si no, valores base. */
export function vis<K extends KeyLike>(K: K, E: Env): { t: string; i: string; c: number; bg: number } {
  const L = (K.looks || []).find((l) => l.cond && evb(l.cond, E))
  const baseT = K.t ?? K.label ?? ''
  const baseI = K.i ?? K.icon ?? ''
  return {
    t: L && L.t ? L.t : baseT,
    i: (L && L.i ? L.i : baseI) || 'zap',
    c: L && L.c != null ? L.c : (K.c ?? 0),
    bg: L && L.bg ? L.bg : (K.bg ?? 0)
  }
}

/** Nombres de variables usadas en un texto JSON (para exportar solo las usadas). */
export function usedVarNames(text: string, names: string[]): string[] {
  return names.filter((n) => {
    try {
      return new RegExp('(^|[^\\p{L}\\p{N}_])' + n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '($|[^\\p{L}\\p{N}_])', 'u').test(text)
    } catch { return false }
  })
}
