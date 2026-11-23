/**
 * Tipos, validación y coerción del servicio daemon de variables.
 *
 * Tipos: text | numeric | bool | color (alias compat: txt→text, num→numeric,
 * number→numeric, boolean→bool). Scopes: global | widget | script | automation.
 * `unavailable`: la fuente no está disponible (integración caída); se conserva
 * el último valor pero se marca para que la UI/plantillas lo degraden.
 */

export type VarType = 'text' | 'numeric' | 'bool' | 'color';
export type VarScope = 'global' | 'widget' | 'script' | 'automation';

export interface VariableDef {
  name: string;
  scope: VarScope;
  scopeId: string;
  type: VarType;
  /** Valor ya coercionado al tipo. */
  value: string | number | boolean;
  unavailable: boolean;
  /** Bindings de lectura/escritura: { read?, write? } (origen/destino). */
  bindings: { read?: string; write?: string | string[] } | null;
  updatedAt: number;
}

export const VAR_SCOPES: VarScope[] = ['global', 'widget', 'script', 'automation'];

/** Nombres reservados (operadores/funciones/builtins del evaluador). */
export const VAR_RESERVED = [
  'y', 'o', 'no', 'and', 'or', 'not', 'true', 'false', 'verdadero', 'falso',
  'hora', 'minuto', 'segundo', 'dia', 'perfil', 'pagina', 'vars',
];

const NAME_RE = /^[\p{L}_][\p{L}\p{N}_]*$/u;
export const COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

export function validateVarName(name: string): string {
  const n = String(name ?? '').trim();
  if (!n) throw new Error('Nombre de variable vacío');
  if (n.length > 40) throw new Error(`Nombre de variable demasiado largo (máx 40): «${n}»`);
  if (!NAME_RE.test(n)) throw new Error(`Nombre de variable inválido: «${n}»`);
  if (VAR_RESERVED.includes(n.toLowerCase())) throw new Error(`Nombre de variable reservado: «${n}»`);
  return n;
}

export function normalizeVarType(t: unknown): VarType {
  const s = String(t ?? 'text').toLowerCase();
  if (s === 'text' || s === 'txt' || s === 'string') return 'text';
  if (s === 'numeric' || s === 'num' || s === 'number') return 'numeric';
  if (s === 'bool' || s === 'boolean') return 'bool';
  if (s === 'color' || s === 'colour') return 'color';
  throw new Error(`Tipo de variable inválido: «${t}» (text|numeric|bool|color)`);
}

export function normalizeVarScope(s: unknown): VarScope {
  const v = String(s ?? 'global').toLowerCase();
  if ((VAR_SCOPES as string[]).includes(v)) return v as VarScope;
  throw new Error(`Scope inválido: «${s}» (global|widget|script|automation)`);
}

export type Coerced = string | number | boolean;

/** Coerciona un valor al tipo; lanza si el color no es válido. */
export function coerceVarValue(type: VarType, value: unknown): Coerced {
  switch (type) {
    case 'numeric': {
      if (typeof value === 'boolean') return value ? 1 : 0;
      const x = typeof value === 'number' ? value : Number(String(value ?? '').trim());
      return Number.isFinite(x) ? x : 0;
    }
    case 'bool': {
      if (typeof value === 'boolean') return value;
      if (typeof value === 'number') return value !== 0;
      const s = String(value ?? '').trim().toLowerCase();
      if (['true', 'sí', 'si', 'yes', '1', 'on', 'verdadero'].includes(s)) return true;
      return false;
    }
    case 'color': {
      const s = String(value ?? '').trim();
      if (!COLOR_RE.test(s)) throw new Error(`Color inválido: «${value}» (usa #rgb o #rrggbb)`);
      return s;
    }
    default:
      return String(value ?? '');
  }
}

/** Valor por defecto de cada tipo (para define() sin valor). */
export function defaultVarValue(type: VarType): Coerced {
  return type === 'numeric' ? 0 : type === 'bool' ? false : type === 'color' ? '#000000' : '';
}

/** Serializa a TEXT para la columna `variables.value`. */
export function serializeVarValue(type: VarType, value: Coerced): string {
  if (type === 'bool') return value ? '1' : '0';
  return String(value);
}

/** Deserializa desde TEXT según el tipo de la fila. */
export function deserializeVarValue(type: string, raw: string): Coerced {
  const t = (() => { try { return normalizeVarType(type); } catch { return 'text' as VarType; } })();
  if (t === 'numeric') {
    const x = Number(raw);
    return Number.isFinite(x) ? x : 0;
  }
  if (t === 'bool') return raw === '1' || raw.toLowerCase() === 'true';
  return String(raw ?? '');
}

/** Semántica de toggle compatible con el frontend (useVars.toggleVar). */
export function toggleVarValue(type: VarType, value: Coerced): Coerced {
  if (type === 'bool') return !value;
  if (type === 'numeric') return value ? 0 : 1;
  if (type === 'color') return value === '#000000' ? '#ffffff' : '#000000';
  return value ? '' : 'sí';
}

/** Parsea `bindings` (JSON TEXT de la BD) sin lanzar. */
export function parseBindings(raw: string | null | undefined): VariableDef['bindings'] {
  if (!raw) return null;
  try {
    const b = JSON.parse(raw);
    if (b && typeof b === 'object') {
      const out: { read?: string; write?: string | string[] } = {};
      if (typeof (b as any).read === 'string') out.read = (b as any).read;
      const w = (b as any).write;
      if (typeof w === 'string' || (Array.isArray(w) && w.every((x) => typeof x === 'string'))) out.write = w;
      return Object.keys(out).length ? out : null;
    }
  } catch { /* noop */ }
  return null;
}
