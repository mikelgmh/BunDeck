/**
 * contract.ts — Helpers del contrato público de plugins v2.2.
 *
 * Los plugins nativos declaran el mismo contrato que los externos:
 * `apiVersion` + `engine` versionados, `category`/`os`, `states` por acción
 * (iconos dinámicos), `optionsFrom` (opciones dinámicas) y `widgets` básicos.
 * Sin dependencias nuevas.
 */

import { PLUGIN_API_VERSION, RECOMMENDED_ENGINE_RANGE } from '../plugin-system/types';

export const CONTRACT_API_VERSION = PLUGIN_API_VERSION;
export const CONTRACT_ENGINE = RECOMMENDED_ENGINE_RANGE;

/** Inyecta apiVersion/engine sin romper manifests actuales (no pisa si existen). */
export function withContract<T extends Record<string, any>>(manifest: T): T {
  return {
    apiVersion: CONTRACT_API_VERSION,
    engine: CONTRACT_ENGINE,
    ...manifest,
  };
}

/** Mapea un valor numérico a estado discreto por umbrales (iconos dinámicos). */
export function thresholdState(
  value: number,
  levels: Array<{ max: number; state: string }>
): string {
  for (const l of levels) {
    if (value <= l.max) return l.state;
  }
  return levels.length > 0 ? levels[levels.length - 1].state : 'unknown';
}

/** Opciones `{value,label}` desde una lista de strings (opciones dinámicas). */
export function optionsFromStrings(values: string[]): Array<{ value: string; label: string }> {
  return values.map((v) => ({ value: v, label: v }));
}

/** Valida que un resultado de `sourceAction` tenga forma `{options: [...]}`. */
export function normalizeOptionsResult(res: any): Array<{ value: string; label: string }> {
  const list = Array.isArray(res?.options) ? res.options : [];
  return list
    .filter((o: any) => o && typeof o.value !== 'undefined')
    .map((o: any) => ({ value: String(o.value), label: String(o.label ?? o.value) }))
    .slice(0, 500);
}
