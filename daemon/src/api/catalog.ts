/**
 * Rutas `/api/v1/catalog*` — catálogo local de plugins (offline, sin DB nueva).
 *
 * - GET /api/v1/catalog[?q=&category=&compatible=] — lista + búsqueda/filtros.
 * - GET /api/v1/catalog/:id — detalle de una entrada (+ estado installed/enabled).
 * - GET /api/v1/catalog/:id/checksum — sha256 del manifest (integridad).
 *
 * No rompe la API existente: prefijo propio, solo lectura, respuestas JSON.
 * Enriquecimiento installed/enabled vía DatabaseService (best-effort).
 */
import { getVersion } from '../version';
import { getCatalog, getCatalogEntry, searchCatalog, isCompatible } from '../catalog';
import { getNativeManifests } from '../plugins/index';
import { manifestChecksum } from '../catalog';
import { jsonResponse } from './http-helpers';
import type { ApiHandler } from './types';

function parseCompatibleFlag(raw: string | null): boolean | undefined {
  if (raw === null) return undefined;
  const v = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'only'].includes(v)) return true;
  if (['0', 'false', 'no'].includes(v)) return false;
  return undefined;
}

export const handleCatalog: ApiHandler = async (_req, { url, method, path, db }) => {
  if (path === '/api/v1/catalog') {
    if (method !== 'GET') return null;
    const q = url.searchParams.get('q') ?? undefined;
    const category = url.searchParams.get('category') ?? undefined;
    const compatible = parseCompatibleFlag(url.searchParams.get('compatible'));
    const appVersion = getVersion();
    const { entries, generatedAt } = getCatalog();
    const found = searchCatalog(entries, { q, category, compatible, appVersion });

    // Estado instalado/activado (best-effort: sin DB en tests → todo false).
    let installedById = new Map<string, { installed: boolean; enabled: boolean; installedVersion: string | null }>();
    try {
      installedById = new Map(
        db.getPlugins().map((p: any) => [
          p.id,
          { installed: true, enabled: Number(p.enabled) === 1, installedVersion: p.version ?? null },
        ])
      );
    } catch {
      // sin DB inicializada (tests): se omite el enriquecimiento
    }

    return jsonResponse({
      version: appVersion,
      generatedAt,
      total: found.length,
      plugins: found.map((e) => ({
        ...e,
        compatible: isCompatible(e, appVersion),
        ...(installedById.get(e.id) ?? { installed: false, enabled: false, installedVersion: null }),
      })),
    });
  }

  if (path.startsWith('/api/v1/catalog/')) {
    if (method !== 'GET') return null;
    const rest = decodeURIComponent(path.slice('/api/v1/catalog/'.length));
    const [rawId, sub] = rest.split('/');
    const entry = getCatalogEntry(rawId);
    if (!entry) return jsonResponse({ error: `Plugin '${rawId}' no está en el catálogo` }, 404);

    if (sub === 'checksum') {
      // Recomputa el sha256 desde el manifest vivo (detecta manipulación).
      const live = getNativeManifests().find((m: any) => m?.id === entry.id) ?? null;
      const sha256 = live ? manifestChecksum(live) : entry.checksum;
      return jsonResponse({
        id: entry.id,
        algorithm: 'sha256',
        sha256,
        catalogChecksum: entry.checksum,
        valid: sha256 === entry.checksum,
      });
    }

    if (sub) return jsonResponse({ error: 'API endpoint not found' }, 404);

    const appVersion = getVersion();
    let extra: any = { installed: false, enabled: false, installedVersion: null };
    try {
      const rec = db.getPlugin(entry.id) as any;
      if (rec) extra = { installed: true, enabled: Number(rec.enabled) === 1, installedVersion: rec.version ?? null };
    } catch {
      // best-effort
    }
    return jsonResponse({ ...entry, compatible: isCompatible(entry, appVersion), ...extra });
  }

  return null;
};
