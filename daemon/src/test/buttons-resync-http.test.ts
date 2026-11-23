/**
 * buttons-resync-http.test.ts — el POST /api/v1/buttons responde SIN
 * reescanear la BD de forma síncrona.
 *
 * Regresión: cada escritura de botón llamaba a `resyncButtonAutomations`
 * (barrido completo perfiles→páginas→botones) dentro del handler, retrasando
 * la respuesta — en modo libre "Añadir tecla" y soltar acciones se quedaban
 * pillados y a veces el navegador abortaba (failed to fetch). Ahora el
 * handler usa `scheduleResyncButtonAutomations` (diferido y coalescado).
 *
 * Hermético en aislado (DB real) y en suite completa (mock global de
 * action-runner.test.ts): siembra sus propios perfil/página.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ld-btnhttp-test-'));
process.env.LIBREDECK_DATA_DIR = TMP;
fs.mkdirSync(path.join(TMP, 'plugins'), { recursive: true });

import { initDatabase, DatabaseService } from '../db';
import { PluginLoader } from '../plugin-loader';
import { ActionRunner } from '../action-runner';
import { setupAPIRoutes } from '../api/routes';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let loader: PluginLoader;
let runner: ActionRunner;
let pageId: string;

const noopWs = {
  broadcast: () => {},
  broadcastButtonsReordered: () => {},
  broadcastButtonUpdate: () => {},
  broadcastButtonDeleted: () => {},
};

function req(method: string, url: string, body?: unknown): Request {
  return new Request(`http://localhost${url}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeAll(async () => {
  process.env.LIBREDECK_DATA_DIR = TMP;
  await initDatabase();
  const suffix = Math.random().toString(36).slice(2, 8);
  const db = new DatabaseService();
  const profileId = `prof-${suffix}`;
  pageId = `page-${suffix}`;
  db.createProfile({ id: profileId, name: 'P', data: {} });
  db.createPage({ id: pageId, profile_id: profileId, name: 'Pg', order_idx: 0, is_folder: 0, data: {} } as any);

  loader = new PluginLoader();
  const anyLoader = loader as any;
  try { await anyLoader.watcher?.close(); } catch {}
  anyLoader.watcher = undefined;
  runner = new ActionRunner({} as any);
});

afterAll(() => {
  try { runner.dispose(); } catch {}
  try { (loader as any).dispose?.(); } catch {}
});

describe('POST /api/v1/buttons difiere el resync', () => {
  it('responde 201 sin reescanear en el acto; el resync llega después y una sola vez', async () => {
    let syncCalls = 0;
    let scheduledCalls = 0;
    const origSync = runner.resyncButtonAutomations.bind(runner);
    const origSchedule = runner.scheduleResyncButtonAutomations.bind(runner);
    (runner as any).resyncButtonAutomations = () => { syncCalls++; return origSync(); };
    (runner as any).scheduleResyncButtonAutomations = (...a: any[]) => { scheduledCalls++; return (origSchedule as any)(...a); };
    try {
      const services: any = { wsManager: noopWs, pluginLoader: loader, actionRunner: runner, windowWatcher: {} };
      // Ráfaga como la de arrastrar/crear varias teclas seguidas.
      for (let i = 0; i < 3; i++) {
        const res = await setupAPIRoutes(
          req('POST', '/api/v1/buttons', { page_id: pageId, position: 100 + i, data: {} }),
          services,
        );
        expect(res.status).toBe(201);
      }
      // Al responder aún no hubo ningún reescaneo síncrono...
      expect(syncCalls).toBe(0);
      // ...pero sí se programó el diferido (coalescado: puede ser < 3).
      expect(scheduledCalls).toBeGreaterThanOrEqual(1);
      expect(scheduledCalls).toBeLessThanOrEqual(3);
      // Y tras el delay el reescaneo ocurre exactamente una vez.
      await sleep(600);
      expect(syncCalls).toBe(1);
    } finally {
      (runner as any).resyncButtonAutomations = origSync;
      (runner as any).scheduleResyncButtonAutomations = origSchedule;
    }
  });
});
