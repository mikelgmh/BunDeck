/**
 * Intérprete de expresiones de reglas y variables (sin eval).
 * Réplica servidor de `web/src/composables/useExpressions.ts`: misma
 * sintaxis y mismas funciones. Cambios aquí deben reflejarse allí y viceversa.
 *
 * Operadores: + - * / % · == != < > <= >= · y/o/no (o && || !) · cond ? a : b
 * Funciones: abs min max round floor ceil aleatorio(n) longitud mayus minus
 *            contiene texto numero. Incorporadas: hora minuto segundo dia
 *            perfil pagina. En textos: {{variable}}.
 */

export const IDRE = /^[\p{L}_][\p{L}\p{N}_]*$/u;
export const RES = ['y', 'o', 'no', 'and', 'or', 'not', 'true', 'false', 'verdadero', 'falso'];

const FN: Record<string, (...a: any[]) => any> = {
  abs: Math.abs, min: Math.min, max: Math.max, round: Math.round,
  floor: Math.floor, ceil: Math.ceil,
  aleatorio: (n: any) => Math.floor(Math.random() * (+n || 2)),
  longitud: (s: any) => String(s).length,
  mayus: (s: any) => String(s).toUpperCase(),
  minus: (s: any) => String(s).toLowerCase(),
  contiene: (s: any, t: any) => String(s).includes(String(t)),
  texto: (v: any) => String(v),
  numero: (v: any) => +v,
};

type Tok = { k: 'n' | 's' | 'id' | 'o'; v: any };

function tokenize(src: string): Tok[] {
  const t: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] || ''))) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j])) j++;
      t.push({ k: 'n', v: parseFloat(src.slice(i, j)) }); i = j; continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1, x = '';
      while (j < src.length && src[j] !== c) { if (src[j] === '\\' && j + 1 < src.length) j++; x += src[j]; j++; }
      if (j >= src.length) throw new Error('Texto sin cerrar');
      t.push({ k: 's', v: x }); i = j + 1; continue;
    }
    const m = /^[\p{L}_][\p{L}\p{N}_]*/u.exec(src.slice(i));
    if (m) { t.push({ k: 'id', v: m[0] }); i += m[0].length; continue; }
    const o = ['===', '!==', '==', '!=', '<=', '>=', '&&', '||'].find((x) => src.startsWith(x, i)) ||
      (/[+\-*/%<>!()?:,]/.test(c) ? c : null);
    if (!o) throw new Error(`Carácter no válido «${c}». Para comparar usa ==`);
    t.push({ k: 'o', v: o }); i += o.length;
  }
  return t;
}

export type Env = Record<string, any>;
type Fn = (e: Env) => any;

function parse(src: string): Fn {
  const T = tokenize(src);
  let p = 0;
  const nx = () => T[p++];
  const isO = (v: string) => !!(T[p] && T[p].k === 'o' && T[p].v === v);
  const kw = (a: string[]) => !!(T[p] && T[p].k === 'id' && a.includes(String(T[p].v).toLowerCase()));

  function tern(): Fn {
    const c = or();
    if (isO('?')) { p++; const a = tern(); if (!isO(':')) throw new Error('Falta «:» en el condicional'); p++; const b = tern(); return (e) => (c(e) ? a(e) : b(e)); }
    return c;
  }
  function or(): Fn {
    let l = and();
    while (isO('||') || kw(['o', 'or'])) { p++; const r = and(), a = l; l = ((aa: Fn, rr: Fn) => (e: Env) => aa(e) || rr(e))(a, r); }
    return l;
  }
  function and(): Fn {
    let l = eq();
    while (isO('&&') || kw(['y', 'and'])) { p++; const r = eq(), a = l; l = ((aa: Fn, rr: Fn) => (e: Env) => aa(e) && rr(e))(a, r); }
    return l;
  }
  function eq(): Fn {
    let l = cmp();
    while (isO('==') || isO('!=') || isO('===') || isO('!==')) {
      const o = nx().v, r = cmp(), a = l;
      l = (o === '==' || o === '===') ? ((aa: Fn, rr: Fn) => (e: Env) => aa(e) == rr(e))(a, r) : ((aa: Fn, rr: Fn) => (e: Env) => aa(e) != rr(e))(a, r);
    }
    return l;
  }
  function cmp(): Fn {
    let l = add();
    while (['<', '>', '<=', '>='].some(isO)) {
      const o = nx().v, r = add(), a = l;
      l = ((aa: Fn, rr: Fn, oo: string) => (e: Env) => { const x = aa(e), y = rr(e); return oo === '<' ? x < y : oo === '>' ? x > y : oo === '<=' ? x <= y : x >= y; })(a, r, o);
    }
    return l;
  }
  function add(): Fn {
    let l = mul();
    while (isO('+') || isO('-')) {
      const o = nx().v, r = mul(), a = l;
      l = o === '+'
        ? ((aa: Fn, rr: Fn) => (e: Env) => { const x = aa(e), y = rr(e); return typeof x === 'string' || typeof y === 'string' ? String(x) + String(y) : x + y; })(a, r)
        : ((aa: Fn, rr: Fn) => (e: Env) => aa(e) - rr(e))(a, r);
    }
    return l;
  }
  function mul(): Fn {
    let l = un();
    while (isO('*') || isO('/') || isO('%')) {
      const o = nx().v, r = un(), a = l;
      l = o === '*' ? ((aa: Fn, rr: Fn) => (e: Env) => aa(e) * rr(e))(a, r) : o === '/' ? ((aa: Fn, rr: Fn) => (e: Env) => aa(e) / rr(e))(a, r) : ((aa: Fn, rr: Fn) => (e: Env) => aa(e) % rr(e))(a, r);
    }
    return l;
  }
  function un(): Fn {
    if (isO('!') || kw(['no', 'not'])) { p++; const a = un(); return ((aa: Fn) => (e: Env) => !aa(e))(a); }
    if (isO('-')) { p++; const a = un(); return ((aa: Fn) => (e: Env) => -aa(e))(a); }
    return pr();
  }
  function pr(): Fn {
    const t = nx();
    if (!t) throw new Error('La expresión está incompleta');
    if (t.k === 'n' || t.k === 's') { const v = t.v; return () => v; }
    if (t.k === 'o' && t.v === '(') { const a = tern(); if (!isO(')')) throw new Error('Falta «)»'); p++; return a; }
    if (t.k === 'id') {
      const n = t.v, l = String(n).toLowerCase();
      if (l === 'true' || l === 'verdadero') return () => true;
      if (l === 'false' || l === 'falso') return () => false;
      if (isO('(')) {
        p++;
        const args: Fn[] = [];
        if (!isO(')')) { for (;;) { args.push(tern()); if (isO(',')) { p++; continue; } break; } }
        if (!isO(')')) throw new Error('Falta «)»');
        p++;
        const f = FN[n];
        if (!f) throw new Error(`Función desconocida «${n}»`);
        return ((ff: (...a: any[]) => any, aa: Fn[]) => (e: Env) => ff(...aa.map((a) => a(e))))(f, args);
      }
      return ((nn: string) => (e: Env) => { if (!(nn in e)) throw new Error(`Variable desconocida «${nn}»`); return e[nn]; })(n);
    }
    throw new Error(`No se esperaba «${t.v}»`);
  }

  const f = tern();
  if (p < T.length) throw new Error(`No se esperaba «${T[p].v}»`);
  return f;
}

const CC = new Map<string, Fn>();
export function compile(src: string): Fn {
  let f = CC.get(src);
  if (!f) {
    f = parse(src);
    if (CC.size > 500) CC.clear();
    CC.set(src, f);
  }
  return f;
}

export const ev = (src: string, E: Env): any => compile(String(src))(E);
export const evb = (src: string, E: Env): boolean => {
  try { return !!ev(src, E); } catch { return false; }
};

/** Interpola {{expresion}} en textos (igual que el cliente). */
export const intp = (str: string, E: Env): string =>
  String(str ?? '').replace(/\{\{([^}]+)\}\}/g, (_m, x) => {
    try {
      const v = ev(x, E);
      return v === true ? 'sí' : v === false ? 'no' : String(v);
    } catch { return '⚠'; }
  });

export function baseEnv(vars: Array<{ n: string; v: any }>, perfil = '', pagina = ''): Env {
  const d = new Date();
  const e: Env = {};
  for (const x of vars) e[x.n] = x.v;
  return { ...e, hora: d.getHours(), minuto: d.getMinutes(), segundo: d.getSeconds(), dia: (d.getDay() + 6) % 7 + 1, perfil, pagina };
}

/** Nombres de variables usadas en un texto JSON. */
export function usedVarNames(text: string, names: string[]): string[] {
  return names.filter((n) => {
    try {
      return new RegExp('(^|[^\\p{L}\\p{N}_])' + n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '($|[^\\p{L}\\p{N}_])', 'u').test(text);
    } catch { return false; }
  });
}

/** Resuelve un número que puede venir como literal o expresión {{...}}/texto. */
export function resolveNum(v: unknown, E: Env, fallback: number): number {
  try {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string') {
      const s = v.trim();
      if (!s) return fallback;
      if (/^[+-]?\d+(\.\d+)?$/.test(s)) return Number(s);
      const inner = /^\{\{([\s\S]+)\}\}$/.exec(s);
      const n = Number(inner ? ev(inner[1], E) : ev(s, E));
      if (Number.isFinite(n)) return n;
    }
  } catch { /* fallback */ }
  return fallback;
}
