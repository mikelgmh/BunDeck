/**
 * page-grid.test.ts — El tamaño de grid es POR PÁGINA.
 *
 * - POST /api/v1/pages acepta grid_cols/grid_rows/parent_id (antes los
 *   ignoraba: las páginas creadas quedaban en NULL = heredar del perfil).
 * - PUT /api/v1/pages/:id persiste grid_cols/grid_rows.
 * - ensureDefaultProfile rellena los NULL de las pantallas semilla con su
 *   tamaño de diseño (Deck 5x3, Mini 3x2, Neo 4x2, XL 8x4, Panel libre 8x4)
 *   sin pisar tamaños explícitos.
 */
import { describe, it, expect, beforeAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ld-pagegrid-test-'));
process.env.LIBREDECK_DATA_DIR = TMP;
fs.mkdirSync(path.join(TMP, 'plugins'), { recursive: true });

import { initDatabase, DatabaseService } from '../db';
import { handlePages } from '../api/pages';
import { ensureDefaultProfile } from '../default-profile';

let db: DatabaseService;
let profId = '';

const call = (p: string, init?: RequestInit) => {
  const req = new Request(`http://localhost:3001${p}`, init);
  const url = new URL(req.url);
  return handlePages(req, {
    url, method: req.method, path: p, db,
    services: { wsManager: { broadcast() {}, broadcastPageCreated() {} } } as any,
  });
};
const json = (init?: RequestInit & { body?: any }) =>
  ({
    ...init,
    headers: { 'Content-Type': 'application/json' },
    body: typeof init?.body === 'string' ? init.body : JSON.stringify(init?.body ?? {}),
  }) as RequestInit;

beforeAll(async () => {
  process.env.LIBREDECK_DATA_DIR = TMP;
  await initDatabase();
  db = new DatabaseService();
  profId = db.createProfile({ id: 'pg-prof', name: 'Principal', data: {} }).id;
});

describe('POST /pages guarda el tamaño propio', () => {
  it('acepta grid_cols/grid_rows y los devuelve', async () => {
    const res = await call('/api/v1/pages', json({
      method: 'POST',
      body: { profile_id: profId, name: 'Deck 5x3', order_idx: 0, grid_cols: 5, grid_rows: 3 },
    }));
    expect(res!.status).toBe(201);
    const created = await res!.json();
    expect(created.grid_cols).toBe(5);
    expect(created.grid_rows).toBe(3);
    const row = db.getPage(created.id)!;
    expect(row.grid_cols).toBe(5);
    expect(row.grid_rows).toBe(3);
  });

  it('sin grid queda en NULL (hereda del perfil)', async () => {
    const res = await call('/api/v1/pages', json({
      method: 'POST',
      body: { profile_id: profId, name: 'Heredada', order_idx: 1 },
    }));
    const created = await res!.json();
    expect(created.grid_cols).toBeNull();
    expect(created.grid_rows).toBeNull();
  });
});

describe('PUT /pages/:id cambia solo esa página', () => {
  it('resize en una página no toca a las demás', async () => {
    const a = await (await call('/api/v1/pages', json({
      method: 'POST',
      body: { profile_id: profId, name: 'A 5x3', order_idx: 2, grid_cols: 5, grid_rows: 3 },
    })))!.json();
    const b = await (await call('/api/v1/pages', json({
      method: 'POST',
      body: { profile_id: profId, name: 'B 3x2', order_idx: 3, grid_cols: 3, grid_rows: 2 },
    })))!.json();

    const upd = await (await call(`/api/v1/pages/${b.id}`, json({
      method: 'PUT', body: { grid_cols: 4, grid_rows: 2 },
    })))!.json();
    expect(upd.grid_cols).toBe(4);
    expect(upd.grid_rows).toBe(2);

    expect(db.getPage(a.id)!.grid_cols).toBe(5);
    expect(db.getPage(b.id)!.grid_cols).toBe(4);
  });
});

describe('ensureDefaultProfile repara pantallas semilla en NULL', () => {
  it('rellena NULL con el diseño y respeta tamaños explícitos', async () => {
    const ids = ensureDefaultProfile(db)!;
    // Simula la corrupción: tamaños a NULL + un tamaño explícito de usuario.
    db.updatePage(ids.deckPageId, { grid_cols: null, grid_rows: null });
    db.updatePage(ids.miniPageId, { grid_cols: null, grid_rows: null });
    db.updatePage(ids.xlPageId, { grid_cols: 8, grid_rows: 4 });

    ensureDefaultProfile(db);

    expect(db.getPage(ids.deckPageId)!.grid_cols).toBe(5);
    expect(db.getPage(ids.deckPageId)!.grid_rows).toBe(3);
    expect(db.getPage(ids.miniPageId)!.grid_cols).toBe(3);
    expect(db.getPage(ids.miniPageId)!.grid_rows).toBe(2);
    // Explícito intacto.
    expect(db.getPage(ids.xlPageId)!.grid_cols).toBe(8);
    expect(db.getPage(ids.xlPageId)!.grid_rows).toBe(4);
  });
});
