/**
 * i18n para acciones de plugins (daemon).
 *
 * Cada acción puede declarar:
 *   i18n: { es: { name, description }, en: { name, description } }
 *
 * `ensureActionI18n` garantiza el dict en tiempo de carga: si la acción no
 * lo trae (plugins externos/Elgato/antiguos), lo deriva de los valores
 * actuales (ES de origen; EN = fallback temporal pendiente de traducir).
 * La web elige según locale con fallback en → valor actual
 * (ver web/src/composables/usePluginLocale.ts).
 */

export const SUPPORTED_PLUGIN_LOCALES = ['en', 'es'] as const;
export type PluginLocale = (typeof SUPPORTED_PLUGIN_LOCALES)[number];
export const DEFAULT_PLUGIN_LOCALE: PluginLocale = 'en';

interface LocalizableEntry {
  name?: unknown;
  description?: unknown;
  i18n?: unknown;
}

function asText(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function langEntry(entry: { i18n?: unknown }, lang: string): { name?: string; description?: string } | undefined {
  const dict = entry.i18n as Record<string, unknown> | undefined;
  if (!dict || typeof dict !== 'object') return undefined;
  const hit = dict[lang] as { name?: unknown; description?: unknown } | undefined;
  if (!hit || typeof hit !== 'object') return undefined;
  const out: { name?: string; description?: string } = {};
  const name = asText(hit.name);
  const description = asText(hit.description);
  if (name) out.name = name;
  if (description) out.description = description;
  return name || description ? out : undefined;
}

/** Resuelve un campo localizable: locale → en → valor actual. */
export function localizeActionField(
  action: LocalizableEntry | null | undefined,
  field: 'name' | 'description',
  locale: string,
  fallback = ''
): string {
  if (!action) return fallback;
  const hit = langEntry(action, locale)?.[field]
    ?? (locale === 'en' ? undefined : langEntry(action, 'en')?.[field]);
  if (hit) return hit;
  return asText(action[field]) ?? fallback;
}

export function localizeActionName(
  action: LocalizableEntry | null | undefined,
  locale: string,
  fallback = ''
): string {
  return localizeActionField(action, 'name', locale, fallback);
}

export function localizeActionDescription(
  action: LocalizableEntry | null | undefined,
  locale: string,
  fallback = ''
): string {
  return localizeActionField(action, 'description', locale, fallback);
}

/**
 * Devuelve la acción con `i18n` garantizado (no muta la original).
 * Sin dict explícito: es/en = valores actuales (EN temporal = ES).
 */
export function ensureActionI18n<T>(action: T): T {
  if (!action || typeof action !== 'object') return action;
  const entry = action as unknown as LocalizableEntry;
  const existing = (entry.i18n ?? {}) as Record<string, unknown>;
  const name = asText(entry.name) ?? '';
  const description = asText(entry.description) ?? '';
  const es = { ...(langEntry(entry, 'es') ?? {}), ...(name && !langEntry(entry, 'es')?.name ? { name } : {}), ...(description && !langEntry(entry, 'es')?.description ? { description } : {}) };
  const en = { ...(langEntry(entry, 'en') ?? {}), ...(name && !langEntry(entry, 'en')?.name ? { name } : {}), ...(description && !langEntry(entry, 'en')?.description ? { description } : {}) };
  if (Object.keys(existing).length > 0 && (existing as any).es && (existing as any).en) return action;
  return { ...action, i18n: { ...existing, es, en } };
}

/** Normaliza todas las acciones de un manifiesto (no muta el original). */
export function withManifestI18n<T>(manifest: T): T {
  const m = manifest as unknown as { actions?: unknown };
  if (!m || !Array.isArray(m.actions)) return manifest;
  return { ...(manifest as object), actions: (m.actions as unknown[]).map((a) => ensureActionI18n(a)) } as T;
}
