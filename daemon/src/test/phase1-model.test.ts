/**
 * phase1-model.test.ts — Fase 1: carpetas anidadas, widgets redimensionables,
 * triggers/flows y sesiones por cliente.
 *
 * 1. Migración desde una DB antigua (schema pre-Fase-1, sin parent_id ni
 *    columnas widget ni tablas triggers/client_sessions): los datos se
 *    conservan y un botón legacy se lee como widget `action_button`.
 * 2. CRUD nuevo: carpetas anidadas (parent_id + árbol), widgets con
 *    geometría, triggers de flows, ejecuciones y sesiones por cliente.
 * 3. Rollback: operaciones atómicas fallidas no dejan restos a medias.
 * 4. Compat API v1: createButton/getButtonsByPage/reorderButtons intactos.
 *
 * NOTA de suite: los mock.module de Bun son globales al proceso
 * (action-runner.test.ts sustituye '../db' en la run completa). Fuera de
 * la suite (fichero aislado) se usa la DB real; en suite se usa el mock
 * compartido. UNDER_MOCK distingue ambos: la migración física solo corre
 * con la DB real; con el mock se siembra el estado legacy equivalente por
 * API pública y se verifica el mismo contrato de compatibilidad.
 */
import { describe, it, expect, beforeAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ld-phase1-test-'));
process.env.LIBREDECK_DATA_DIR = TMP;

import { Database } from 'bun:sqlite';
import { initDatabase, DatabaseService, LEGACY_GRID_COLS } from '../db';

const UNDER_MOCK = DatabaseService.name !== 'DatabaseService';

let db: DatabaseService;

beforeAll(async () => {
  // Re-afirma el data dir: otros ficheros de test usan el mismo patrón y
  // el orden de importación no debe desviarnos a su TMP.
  process.env.LIBREDECK_DATA_DIR = TMP;
  await initDatabase();
  db = new DatabaseService();
}, 120_000);

function tableCols(svc: DatabaseService, table: string): string[] {
  const raw = (svc as any).db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return raw.map((c) => c.name);
}

/** Estado legacy equivalente al de la DB antigua (reutilizado en ambos caminos). */
function seedLegacyState(svc: DatabaseService) {
  svc.createProfile({ id: 'p1-mprof', name: 'Principal', data: {} });
  svc.createPage({ id: 'p1-mpage', profile_id: 'p1-mprof', name: 'Raíz', order_idx: 0, is_folder: 0, data: {} });
  svc.createPage({ id: 'p1-mfold', profile_id: 'p1-mprof', name: 'Carpeta', order_idx: 1, is_folder: 1, data: {} });
  svc.createButton({ id: 'p1-mbtn', page_id: 'p1-mpage', position: 9, data: { label: 'Heredado', actions: [{ type: 'shell.run' }] } } as any);
}

function expectLegacyCompat(svc: DatabaseService) {
  // Datos preservados
  expect(svc.getProfile('p1-mprof')?.name).toBe('Principal');
  expect(svc.getPage('p1-mpage')?.name).toBe('Raíz');
  expect(svc.getPage('p1-mfold')?.is_folder).toBe(1);
  const legacy = svc.getButton('p1-mbtn');
  expect(legacy).not.toBeNull();
  expect((legacy!.data as any).label).toBe('Heredado');

  // Botón legacy → widget action_button con geometría derivada de position
  const widgets = svc.getButtonWidgetsByPage('p1-mpage');
  expect(widgets).toHaveLength(1);
  expect(widgets[0].kind).toBe('action_button');
  expect(widgets[0].x).toBe(9 % LEGACY_GRID_COLS);
  expect(widgets[0].y).toBe(Math.floor(9 / LEGACY_GRID_COLS));
  expect(widgets[0].w).toBe(1);
  expect(widgets[0].h).toBe(1);
  expect(widgets[0].data.label).toBe('Heredado');
}

describe('Fase 1: migración desde DB antigua (pre-Fase-1)', () => {
  it('conserva perfiles/páginas/botones y expone el botón legacy como action_button', async () => {
    if (UNDER_MOCK) {
      // Suite completa: el mock global sustituye la DB; no hay migración
      // física que correr. Mismo contrato verificado sobre estado sembrado.
      seedLegacyState(db);
      expectLegacyCompat(db);
      expect(LEGACY_GRID_COLS).toBe(8);
      return;
    }
    const OLD = fs.mkdtempSync(path.join(os.tmpdir(), 'ld-phase1-old-'));
    const oldPath = path.join(OLD, 'db.sqlite');
    // Schema antiguo: sin parent_id/grid_*, sin columnas widget, sin
    // triggers/flow_runs nuevos ni client_sessions.
    const old = new Database(oldPath);
    old.exec(`
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE profiles (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, data TEXT);
      CREATE TABLE pages (id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, name TEXT NOT NULL, order_idx INTEGER DEFAULT 0, is_folder INTEGER DEFAULT 0, data TEXT,
        FOREIGN KEY(profile_id) REFERENCES profiles(id) ON DELETE CASCADE);
      CREATE TABLE buttons (id TEXT PRIMARY KEY, page_id TEXT NOT NULL, position INTEGER NOT NULL, data TEXT,
        FOREIGN KEY(page_id) REFERENCES pages(id) ON DELETE CASCADE);
      CREATE TABLE plugins (id TEXT PRIMARY KEY, name TEXT NOT NULL, version TEXT NOT NULL, manifest TEXT, enabled INTEGER DEFAULT 1, installed_at INTEGER NOT NULL);
      CREATE TABLE assets (id TEXT PRIMARY KEY, path TEXT NOT NULL, hash TEXT, size INTEGER, created_at INTEGER NOT NULL);
      CREATE TABLE logs (id INTEGER PRIMARY KEY AUTOINCREMENT, level TEXT NOT NULL, message TEXT NOT NULL, meta TEXT, ts INTEGER NOT NULL);
      CREATE TABLE flows (id TEXT PRIMARY KEY, name TEXT NOT NULL, data TEXT, created_at INTEGER NOT NULL, updated_at INTEGER);
    `);
    const now = Date.now();
    old.prepare('INSERT INTO profiles (id, name, created_at, updated_at, data) VALUES (?, ?, ?, ?, ?)').run('p1-mprof', 'Principal', now, now, '{}');
    old.prepare('INSERT INTO pages (id, profile_id, name, order_idx, is_folder, data) VALUES (?, ?, ?, ?, ?, ?)').run('p1-mpage', 'p1-mprof', 'Raíz', 0, 0, '{}');
    old.prepare('INSERT INTO pages (id, profile_id, name, order_idx, is_folder, data) VALUES (?, ?, ?, ?, ?, ?)').run('p1-mfold', 'p1-mprof', 'Carpeta', 1, 1, '{}');
    old.prepare('INSERT INTO buttons (id, page_id, position, data) VALUES (?, ?, ?, ?)').run(
      'p1-mbtn', 'p1-mpage', 9, JSON.stringify({ label: 'Heredado', actions: [{ type: 'shell.run' }] })
    );
    old.close();

    process.env.LIBREDECK_DATA_DIR = OLD;
    await initDatabase();
    const migrated = new DatabaseService();

    expectLegacyCompat(migrated);

    // Columnas y tablas nuevas existen
    expect(tableCols(migrated, 'pages')).toEqual(expect.arrayContaining(['parent_id', 'grid_cols', 'grid_rows']));
    expect(tableCols(migrated, 'buttons')).toEqual(
      expect.arrayContaining(['widget_type', 'x', 'y', 'w', 'h', 'parent_widget_id', 'created_at', 'updated_at'])
    );
    expect(tableCols(migrated, 'flow_runs')).toEqual(expect.arrayContaining(['flow_id', 'trigger_id', 'output']));
    const tables = (migrated as any).db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table'"
    ).all().map((r: any) => r.name) as string[];
    expect(tables).toEqual(expect.arrayContaining(['triggers', 'flow_runs', 'client_sessions']));

    // Vuelve a la DB del resto del fichero
    process.env.LIBREDECK_DATA_DIR = TMP;
    await initDatabase();
    db = new DatabaseService();
  }, 120_000);
});

describe('Fase 1: carpetas anidadas (perfiles → carpetas)', () => {
  it('crea jerarquía perfil → carpeta → subpágina y la devuelve como árbol', () => {
    db.createProfile({ id: 'p1-tree', name: 'Árbol', data: {} });
    db.createPage({ id: 'p1-root', profile_id: 'p1-tree', name: 'Raíz', order_idx: 0, is_folder: 0, data: {} });
    db.createPage({ id: 'p1-fold', profile_id: 'p1-tree', name: 'Carpeta', order_idx: 1, is_folder: 1, data: {} });
    db.createPage({ id: 'p1-sub', profile_id: 'p1-tree', name: 'Hija', order_idx: 0, is_folder: 0, data: {}, parent_id: 'p1-fold' });

    expect(db.getChildPages('p1-tree', null).map((p) => p.id).sort()).toEqual(['p1-fold', 'p1-root']);
    expect(db.getChildPages('p1-tree', 'p1-fold').map((p) => p.id)).toEqual(['p1-sub']);

    const tree = db.getPageTree('p1-tree');
    const folder = tree.find((p) => p.id === 'p1-fold')!;
    expect(folder.children.map((c: any) => c.id)).toEqual(['p1-sub']);
  });

  it('mueve páginas con setPageParent y rechaza ciclos / otro perfil', () => {
    db.setPageParent('p1-sub', null);
    expect(db.getPage('p1-sub')?.parent_id ?? null).toBeNull();
    db.setPageParent('p1-sub', 'p1-fold');
    expect(db.getPage('p1-sub')?.parent_id).toBe('p1-fold');

    // Ciclo: la carpeta no puede colgar de su propia hija
    expect(() => db.setPageParent('p1-fold', 'p1-sub')).toThrow(/ciclo/i);
    expect(db.getPage('p1-fold')?.parent_id ?? null).toBeNull();
    // Auto-padre
    expect(() => db.setPageParent('p1-fold', 'p1-fold')).toThrow();
    // Padre inexistente
    expect(() => db.setPageParent('p1-sub', 'p1-noexiste')).toThrow(/no encontrada/);
    // Padre de otro perfil
    db.createProfile({ id: 'p1-otro', name: 'Otro', data: {} });
    db.createPage({ id: 'p1-otra', profile_id: 'p1-otro', name: 'X', order_idx: 0, is_folder: 1, data: {} });
    expect(() => db.setPageParent('p1-sub', 'p1-otra')).toThrow(/otro perfil/);
    expect(db.getPage('p1-sub')?.parent_id).toBe('p1-fold');
  });
});

describe('Fase 1: widgets redimensionables (botones)', () => {
  it('crea widgets con geometría y los lista con su tamaño', () => {
    db.createProfile({ id: 'p1-w', name: 'Widgets', data: {} });
    db.createPage({ id: 'p1-wpg', profile_id: 'p1-w', name: 'W', order_idx: 0, is_folder: 0, data: {} });

    const big = db.createButtonWidget({
      id: 'p1-wbig', page_id: 'p1-wpg', kind: 'action_button', x: 2, y: 1, w: 3, h: 2,
      data: { label: 'Grande' },
    });
    expect(big.widget_type).toBe('action_button');
    expect(big.w).toBe(3);
    expect(big.h).toBe(2);

    const all = db.getButtonWidgetsByPage('p1-wpg');
    expect(all.find((w) => w.id === 'p1-wbig')).toMatchObject({ x: 2, y: 1, w: 3, h: 2, kind: 'action_button' });
  });

  it('el botón legacy (createButton) se lee como action_button', () => {
    db.createButton({ id: 'p1-wlegacy', page_id: 'p1-wpg', position: 5, data: { label: 'Viejo' } } as any);
    const w = db.getButtonWidgetsByPage('p1-wpg').find((x) => x.id === 'p1-wlegacy')!;
    expect(w.kind).toBe('action_button');
    expect(w.x).toBe(5 % LEGACY_GRID_COLS);
    expect(w.y).toBe(Math.floor(5 / LEGACY_GRID_COLS));
  });

  it('updateButtonWidget cambia geometría y valida rangos (rollback lógico)', () => {
    const before = db.getButton('p1-wbig')!;
    db.updateButtonWidget('p1-wbig', { w: 4, h: 1, x: 0, y: 0 });
    const after = db.getButton('p1-wbig')!;
    expect([after.w, after.h, after.x, after.y]).toEqual([4, 1, 0, 0]);

    expect(() => db.updateButtonWidget('p1-wbig', { w: 0 })).toThrow(/inválida/);
    expect(() => db.updateButtonWidget('p1-wbig', { h: 99 })).toThrow(/inválida/);
    expect(() => db.updateButtonWidget('p1-wbig', { x: -1 })).toThrow(/inválida/);
    const intact = db.getButton('p1-wbig')!;
    expect([intact.w, intact.h, intact.x, intact.y]).toEqual([4, 1, 0, 0]);
    expect(intact.updated_at).toBeGreaterThanOrEqual(before.updated_at ?? 0);
  });

  it('deleteButtonWidget devuelve true/false según exista', () => {
    expect(db.deleteButtonWidget('p1-wlegacy')).toBe(true);
    expect(db.getButton('p1-wlegacy')).toBeNull();
    expect(db.deleteButtonWidget('p1-wlegacy')).toBe(false);
  });
});

describe('Fase 1: triggers y ejecuciones de flows', () => {
  it('CRUD de triggers vinculados a un flow', () => {
    db.createFlow({ id: 'p1-flow1', name: 'Amanecer', data: { steps: [] } });
    const t = db.createTrigger({ id: 'p1-trg1', flow_id: 'p1-flow1', kind: 'schedule', config: { cron: '0 7 * * *' } });
    expect(t.kind).toBe('schedule');
    expect(t.enabled).toBe(1);
    expect(db.listTriggersByFlow('p1-flow1').map((x) => x.id)).toEqual(['p1-trg1']);

    const off = db.updateTrigger('p1-trg1', { enabled: 0 });
    expect(off.enabled).toBe(0);

    expect(() => db.createTrigger({ id: 'p1-trgx', flow_id: 'p1-flowmissing', kind: 'webhook' })).toThrow(/no encontrado/i);
    expect(db.getTrigger('p1-trgmissing')).toBeNull();
    expect(db.deleteTrigger('p1-trg1')).toBe(true);
    expect(db.listTriggersByFlow('p1-flow1')).toEqual([]);
    expect(db.deleteTrigger('p1-trg1')).toBe(false);
  });

  it('createFlowWithTriggers es atómico: fallo → rollback total', () => {
    const ok = db.createFlowWithTriggers(
      { id: 'p1-flowatomic', name: 'Atómico', data: { steps: [] } },
      [{ id: 'p1-trga1', kind: 'button_press', config: { buttonId: 'p1-wbig' } }]
    );
    expect(ok.flow.id).toBe('p1-flowatomic');
    expect(ok.triggers.map((t) => t.id)).toEqual(['p1-trga1']);

    expect(() =>
      db.createFlowWithTriggers(
        { id: 'p1-flowrollback', name: 'Rollback', data: { steps: [] } },
        [
          { id: 'p1-trgr1', kind: 'schedule', config: {} },
          { id: 'p1-trgr2', kind: '', config: {} }, // kind vacío → lanza
        ]
      )
    ).toThrow();
    // Rollback: ni el flow ni el primer trigger persisten
    expect(db.getFlow('p1-flowrollback')).toBeNull();
    expect(db.getTrigger('p1-trgr1')).toBeNull();
    expect(db.listTriggersByFlow('p1-flowrollback')).toEqual([]);
  });

  it('ejecuciones: start → finish con output', () => {
    const run = db.startFlowExecution({ id: 'p1-run1', flow_id: 'p1-flow1', label: 'manual' });
    expect(run.status).toBe('running');
    expect(run.flow_id).toBe('p1-flow1');

    const done = db.finishFlowExecution('p1-run1', 'finished', { pressed: true });
    expect(done.status).toBe('finished');
    expect(done.finished_at).not.toBeNull();
    expect(done.output).toEqual({ pressed: true });

    const listed = db.listFlowExecutions('p1-flow1');
    expect(listed.map((r) => r.id)).toContain('p1-run1');
    expect(() => db.startFlowExecution({ id: 'p1-runx', flow_id: 'p1-flowmissing' })).toThrow(/no encontrado/i);
  });
});

describe('Fase 1: sesiones por cliente', () => {
  it('registra, hace heartbeat con vista y desconecta', () => {
    const s = db.registerClientSession({ id: 'p1-sess1', client_id: 'p1-movil', user_agent: 'TestApp/1.0', ip: '127.0.0.1', meta: { caps: ['grid'] } });
    expect(s.status).toBe('active');
    expect(s.client_id).toBe('p1-movil');

    const beat = db.heartbeatClientSession('p1-sess1', { profile_id: 'p1-w', page_id: 'p1-wpg' });
    expect(beat.profile_id).toBe('p1-w');
    expect(beat.page_id).toBe('p1-wpg');
    expect(beat.status).toBe('active');

    const bye = db.disconnectClientSession('p1-sess1');
    expect(bye.status).toBe('disconnected');

    expect(db.listClientSessions().map((x) => x.id)).toContain('p1-sess1');
    expect(db.listClientSessions('active').map((x) => x.id)).not.toContain('p1-sess1');
    expect(db.listClientSessions('disconnected').map((x) => x.id)).toContain('p1-sess1');

    expect(() => db.heartbeatClientSession('p1-sessmissing')).toThrow(/no encontrada/);
    expect(db.deleteClientSession('p1-sess1')).toBe(true);
    expect(db.getClientSession('p1-sess1')).toBeNull();
  });

  it('purgeStaleClientSessions expulsa solo las antiguas', () => {
    const a = db.registerClientSession({ id: 'p1-sessa', client_id: 'p1-a' });
    const b = db.registerClientSession({ id: 'p1-sessb', client_id: 'p1-b' });
    if (!UNDER_MOCK) {
      // Envejece 'a' a mano (solo DB real expone el handle)
      (db as any).db.prepare('UPDATE client_sessions SET last_seen_at = ? WHERE id = ?').run(1, 'p1-sessa');
    } else {
      // Mock: ajusta el store in-memory vía heartbeat simulado antiguo
      const row = (db as any).getClientSession('p1-sessa');
      if (row) row.last_seen_at = 1;
    }
    const purged = db.purgeStaleClientSessions(Date.now() - 1000);
    expect(purged).toBe(1);
    expect(db.getClientSession('p1-sessa')).toBeNull();
    expect(db.getClientSession('p1-sessb')?.id).toBe('p1-sessb');
    expect(a.id).toBe('p1-sessa');
    expect(b.id).toBe('p1-sessb');
  });
});

describe('Fase 1: compatibilidad API v1 intacta', () => {
  it('CRUD legacy de botones y reorder atómico siguen funcionando', () => {
    db.createButton({ id: 'p1-v1a', page_id: 'p1-wpg', position: 10, data: { label: 'A' } } as any);
    db.createButton({ id: 'p1-v1b', page_id: 'p1-wpg', position: 11, data: { label: 'B' } } as any);
    expect(db.getButtonsByPage('p1-wpg').map((b) => b.id)).toContain('p1-v1a');

    db.updateButton('p1-v1a', { label: 'A2' });
    expect(db.getButton('p1-v1a')!.data.label).toBe('A2');

    const reordered = db.reorderButtons('p1-wpg', [
      { id: 'p1-v1a', position: 11 },
      { id: 'p1-v1b', position: 10 },
    ]);
    expect(reordered.find((b) => b.id === 'p1-v1a')!.position).toBe(11);
    expect(reordered.find((b) => b.id === 'p1-v1b')!.position).toBe(10);

    db.deleteButton('p1-v1a');
    db.deleteButton('p1-v1b');
    expect(db.getButton('p1-v1a')).toBeNull();
  });

  it('transaction() hace rollback ante un fallo a mitad del batch', () => {
    if (UNDER_MOCK) {
      // El mock ejecuta fn() sin transacción real: se verifica el throw,
      // el rollback transaccional se verifica con la DB real (aislado).
      expect(() =>
        db.transaction(() => {
          throw new Error('fallo simulado');
        })
      ).toThrow(/fallo simulado/);
      return;
    }
    expect(() =>
      db.transaction(() => {
        db.createPage({ id: 'p1-tx', profile_id: 'p1-w', name: 'Tx', order_idx: 9, is_folder: 0, data: {} });
        throw new Error('fallo simulado');
      })
    ).toThrow(/fallo simulado/);
    expect(db.getPage('p1-tx')).toBeNull();
  });
});
