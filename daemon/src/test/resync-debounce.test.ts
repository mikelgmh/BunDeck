/**
 * resync-debounce.test.ts — el camino caliente de botones (POST/PUT/DELETE/
 * reorder) NO debe reescanear la BD de forma síncrona en cada escritura.
 *
 * `scheduleResyncButtonAutomations` coalesca una ráfaga de N ediciones
 * (arrastrar acción al grid, mover/resize en libre, swaps rápidos) en un
 * solo reescaneo diferido, así la respuesta HTTP vuelve al instante.
 * `resyncButtonAutomations` síncrono se conserva para arranque y resync
 * explícito.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ld-resync-test-'));
process.env.LIBREDECK_DATA_DIR = TMP;
fs.mkdirSync(path.join(TMP, 'plugins'), { recursive: true });

import { initDatabase, DatabaseService } from '../db';
import { ActionRunner } from '../action-runner';

let runner: ActionRunner;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

beforeAll(async () => {
  process.env.LIBREDECK_DATA_DIR = TMP;
  await initDatabase();
  runner = new ActionRunner({} as any);

  // Datos para que el reescaneo tenga algo que recorrer (2 perfiles ×
  // 2 páginas × 3 botones, uno con regla timer). Sufijo único: en suite
  // completa los stores del mock de action-runner.test.ts son compartidos.
  const suffix = Math.random().toString(36).slice(2, 8);
  const db = new DatabaseService();
  for (const p of [`p1-${suffix}`, `p2-${suffix}`]) {
    db.createProfile({ id: p, name: `P ${p}`, data: {} });
    for (const g of ['a', 'b']) {
      const pageId = `${p}-${g}`;
      db.createPage({ id: pageId, profile_id: p, name: `Pg ${pageId}`, order_idx: 0, is_folder: 0, data: {} } as any);
      for (let i = 0; i < 3; i++) {
        const data = i === 0
          ? { rules: [{ when: 'timer', every: 60, then: [{ type: 'local.toast', parameters: { text: 't' } }] }] }
          : {};
        db.createButton({ id: `${pageId}-btn${i}`, page_id: pageId, position: i, data } as any);
      }
    }
  }
});

afterAll(() => {
  try { runner.dispose(); } catch {}
});

describe('scheduleResyncButtonAutomations', () => {
  it('coalesca N llamadas rápidas en un solo resync diferido', async () => {
    let calls = 0;
    const orig = runner.resyncButtonAutomations.bind(runner);
    (runner as any).resyncButtonAutomations = () => { calls++; return orig(); };
    try {
      for (let i = 0; i < 5; i++) runner.scheduleResyncButtonAutomations(50);
      // Diferido: vuelve al instante, sin reescanear en el acto.
      expect(calls).toBe(0);
      await sleep(300);
      expect(calls).toBe(1);

      // Una segunda oleada tras el flush programa exactamente otra.
      runner.scheduleResyncButtonAutomations(50);
      runner.scheduleResyncButtonAutomations(50);
      await sleep(300);
      expect(calls).toBe(2);
    } finally {
      (runner as any).resyncButtonAutomations = orig;
    }
  });

  it('resync síncrono sigue disponible (arranque / resync explícito)', () => {
    expect(() => runner.resyncButtonAutomations()).not.toThrow();
  });
});
