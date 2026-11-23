/**
 * devices.test.ts — Dispositivos lógicos + asignaciones por perfil.
 *
 * - Regla pura checkPageCompatibility (deck = cuadrícula + tamaño exacto).
 * - guessDeckModel / resolvePageSize / fixAssignments (puros).
 * - CRUD /api/v1/devices + validación 422 de assignments + reparación.
 * - Guarda HW: navigatePageTo no repinta páginas incompatibles.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ld-devices-test-'));
process.env.LIBREDECK_DATA_DIR = TMP;
fs.mkdirSync(path.join(TMP, 'plugins'), { recursive: true });

import { initDatabase, DatabaseService } from '../db';
import {
  checkPageCompatibility,
  guessDeckModel,
  resolvePageSize,
  parseLayoutMode,
  fixAssignments,
  DECK_MODELS,
  type LogicalDevice,
  type PageView,
} from '../devices';
import { handleDevices } from '../api/devices';
import { buildBackup, validateBackup } from '../backup';
import { WebSocketManager } from '../ws';
import { streamDeckDriver } from '../hw-driver/streamdeck-driver';

let db: DatabaseService;
let uidCounter = 0;
function uid(prefix: string): string {
  uidCounter += 1;
  return `${prefix}-${uidCounter}-${Math.random().toString(36).slice(2, 8)}`;
}

const deck = (patch?: Partial<LogicalDevice>): LogicalDevice => ({
  id: uid('dev'), name: 'Deck', kind: 'deck', model: 'mk2', cols: 5, rows: 3,
  hw_path: null, created_at: 0, updated_at: 0, ...patch,
});
const phone = (patch?: Partial<LogicalDevice>): LogicalDevice => ({
  id: uid('dev'), name: 'Móvil', kind: 'phone', model: null, cols: null, rows: null,
  hw_path: null, created_at: 0, updated_at: 0, ...patch,
});
const gridPage = (patch?: Partial<PageView>): PageView => ({
  id: uid('pg'), profile_id: 'prof', name: 'Inicio', is_folder: 0,
  parent_id: null, grid_cols: 5, grid_rows: 3, data: {}, ...patch,
});

describe('compatibilidad página ↔ dispositivo (pura)', () => {
  it('deck acepta cuadrícula con su tamaño exacto', () => {
    expect(checkPageCompatibility(gridPage(), deck()).ok).toBe(true);
  });
  it('deck rechaza modo libre', () => {
    const r = checkPageCompatibility(gridPage({ data: { layoutMode: 'gridstack' } }), deck());
    expect(r.ok).toBe(false);
    expect(r.short).toBe('modo libre');
  });
  it('deck rechaza otro tamaño', () => {
    const r = checkPageCompatibility(gridPage({ grid_cols: 8, grid_rows: 4 }), deck());
    expect(r.ok).toBe(false);
    expect(r.short).toBe('tamaño 8×4');
  });
  it('móvil y tablet aceptan todo', () => {
    const free = gridPage({ data: { layoutMode: 'gridstack' }, grid_cols: 8, grid_rows: 4 });
    expect(checkPageCompatibility(free, phone()).ok).toBe(true);
    expect(checkPageCompatibility(free, { ...phone(), kind: 'tablet' }).ok).toBe(true);
  });
  it('hwGrid manda sobre el modelo configurado', () => {
    const page = gridPage({ grid_cols: 3, grid_rows: 2 });
    expect(checkPageCompatibility(page, deck(), undefined, { cols: 3, rows: 2 }).ok).toBe(true);
    expect(checkPageCompatibility(page, deck(), undefined, { cols: 5, rows: 3 }).ok).toBe(false);
  });
  it('parseLayoutMode solo gridstack es libre', () => {
    expect(parseLayoutMode({ layoutMode: 'gridstack' })).toBe('gridstack');
    expect(parseLayoutMode({})).toBe('classic');
    expect(parseLayoutMode(JSON.stringify({ layoutMode: 'gridstack' }))).toBe('gridstack');
    expect(parseLayoutMode(null)).toBe('classic');
  });
  it('resolvePageSize hereda del perfil y cae a 5×3', () => {
    expect(resolvePageSize({ grid_cols: 8, grid_rows: 4 }, {})).toEqual({ cols: 8, rows: 4 });
    expect(resolvePageSize({}, { gridCols: 8, gridRows: 4 })).toEqual({ cols: 8, rows: 4 });
    expect(resolvePageSize({}, {})).toEqual({ cols: 5, rows: 3 });
  });
  it('guessDeckModel mapea geometrías DPRE', () => {
    expect(guessDeckModel({ cols: 5, rows: 3 })).toBe('mk2');
    expect(guessDeckModel({ cols: 8, rows: 4 })).toBe('xl');
    expect(guessDeckModel({ cols: 3, rows: 2 })).toBe('mini');
    expect(guessDeckModel({ cols: 9, rows: 9 })).toBeNull();
    expect(guessDeckModel(null)).toBeNull();
  });
  it('DECK_MODELS cubre los 4 tamaños del prototipo', () => {
    expect(DECK_MODELS.map((m) => m.id).sort()).toEqual(['mini', 'mk2', 'neo', 'xl']);
  });
});

describe('fixAssignments (puro)', () => {
  const pages: PageView[] = [
    { id: 'g1', profile_id: 'p', name: 'Inicio', is_folder: 0, parent_id: null, grid_cols: 5, grid_rows: 3, data: {} },
    { id: 'g2', profile_id: 'p', name: 'Libre', is_folder: 0, parent_id: null, grid_cols: 8, grid_rows: 4, data: { layoutMode: 'gridstack' } },
    { id: 'f1', profile_id: 'p', name: 'Carpeta', is_folder: 1, parent_id: null, grid_cols: 5, grid_rows: 3, data: {} },
  ];
  const devices: LogicalDevice[] = [
    { id: 'd-deck', name: 'Deck', kind: 'deck', model: 'mk2', cols: 5, rows: 3, hw_path: null, created_at: 0, updated_at: 0 },
    { id: 'd-mob', name: 'Móvil', kind: 'phone', model: null, cols: null, rows: null, hw_path: null, created_at: 0, updated_at: 0 },
  ];

  it('auto-asigna la primera raíz compatible', () => {
    const fixed = fixAssignments({ pages, devices, assignments: {} });
    expect(fixed.assignments['d-deck']).toBe('g1');
    expect(fixed.assignments['d-mob']).toBe('g1');
    expect(fixed.unassigned).toEqual([]);
  });
  it('desasigna la libre del deck y propone raíz', () => {
    const fixed = fixAssignments({ pages, devices, assignments: { 'd-deck': 'g2' } });
    expect(fixed.assignments['d-deck']).toBe('g1');
    expect(fixed.dropped).toHaveLength(1);
    expect(fixed.dropped[0].reason).toMatch(/modo libre/);
  });
  it('sin raíz compatible el deck queda sin pantalla', () => {
    const onlyFree = pages.filter((p) => p.id === 'g2');
    const fixed = fixAssignments({ pages: onlyFree, devices, assignments: {} });
    expect(fixed.assignments['d-deck']).toBeUndefined();
    expect(fixed.unassigned.map((u) => u.deviceId)).toContain('d-deck');
    // El móvil sí acepta la libre.
    expect(fixed.assignments['d-mob']).toBe('g2');
  });
  it('ignora dispositivos/páginas inexistentes', () => {
    const fixed = fixAssignments({
      pages, devices,
      assignments: { 'd-deck': 'nope', fantasma: 'g1' },
    });
    expect(fixed.assignments['d-deck']).toBe('g1');
    expect(fixed.assignments['fantasma']).toBeUndefined();
  });
});

describe('API devices + assignments', () => {
  let profId = '';
  let gridId = '';
  let freeId = '';

  const call = (p: string, init?: RequestInit) => {
    const req = new Request(`http://localhost:3001${p}`, init);
    const url = new URL(req.url);
    return handleDevices(req, {
      url, method: req.method, path: p, db,
      services: { wsManager: { broadcast() {} } } as any,
    });
  };
  const json = (init?: RequestInit & { body?: any }) =>
    ({
      ...init,
      headers: { 'Content-Type': 'application/json' },
      body: typeof init?.body === 'string' ? init.body : JSON.stringify(init?.body ?? {}),
    }) as RequestInit;

  beforeAll(async () => {
    await initDatabase();
    db = new DatabaseService();
    const prof = db.createProfile({ id: uid('prof'), name: 'Principal', data: {} });
    profId = prof.id;
    const mk = (name: string, data: any) => {
      const id = uid('page');
      db.createPage({ id, profile_id: profId, name, order_idx: 0, is_folder: 0, data });
      return id;
    };
    gridId = mk('Inicio', {});
    freeId = mk('Libre', { layoutMode: 'gridstack' });
  });

  afterAll(() => {
    try { (streamDeckDriver as any).streamDeck = null; } catch { /* noop */ }
  });

  it('CRUD de dispositivos con modelo por defecto MK.2', async () => {
    const created = await (await call('/api/v1/devices', json({ method: 'POST', body: { name: 'Mi Deck', kind: 'deck' } })))!.json();
    expect(created.kind).toBe('deck');
    expect(created.model).toBe('mk2');
    expect(created.cols).toBe(5);
    expect(created.rows).toBe(3);

    const listed = await (await call('/api/v1/devices'))!.json();
    expect(listed.some((d: any) => d.id === created.id)).toBe(true);

    const bad = await call('/api/v1/devices', json({ method: 'POST', body: { name: 'X', kind: 'reloj' } }));
    expect(bad!.status).toBe(400);

    const renamed = await (await call(`/api/v1/devices/${created.id}`, json({ method: 'PUT', body: { name: 'Deck salón' } })))!.json();
    expect(renamed.device.name).toBe('Deck salón');

    const del = await (await call(`/api/v1/devices/${created.id}`, { method: 'DELETE' }))!.json();
    expect(del.success).toBe(true);
    expect(del.snapshot.device.id).toBe(created.id);
  });

  it('PUT assignments rechaza la libre para un deck (422)', async () => {
    const d = await (await call('/api/v1/devices', json({ method: 'POST', body: { name: 'Deck', kind: 'deck' } })))!.json();
    const res = await call(`/api/v1/profiles/${profId}/assignments`, json({
      method: 'PUT',
      body: { assignments: { [d.id]: freeId } },
    }));
    expect(res!.status).toBe(422);
    const body = await res!.json();
    expect(body.details[0].reason).toMatch(/modo libre/);
    // Nada se guardó.
    expect(db.getAssignments(profId)[d.id]).toBeUndefined();
  });

  it('PUT assignments acepta cuadrícula y GET repara', async () => {
    const d = await (await call('/api/v1/devices', json({ method: 'POST', body: { name: 'Deck2', kind: 'deck' } })))!.json();
    const m = await (await call('/api/v1/devices', json({ method: 'POST', body: { name: 'Móvil', kind: 'phone' } })))!.json();
    const res = await call(`/api/v1/profiles/${profId}/assignments`, json({
      method: 'PUT',
      body: { assignments: { [d.id]: gridId, [m.id]: freeId } },
    }));
    expect(res!.status).toBe(200);
    const body = await res!.json();
    expect(body.assignments[d.id]).toBe(gridId);
    expect(body.assignments[m.id]).toBe(freeId);

    // Si el móvil pasa a deck 5×3, la libre se repara sola a la raíz grid.
    await call(`/api/v1/devices/${m.id}`, json({ method: 'PUT', body: { kind: 'deck', model: 'mk2', cols: 5, rows: 3 } }));
    const after = db.getAssignments(profId);
    expect(after[m.id]).toBe(gridId);
  });

  it('eliminar una página limpia sus asignaciones', async () => {
    const d = await (await call('/api/v1/devices', json({ method: 'POST', body: { name: 'Tmp', kind: 'phone' } })))!.json();
    db.setAssignment(profId, d.id, freeId);
    db.deletePage(freeId);
    // repair: el móvil sin pantalla recibe la raíz compatible restante.
    const fixed = db.repairAssignments(profId);
    expect(fixed.assignments[d.id]).toBe(gridId);
    // Restaurar la página libre para otros tests.
    const id = uid('page');
    db.createPage({ id, profile_id: profId, name: 'Libre', order_idx: 1, is_folder: 0, data: { layoutMode: 'gridstack' } });
    freeId = id;
  });

  it('backup incluye dispositivos y asignaciones y valida', async () => {
    const before = buildBackup(db);
    expect(before.data.devices.length).toBeGreaterThanOrEqual(1);
    expect(validateBackup(before).valid).toBe(true);
    const v = validateBackup({
      ...before,
      data: {
        ...before.data,
        devices: [...before.data.devices, { id: 'x', name: 'Sin kind' }],
      },
    });
    expect(v.valid).toBe(false);
  });
});

describe('guarda HW en navegación', () => {
  let mgr: WebSocketManager;
  let profId = '';
  let gridId = '';
  let freeId = '';

  beforeAll(async () => {
    db = new DatabaseService();
    const prof = db.createProfile({ id: uid('prof'), name: 'HW', data: {} });
    profId = prof.id;
    gridId = uid('page');
    freeId = uid('page');
    db.createPage({ id: gridId, profile_id: profId, name: 'G', order_idx: 0, is_folder: 0, data: {} });
    db.createPage({ id: freeId, profile_id: profId, name: 'F', order_idx: 1, is_folder: 0, data: { layoutMode: 'gridstack' } });
    mgr = Object.create(WebSocketManager.prototype) as WebSocketManager;
    (mgr as any).clients = new Map();
    (mgr as any).db = new DatabaseService();
    (mgr as any).server = null;
  });

  const fakeGrid = (cols: number, rows: number) => {
    const ctrls: any[] = [];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) ctrls.push({ type: 'button', column: c, row: r });
    (streamDeckDriver as any).streamDeck = { CONTROLS: ctrls };
  };

  it('sin HW conectado no se bloquea nada', () => {
    (streamDeckDriver as any).streamDeck = null;
    const res = (mgr as any).navigatePageTo({ pageId: freeId, targets: { kind: 'devices', ids: ['streamdeck-local'] } });
    expect(res.ok).toBe(true);
  });

  it('página libre dirigida al HW: sesión sí, repintado no', () => {
    fakeGrid(5, 3);
    try {
      const seen: any[] = [];
      (mgr as any).broadcast = (t: string, p: any) => seen.push({ t, p });
      const res = (mgr as any).navigatePageTo({ pageId: freeId, targets: { kind: 'devices', ids: ['streamdeck-local'] } });
      expect(res.ok).toBe(true);
      expect(seen.some((m) => m.t === 'page.blocked' && m.p.pageId === freeId)).toBe(true);
    } finally {
      (streamDeckDriver as any).streamDeck = null;
    }
  });

  it('setSessionView del HW rechaza la libre', () => {
    fakeGrid(5, 3);
    try {
      const res = (mgr as any).setSessionView('streamdeck-local', { pageId: freeId }, { notify: false });
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/modo libre/);
      const okRes = (mgr as any).setSessionView('streamdeck-local', { pageId: gridId }, { notify: false });
      expect(okRes.ok).toBe(true);
    } finally {
      (streamDeckDriver as any).streamDeck = null;
    }
  });
});
