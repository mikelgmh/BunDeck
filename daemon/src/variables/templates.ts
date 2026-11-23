/**
 * Plantillas {{…}} con filtros básicos.
 *
 * Sintaxis: {{ expr | filtro | filtro(arg, …) }}
 * - `expr` es una expresión del evaluador (variables/expressions.ts):
 *   admite `vars.nombre` y el nombre pelado (`{{contador}}`, compat web).
 * - Filtros: upper, lower, trim, capitalize, default(v), round, fixed(n),
 *   yesno(a,b) (alias bool(a,b)), length, json, number, abs.
 * - Variable desconocida o `unavailable` sin `default()`: se interpola ''.
 */

import { ev, type Env } from './expressions';

type FilterFn = (v: any, args: string[]) => any;

function parseArgs(raw: string): string[] {
  const out: string[] = [];
  let cur = '', quote: string | null = null;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (quote) {
      if (c === quote) { quote = null; continue; }
      if (c === '\\' && i + 1 < raw.length) { i++; cur += raw[i]; continue; }
      cur += c;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === ',') { out.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim() !== '' || out.length) out.push(cur.trim());
  return out;
}

const FILTERS: Record<string, FilterFn> = {
  upper: (v) => String(v ?? '').toUpperCase(),
  lower: (v) => String(v ?? '').toLowerCase(),
  trim: (v) => String(v ?? '').trim(),
  capitalize: (v) => { const s = String(v ?? ''); return s ? s[0].toUpperCase() + s.slice(1) : s; },
  default: (v, a) => (v === undefined || v === null || v === '' ? (a[0] ?? '') : v),
  round: (v) => Math.round(Number(v)),
  abs: (v) => Math.abs(Number(v)),
  number: (v) => Number(v),
  fixed: (v, a) => {
    const n = Math.max(0, Math.min(20, parseInt(a[0] ?? '2', 10) || 0));
    const x = Number(v);
    return Number.isFinite(x) ? x.toFixed(n) : String(v ?? '');
  },
  yesno: (v, a) => (v ? (a[0] ?? 'sí') : (a[1] ?? 'no')),
  bool: (v, a) => (v ? (a[0] ?? 'sí') : (a[1] ?? 'no')),
  length: (v) => (Array.isArray(v) ? v.length : String(v ?? '').length),
  json: (v) => JSON.stringify(v),
};

/** Divide una cadena `a | b(c) | d` por `|` de nivel superior (respeta comillas). */
function splitPipes(src: string): string[] {
  const parts: string[] = [];
  let cur = '', quote: string | null = null, depth = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      cur += c;
      if (c === '\\' && i + 1 < src.length) { i++; cur += src[i]; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; cur += c; continue; }
    if (c === '(') depth++;
    if (c === ')') depth = Math.max(0, depth - 1);
    if (c === '|' && depth === 0) { parts.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  parts.push(cur.trim());
  return parts.filter((p) => p !== '');
}

export interface RenderOptions {
  /** Si true, las expresiones desconocidas se dejan intactas (para no
   *  romper plantillas ajenas como Jinja `{{ states(...) }}`). */
  keepUnknown?: boolean;
}

/**
 * Renderiza una plantilla. `lookup(name)` devuelve el valor o
 * `undefined` si no existe / no disponible. `env` añade incorporadas.
 */
export function renderTemplate(
  template: string,
  lookup: (name: string) => any,
  env: Env = {},
  opts: RenderOptions = {},
): string {
  return String(template ?? '').replace(/\{\{([^}]+)\}\}/g, (_m, inner) => {
    let unknown = false;
    try {
      const parts = splitPipes(String(inner));
      if (!parts.length) return '';
      const expr = parts[0];
      const chain = parts.slice(1);
      let value: any;
      // Vía rápida {{vars.nombre}}: no exige `vars` en el env.
      const direct = /^vars\.([\p{L}_][\p{L}\p{N}_]*)$/u.exec(expr.trim());
      if (direct && !(env as any)?.vars) {
        value = lookup(direct[1]);
      } else {
        try {
          value = ev(expr, new Proxy(env, {
            get(t, prop, recv) {
              if (typeof prop === 'string' && !(prop in t)) {
                const v = lookup(prop);
                if (v !== undefined) return v;
                unknown = true;
                return undefined;
              }
              return Reflect.get(t, prop, recv);
            },
            has(t, prop) {
              if (typeof prop === 'string') {
                if (prop in t) return true;
                return lookup(prop) !== undefined;
              }
              return Reflect.has(t, prop);
            },
          }));
        } catch {
          // Expresión con variable desconocida → undefined (la cubre default())
          value = undefined;
          unknown = true;
        }
      }
      // `vars` ya viene en env (baseEnv); si falta, se resuelve vía lookup
      try {
        for (const f of chain) {
          const m = /^([A-Za-z_][A-Za-z0-9_]*)(?:\((.*)\))?$/.exec(f.trim());
          if (!m) throw new Error(`Filtro inválido: «${f}»`);
          const fn = FILTERS[m[1].toLowerCase()];
          if (!fn) throw new Error(`Filtro desconocido: «${m[1]}»`);
          if (m[1].toLowerCase() === 'default' && value !== undefined && value !== null && value !== '') {
            continue;
          }
          value = fn(value, m[2] !== undefined ? parseArgs(m[2]) : []);
        }
      } catch {
        if (opts.keepUnknown) return _m;
        return '⚠';
      }
      if (value === undefined || value === null) {
        if (unknown && opts.keepUnknown) return _m;
        return '';
      }
      if (typeof value === 'boolean') return value ? 'sí' : 'no';
      return String(value);
    } catch {
      return '⚠';
    }
  });
}

/**
 * Construye el `lookup` + `env` desde una lista de variables resueltas.
 * `unavailable` se expone como `undefined` (degrada a ''/default()).
 */
export function lookupFromList(
  list: Array<{ name: string; value: any; unavailable?: boolean }>,
  extraEnv: Env = {},
): { lookup: (name: string) => any; env: Env } {
  const map = new Map<string, any>();
  for (const v of list) {
    if (!v.unavailable) map.set(v.name, v.value);
  }
  const bag: Record<string, any> = {};
  for (const [k, v] of map) bag[k] = v;
  return {
    lookup: (name: string) => map.get(name),
    env: { ...extraEnv, vars: bag },
  };
}

/** Nombres de variables referenciadas en una plantilla (para bindings/UI). */
export function templateVarNames(template: string): string[] {
  const names = new Set<string>();
  for (const m of String(template ?? '').matchAll(/\{\{([^}]+)\}\}/g)) {
    const head = splitPipes(String(m[1]))[0] ?? '';
    for (const id of head.matchAll(/[\p{L}_][\p{L}\p{N}_]*/gu)) {
      const w = id[0];
      if (w !== 'vars') names.add(w);
    }
  }
  return [...names];
}
