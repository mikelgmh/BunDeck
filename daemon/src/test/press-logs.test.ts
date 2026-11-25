/**
 * press-logs.test.ts — persistencia de `button_press_logs` (migración 10).
 *
 * Cubre: tabla + índices + seeds, add/list con filtros, paginación
 * (total/limit/offset), clear por filtros y prune keepMax/keepDays.
 *
 * Patrón: tmpdir + BUNDECK_DATA_DIR=TMP antes de importar db.
 */
import { describe, it, expect, beforeAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ld-press-logs-test-'));
process.env.BUNDECK_DATA_DIR = TMP;

import { initDatabase, getDatabase, DatabaseService } from '../db';

let db: DatabaseService;

/**
 * Los mock.module de Bun son globales al proceso: en suite completa este
 * fichero recibe el mock in-memory de action-runner.test.ts en vez de
 * SQLite. Las aserciones SQL crudas (migración, INTEGER, prune real) solo
 * corren con DB real (aislado); el resto vale en ambos modos.
 * La detección es perezosa (en beforeAll ya corrió initDatabase).
 */
function isRealDb(): boolean {
  try {
    const t = getDatabase()
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='button_press_logs'")
      .get() as { name?: string } | undefined;
    return t?.name === 'button_press_logs';
  } catch {
    return false;
  }
}

beforeAll(async () => {
  process.env.BUNDECK_DATA_DIR = TMP;
  await initDatabase();
  db = new DatabaseService();
});

function seedRow(over: Record<string, any> = {}) {
  db.addPressLog({
    buttonId: 'b1',
    actionType: 'shell.shell',
    ...over,
  });
}

describe('button_press_logs: migración 10', () => {
  it('tabla, índices y seeds existen', () => {
    if (!isRealDb()) return;
    const raw = getDatabase();
    const table = raw.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='button_press_logs'"
    ).get() as { name: string } | undefined;
    expect(table?.name).toBe('button_press_logs');
    const idx = raw.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_bpl_%'"
    ).all() as Array<{ name: string }>;
    const names = idx.map((r) => r.name).sort();
    expect(names).toEqual([
      'idx_bpl_action_ts',
      'idx_bpl_button_ts',
      'idx_bpl_device_ts',
      'idx_bpl_run',
      'idx_bpl_ts',
    ]);
    expect(db.getSetting('logs.press_enabled')).toBe('true');
    expect(db.getSetting('logs.press_keep_max')).toBe('10000');
    expect(db.getSetting('logs.press_keep_days')).toBe('30');
  });
});

describe('button_press_logs: add/list con filtros', () => {
  it('filtra por buttonId/actionType/deviceId/success/pressType/since/until', () => {
    db.clearPressLogs();
    const t0 = Date.now();
    seedRow({ buttonId: 'b1', actionType: 'shell.shell', deviceId: 'd1', success: true, pressType: 'short', ts: t0 });
    seedRow({ buttonId: 'b1', actionType: 'http.request', deviceId: 'd1', success: false, error: 'boom', pressType: 'long', ts: t0 + 10 });
    seedRow({ buttonId: 'b2', actionType: 'shell.shell', deviceId: 'd2', success: true, pressType: 'short', ts: t0 + 20 });

    expect(db.listPressLogs({ buttonId: 'b1' }).total).toBe(2);
    expect(db.listPressLogs({ actionType: 'shell.shell' }).total).toBe(2);
    expect(db.listPressLogs({ deviceId: 'd2' }).items[0].buttonId).toBe('b2');
    expect(db.listPressLogs({ success: false }).items).toHaveLength(1);
    expect(db.listPressLogs({ success: false }).items[0].error).toBe('boom');
    expect(db.listPressLogs({ success: true }).total).toBe(2);
    expect(db.listPressLogs({ pressType: 'long' }).items[0].actionType).toBe('http.request');
    expect(db.listPressLogs({ since: t0 + 10 }).total).toBe(2);
    expect(db.listPressLogs({ until: t0 + 10 }).total).toBe(2);
    expect(db.listPressLogs({ buttonId: 'b1', actionType: 'http.request', success: false }).total).toBe(1);

    // success persiste como INTEGER y se lee como boolean (solo DB real)
    if (isRealDb()) {
      const raw = getDatabase().prepare('SELECT success FROM button_press_logs WHERE error = ?').get('boom') as { success: number };
      expect(raw.success).toBe(0);
    }
  });

  it('pagina con total/limit/offset y orden ts DESC', () => {
    db.clearPressLogs();
    for (let i = 0; i < 5; i++) seedRow({ buttonId: 'bp', ts: 1000 + i });
    const p1 = db.listPressLogs({ buttonId: 'bp', limit: 2, offset: 0 });
    expect(p1.total).toBe(5);
    expect(p1.items).toHaveLength(2);
    expect(p1.items[0].ts).toBe(1004); // más reciente primero
    const p2 = db.listPressLogs({ buttonId: 'bp', limit: 2, offset: 2 });
    expect(p2.total).toBe(5);
    expect(p2.items.map((r) => r.ts)).toEqual([1002, 1001]);
    const p3 = db.listPressLogs({ buttonId: 'bp', limit: 2, offset: 4 });
    expect(p3.items).toHaveLength(1);
  });
});

describe('button_press_logs: clear y prune', () => {
  it('clear por buttonId/actionType/before', () => {
    db.clearPressLogs();
    seedRow({ buttonId: 'c1', actionType: 'a.x', ts: 100 });
    seedRow({ buttonId: 'c1', actionType: 'a.y', ts: 200 });
    seedRow({ buttonId: 'c2', actionType: 'a.x', ts: 300 });

    expect(db.clearPressLogs({ buttonId: 'c1', actionType: 'a.x' })).toBe(1);
    expect(db.listPressLogs({}).total).toBe(2);
    expect(db.clearPressLogs({ before: 250 })).toBe(1); // ts=200
    expect(db.listPressLogs({}).total).toBe(1);
    expect(db.clearPressLogs({ buttonId: 'c2' })).toBe(1);
    expect(db.listPressLogs({}).total).toBe(0);
  });

  it('prune respeta keepMax (conserva los más recientes)', () => {
    if (!isRealDb()) return;
    db.clearPressLogs();
    for (let i = 0; i < 10; i++) seedRow({ buttonId: 'k', ts: 1000 + i });
    const deleted = db.prunePressLogs(3, 0);
    expect(deleted).toBe(7);
    const rest = db.listPressLogs({ buttonId: 'k', limit: 10 });
    expect(rest.total).toBe(3);
    expect(rest.items.map((r) => r.ts)).toEqual([1009, 1008, 1007]);
  });

  it('prune respeta keepDays (borra antiguos)', () => {
    if (!isRealDb()) return;
    db.clearPressLogs();
    const now = Date.now();
    const old = now - 40 * 86400000;
    seedRow({ buttonId: 'old', ts: old });
    seedRow({ buttonId: 'new', ts: now });
    const deleted = db.prunePressLogs(10000, 30);
    expect(deleted).toBe(1);
    expect(db.listPressLogs({}).items[0].buttonId).toBe('new');
  });
});
