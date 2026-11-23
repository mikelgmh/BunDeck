/**
 * Catálogo local de plugins (offline-first).
 *
 * Genera el índice buscable a partir de `getNativeManifests()` (daemon/src/plugins),
 * sin red ni DB nueva: el catálogo se construye en memoria y se cachea en el
 * proceso. Cada entrada resume id/name/version/description/author/category/type,
 * permissions, actions, compatibility (os/minVersion), keywords y el sha256 del
 * manifest para verificación de integridad.
 *
 * La validación reutiliza `plugin-system/validator.ts` (campos requeridos,
 * permisos conocidos, semver) para no duplicar reglas.
 */

import { createHash } from 'node:crypto';
import { getNativeManifests } from './plugins/index';
import { getVersion } from './version';
import { validateManifest, satisfiesEngine, compareSemver } from './plugin-system/validator';

export interface CatalogActionSummary {
  id: string;
  name: string;
  description: string;
}

export interface CatalogCompatibility {
  /** SO donde funciona el plugin (valores estilo process.platform). */
  os: string[];
  /** Versión mínima de la app (daemon) requerida. */
  minVersion: string;
}

export interface CatalogEntry {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  /** Categoría funcional: system | integrations | media | input | utility. */
  category: string;
  /** Origen del plugin: 'builtin' (nativo embebido). */
  type: string;
  permissions: string[];
  actions: CatalogActionSummary[];
  compatibility: CatalogCompatibility;
  keywords: string[];
  /** sha256 (hex) del manifest canónico — verificación de integridad. */
  checksum: string;
  validation: { valid: boolean; errors: string[]; warnings: string[] };
  /** Contrato público v2.2 (opcionales para no romper consumidores). */
  apiVersion?: string;
  engine?: string;
  widgets?: string[];
}

export interface CatalogSearchOptions {
  q?: string;
  category?: string;
  /** true = solo compatibles con appVersion, false = solo incompatibles. */
  compatible?: boolean;
  appVersion?: string;
}

/** Categorías conocidas (usadas por la UI para los filtros). */
export const CATALOG_CATEGORIES = ['system', 'integrations', 'media', 'input', 'utility'] as const;

/** Permisos que marcan un plugin como privilegiado (aviso en UI). */
export const PRIVILEGED_PERMISSIONS = new Set(['shell', 'system', 'filesystem']);

/** Categoría por id de plugin nativo (los manifests aún no declaran `category`). */
const CATEGORY_BY_ID: Record<string, string> = {
  shell: 'system',
  'open-app': 'system',
  'pc-vitals': 'system',
  'audio-mixer': 'system',
  homeassistant: 'integrations',
  spotify: 'integrations',
  obs: 'integrations',
  twitch: 'integrations',
  youtube: 'integrations',
  weather: 'integrations',
  http: 'integrations',
  email: 'utility',
  calendar: 'utility',
  multimedia: 'media',
  browser: 'media',
  hotkey: 'input',
  'type-text': 'input',
  page: 'utility',
  utility: 'utility',
};

const DEFAULT_OS = ['win32', 'linux', 'darwin'];

/** JSON canónico: claves ordenadas para que el sha256 sea estable. */
export function stableStringify(value: any): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

/** sha256 hex del manifest (integridad). */
export function manifestChecksum(manifest: any): string {
  return createHash('sha256').update(stableStringify(manifest)).digest('hex');
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/** Categoría: respeta `category`/`type` declarados, si no infiere por id/permisos. */
export function inferCategory(manifest: any): string {
  const declared =
    (typeof manifest?.category === 'string' && manifest.category) ||
    (typeof manifest?.type === 'string' &&
      CATALOG_CATEGORIES.includes(manifest.type as (typeof CATALOG_CATEGORIES)[number]) &&
      manifest.type) ||
    '';
  if (declared) return declared;
  if (manifest?.id && CATEGORY_BY_ID[manifest.id]) return CATEGORY_BY_ID[manifest.id];
  const perms = asStringArray(manifest?.permissions);
  if (perms.some((p) => p === 'shell' || p === 'system' || p === 'process')) return 'system';
  if (perms.some((p) => p === 'network' || p === 'http')) return 'integrations';
  if (perms.some((p) => p === 'keyboard' || p === 'input' || p === 'hotkey')) return 'input';
  if (perms.some((p) => p === 'multimedia' || p === 'browser' || p === 'monitoring')) return 'media';
  return 'utility';
}

/** Compatibilidad: respeta `os`/`minVersion`/`engine`/`compatibility` si existen. */
export function inferCompatibility(manifest: any): CatalogCompatibility {
  const compat = manifest?.compatibility && typeof manifest.compatibility === 'object' ? manifest.compatibility : {};
  const os = asStringArray(manifest?.os).length > 0 ? asStringArray(manifest.os) : asStringArray(compat.os);
  const minVersion =
    (typeof manifest?.minVersion === 'string' && manifest.minVersion) ||
    (typeof compat.minVersion === 'string' && compat.minVersion) ||
    (typeof manifest?.engine === 'string' && manifest.engine) ||
    '0.0.0';
  return { os: os.length > 0 ? os : [...DEFAULT_OS], minVersion };
}

/** Keywords en minúsculas desde id/nombre/descripción/acciones (para `?q=`). */
export function extractKeywords(manifest: any): string[] {
  const bag = new Set<string>();
  const push = (text: unknown) => {
    if (typeof text !== 'string') return;
    for (const tok of text
      .toLowerCase()
      .split(/[^a-z0-9áéíóúñü]+/i)
      .map((t) => t.trim())
      .filter((t) => t.length > 1)) {
      bag.add(tok);
    }
  };
  push(manifest?.id);
  push(manifest?.name);
  push(manifest?.description);
  for (const a of Array.isArray(manifest?.actions) ? manifest.actions : []) {
    push(a?.id);
    push(a?.name);
    push(a?.description);
  }
  for (const p of asStringArray(manifest?.permissions)) bag.add(p.toLowerCase());
  bag.add(inferCategory(manifest));
  return [...bag].sort();
}

export function toCatalogEntry(manifest: any): CatalogEntry {
  const actions = Array.isArray(manifest?.actions) ? manifest.actions : [];
  const entry: CatalogEntry = {
    id: String(manifest?.id ?? 'unknown'),
    name: String(manifest?.name ?? manifest?.id ?? 'unknown'),
    version: String(manifest?.version ?? '0.0.0'),
    description: String(manifest?.description ?? ''),
    author: String(manifest?.author ?? 'BunDeck'),
    category: inferCategory(manifest),
    type: 'builtin',
    permissions: asStringArray(manifest?.permissions),
    actions: actions.map((a: any) => ({
      id: String(a?.id ?? ''),
      name: String(a?.name ?? a?.id ?? ''),
      description: String(a?.description ?? ''),
    })),
    compatibility: inferCompatibility(manifest),
    keywords: extractKeywords(manifest),
    checksum: manifestChecksum(manifest),
    validation: validateManifest(manifest),
    apiVersion: typeof manifest?.apiVersion === 'string' ? manifest.apiVersion : undefined,
    engine: typeof manifest?.engine === 'string' ? manifest.engine : undefined,
    widgets: Array.isArray(manifest?.widgets) ? manifest.widgets.map((w: any) => String(w?.id ?? '')) : undefined,
  };
  return entry;
}

/** ¿El plugin es compatible con esta versión de la app? (engine/minVersion). */
export function isCompatible(entry: Pick<CatalogEntry, 'compatibility'>, appVersion: string): boolean {
  const min = entry.compatibility?.minVersion;
  if (!min || min === '0.0.0' || min === '*' || min.toLowerCase() === 'x') return true;
  try {
    // minVersion puede ser semver exacta o rango engine (^, ~, >=).
    return satisfiesEngine(min, appVersion);
  } catch {
    return true;
  }
}

// --- Caché en memoria (sin DB nueva; se regenera al reiniciar el daemon) ---

let cachedEntries: CatalogEntry[] | null = null;
let cachedAt = 0;

export function buildCatalog(): CatalogEntry[] {
  return getNativeManifests().map(toCatalogEntry);
}

/** Índice cacheado; `force=true` lo reconstruye (p.ej. tras instalar plugins). */
export function getCatalog(force = false): { entries: CatalogEntry[]; generatedAt: number } {
  if (!cachedEntries || force) {
    cachedEntries = buildCatalog();
    cachedAt = Date.now();
  }
  return { entries: cachedEntries, generatedAt: cachedAt };
}

export function invalidateCatalog(): void {
  cachedEntries = null;
  cachedAt = 0;
}

export function getCatalogEntry(id: string): CatalogEntry | null {
  const { entries } = getCatalog();
  return entries.find((e) => e.id === id) ?? null;
}

/** Búsqueda/filtros puros sobre entradas (la API añade installed/enabled de la DB). */
export function searchCatalog(entries: CatalogEntry[], opts: CatalogSearchOptions = {}): CatalogEntry[] {
  const appVersion = opts.appVersion ?? getVersion();
  let out = entries;
  if (opts.category) {
    const cat = opts.category.toLowerCase();
    out = out.filter((e) => e.category === cat);
  }
  if (opts.compatible !== undefined) {
    out = out.filter((e) => isCompatible(e, appVersion) === opts.compatible);
  }
  const q = (opts.q ?? '').trim().toLowerCase();
  if (q) {
    const tokens = q.split(/\s+/);
    out = out.filter((e) => {
      const hay = `${e.id} ${e.name} ${e.description} ${e.author} ${e.category} ${e.keywords.join(' ')} ${e.actions.map((a) => `${a.id} ${a.name} ${a.description}`).join(' ')}`.toLowerCase();
      return tokens.every((t) => hay.includes(t));
    });
  }
  return out;
}

/** Verifica la integridad: recomputa el sha256 y lo compara con el del catálogo. */
export function verifyCatalogChecksum(entry: CatalogEntry, manifest: any): { id: string; algorithm: string; sha256: string; valid: boolean } {
  const sha256 = manifestChecksum(manifest);
  return { id: entry.id, algorithm: 'sha256', sha256, valid: sha256 === entry.checksum };
}

// --- Instalación versionada (git/zip/directory) ---

/** ¿El `ref` es un rango de versiones (no rama/tag literal)? */
export function isVersionRangeRef(ref: string): boolean {
  const r = ref.trim();
  if (r === '*' || r.toLowerCase() === 'x' || r.toLowerCase() === 'latest') return true;
  return /^[\^~>=<]/.test(r);
}

/** Normaliza un tag git a semver (`v1.2.3` → `1.2.3`, ignora sufijos). */
export function tagToVersion(tag: string): string | null {
  const clean = tag.trim().replace(/^[=vV\s]+/, '');
  const m = /^(\d+\.\d+\.\d+)/.exec(clean);
  return m ? m[1] : null;
}

/**
 * Elige el mejor tag para un rango de versión (instalación versionada).
 * Devuelve el tag ORIGINAL (no normalizado) más alto que satisfaga el rango,
 * o null si ninguno cuadra. Función pura (testeable).
 */
export function pickBestTag(tags: string[], range: string): string | null {
  let best: string | null = null;
  let bestVer: string | null = null;
  for (const tag of tags) {
    const ver = tagToVersion(tag);
    if (!ver) continue;
    let ok = true;
    try {
      ok = satisfiesEngine(range.trim() || '*', ver);
    } catch {
      ok = true;
    }
    // satisfiesEngine(range, ver) chequea ver >= range-base: para elegir tag
    // hay que invertir → comprobar que el rango se cumple tomando el tag como
    // "current". OJO: para '^1.2.3' con ver='1.9.0' da true (correcto).
    if (!ok) continue;
    if (!bestVer || compareSemver(ver, bestVer) > 0) {
      best = tag;
      bestVer = ver;
    }
  }
  return best;
}
