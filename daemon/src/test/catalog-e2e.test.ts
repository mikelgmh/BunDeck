/**
 * catalog-e2e.test.ts — E2E del catálogo a nivel HTTP (handleCatalog) + integridad.
 *
 * Cubre, sin DB real (fake best-effort como hace el handler):
 * 1. Tamper del manifest: copiar un manifest vivo y modificarlo hace que
 *    `verifyCatalogChecksum` falle (valid: false).
 * 2. GET /api/v1/catalog/:id inexistente → 404 con mensaje de error.
 * 3. Filtros combinados q + category + compatible (a nivel HTTP y puro).
 * 4. Un plugin deshabilitado (enabled=0 en DB) aparece como
 *    installed:true pero enabled:false, tanto en lista como en detalle.
 */
import { describe, it, expect } from 'bun:test';
import { handleCatalog } from '../api/catalog';
import {
  getCatalog,
  getCatalogEntry,
  searchCatalog,
  verifyCatalogChecksum,
} from '../catalog';
import { getNativeManifests } from '../plugins/index';
import type { DatabaseService } from '../db';

type CatalogBody = {
  total: number;
  plugins: Array<{
    id: string;
    category: string;
    compatible: boolean;
    installed: boolean;
    enabled: boolean;
    installedVersion: string | null;
    name: string;
  }>;
};

/** Fake mínimo de DatabaseService: solo lo que `handleCatalog` usa (best-effort). */
function fakeDb(rows: Array<{ id: string; enabled: number; version?: string }>) {
  return {
    getPlugins: () => rows.map((r) => ({ id: r.id, enabled: r.enabled, version: r.version ?? '1.0.0' })),
    getPlugin: (id: string) => {
      const r = rows.find((x) => x.id === id);
      return r ? { id: r.id, enabled: r.enabled, version: r.version ?? '1.0.0' } : null;
    },
  } as unknown as DatabaseService;
}

async function get(path: string, db?: DatabaseService) {
  const url = new URL(path, 'http://localhost');
  const res = await handleCatalog(new Request(url.toString()), {
    url,
    method: 'GET',
    path: url.pathname,
    db: (db ?? fakeDb([])) as DatabaseService,
    services: {} as never,
  });
  if (!res) throw new Error(`handleCatalog no maneja ${path}`);
  const body = (await res.json()) as Record<string, unknown>;
  return { status: res.status, body };
}

describe('catalog e2e: integridad sha256 ante manipulación', () => {
  it('una copia modificada del manifest vivo falla la verificación', () => {
    const entry = getCatalogEntry('shell');
    expect(entry).not.toBeNull();
    const live = getNativeManifests().find((m: unknown) => (m as { id: string })?.id === 'shell') as Record<string, unknown>;
    expect(live).toBeDefined();

    const ok = verifyCatalogChecksum(entry!, live);
    expect(ok).toMatchObject({ id: 'shell', algorithm: 'sha256', valid: true });
    expect(ok.sha256).toBe(entry!.checksum);

    // Copia manipulada (p. ej. atacante edita la descripción): debe fallar.
    const tampered = { ...live, description: 'manipulado por un tercero' };
    const bad = verifyCatalogChecksum(entry!, tampered);
    expect(bad.valid).toBe(false);
    expect(bad.sha256).not.toBe(entry!.checksum);
  });

  it('GET /:id/checksum del daemon refleja el manifest vivo (válido sin tamper)', async () => {
    const { status, body } = await get('/api/v1/catalog/shell/checksum');
    expect(status).toBe(200);
    expect(body).toMatchObject({ id: 'shell', algorithm: 'sha256', valid: true });
    expect(body['sha256']).toBe(body['catalogChecksum']);
  });
});

describe('catalog e2e: GET /:id inexistente → 404', () => {
  it('detalle de un id fuera del catálogo responde 404', async () => {
    const { status, body } = await get('/api/v1/catalog/no-existe-xyz');
    expect(status).toBe(404);
    expect(String((body as { error?: string }).error ?? '')).toMatch(/no-existe-xyz/);
  });

  it('checksum de un id fuera del catálogo también responde 404', async () => {
    const { status } = await get('/api/v1/catalog/no-existe-xyz/checksum');
    expect(status).toBe(404);
  });

  it('un subrecurso desconocido responde 404', async () => {
    const { status } = await get('/api/v1/catalog/shell/inventado');
    expect(status).toBe(404);
  });
});

describe('catalog e2e: filtros combinados q + category + compatible', () => {
  it('a nivel HTTP: q + category + compatible=true solo devuelve compatibles de esa categoría', async () => {
    const { status, body } = await get('/api/v1/catalog?q=luz&category=integrations&compatible=true');
    expect(status).toBe(200);
    const list = body as unknown as CatalogBody;
    expect(list.total).toBeGreaterThan(0);
    expect(list.plugins.length).toBe(list.total);
    for (const p of list.plugins) {
      expect(p.category).toBe('integrations');
      expect(p.compatible).toBe(true);
    }
    expect(list.plugins.some((p) => p.id === 'homeassistant')).toBe(true);
  });

  it('combinación pura determinista: el incompatible sintético queda excluido', () => {
    const { entries } = getCatalog();
    const future = {
      ...entries[0],
      id: 'futuro-e2e',
      name: 'Futuro E2E',
      category: entries[0].category,
      compatibility: { os: ['win32'], minVersion: '99.0.0' },
    };
    const withFuture = [...entries, future];
    const needle = entries[0].id; // q que casa con la entrada base
    const found = searchCatalog(withFuture, {
      q: needle,
      category: future.category,
      compatible: true,
      appVersion: '1.0.0',
    });
    expect(found.some((e) => e.id === 'futuro-e2e')).toBe(false);
    const onlyIncompat = searchCatalog(withFuture, {
      q: needle,
      category: future.category,
      compatible: false,
      appVersion: '1.0.0',
    });
    expect(onlyIncompat.map((e) => e.id)).toEqual(['futuro-e2e']);
  });
});

describe('catalog e2e: plugin deshabilitado → installed pero no enabled', () => {
  const rows = [
    { id: 'obs', enabled: 0, version: '2.0.1' },
    { id: 'shell', enabled: 1, version: '1.0.0' },
  ];

  it('en la lista: obs installed:true/enabled:false, shell enabled:true', async () => {
    const { status, body } = await get('/api/v1/catalog', fakeDb(rows));
    expect(status).toBe(200);
    const list = body as unknown as CatalogBody;
    const byId = new Map(list.plugins.map((p) => [p.id, p]));
    expect(byId.get('obs')).toMatchObject({ installed: true, enabled: false, installedVersion: '2.0.1' });
    expect(byId.get('shell')).toMatchObject({ installed: true, enabled: true });
  });

  it('en el detalle: GET /obs conserva installed:true/enabled:false', async () => {
    const { status, body } = await get('/api/v1/catalog/obs', fakeDb(rows));
    expect(status).toBe(200);
    expect(body).toMatchObject({ id: 'obs', installed: true, enabled: false, installedVersion: '2.0.1' });
  });

  it('sin DB (best-effort): todo aparece como no instalado', async () => {
    const { status, body } = await get('/api/v1/catalog/obs', fakeDb([]));
    expect(status).toBe(200);
    expect(body).toMatchObject({ id: 'obs', installed: false, enabled: false });
  });
});
