/**
 * free-mode-buttons.test.ts — modo libre: CRUD de widgets por HTTP.
 *
 * Regresiones del modo libre:
 *  1. PUT de geometría a un id desconocido (p. ej. nodos fantasma de
 *     GridStack con sufijo `_1` tras duplicados/optimistas, o ecos tardíos
 *     tras borrar) devolvía 500 `Internal server error` y rompía el flujo
 *     de edición. Ahora devuelve 404 con el motivo.
 *  2. Crear widget libre (POST con x/y/w/h) + redimensionar/mover (PUT) +
 *     añadir la acción `audio-mixer.volume-control` persiste todo.
 *  3. La geometría inválida (w=99) se rechaza con 400, no se persiste.
 *
 * Hermético: DB real en tmp + perfil/página propios.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ld-freemode-test-'));
process.env.LIBREDECK_DATA_DIR = TMP;
fs.mkdirSync(path.join(TMP, 'plugins'), { recursive: true });

import { initDatabase, DatabaseService } from '../db';
import { PluginLoader } from '../plugin-loader';
import { ActionRunner } from '../action-runner';
import { setupAPIRoutes } from '../api/routes';

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

async function api(method: string, url: string, body?: unknown) {
  const services: any = { wsManager: noopWs, pluginLoader: loader, actionRunner: runner, windowWatcher: {} };
  const res = await setupAPIRoutes(req(method, url, body), services);
  let json: any = null;
  try { json = await res.json(); } catch { /* sin cuerpo */ }
  return { status: res.status, json };
}

beforeAll(async () => {
  process.env.LIBREDECK_DATA_DIR = TMP;
  await initDatabase();
  const suffix = Math.random().toString(36).slice(2, 8);
  const db = new DatabaseService();
  const profileId = `prof-free-${suffix}`;
  pageId = `page-free-${suffix}`;
  db.createProfile({ id: profileId, name: 'Libre', data: {} });
  db.createPage({
    id: pageId, profile_id: profileId, name: 'Libre',
    order_idx: 0, is_folder: 0, grid_cols: 5, grid_rows: 3,
    data: { layoutMode: 'gridstack' },
  } as any);

  loader = new PluginLoader();
  try { await (loader as any).watcher?.close(); } catch {}
  (loader as any).watcher = undefined;
  runner = new ActionRunner({} as any);
});

afterAll(() => {
  try { runner.dispose(); } catch {}
  try { (loader as any).dispose?.(); } catch {}
});

describe('modo libre: widgets de la página', () => {
  it('crea widget libre (POST con x/y/w/h) y lo redimensiona/mueve (PUT)', async () => {
    const created = await api('POST', '/api/v1/buttons', {
      page_id: pageId, position: 0, x: 0, y: 0, w: 1, h: 1, data: {},
    });
    expect(created.status).toBe(201);
    const id = created.json.id as string;
    expect(typeof id).toBe('string');

    const moved = await api('PUT', `/api/v1/buttons/${id}`, { x: 2, y: 1, w: 2, h: 2 });
    expect(moved.status).toBe(200);
    expect(moved.json.x).toBe(2);
    expect(moved.json.y).toBe(1);
    expect(moved.json.w).toBe(2);
    expect(moved.json.h).toBe(2);

    const db = new DatabaseService();
    const row = db.getButton(id)!;
    expect(row.x).toBe(2);
    expect(row.y).toBe(1);
    expect(row.w).toBe(2);
    expect(row.h).toBe(2);
  });

  it('persiste la acción de control de volumen en el botón', async () => {
    const created = await api('POST', '/api/v1/buttons', {
      page_id: pageId, position: 10, x: 0, y: 2, w: 2, h: 1,
      data: { label: 'Volumen', actions: [{ id: 'a1', type: 'audio-mixer.volume-control', parameters: {} }] },
    });
    expect(created.status).toBe(201);
    const id = created.json.id as string;

    const db = new DatabaseService();
    const row = db.getButton(id)!;
    const actions = (row.data as any)?.actions ?? [];
    expect(actions.length).toBe(1);
    expect(actions[0].type).toBe('audio-mixer.volume-control');
  });

  it('PUT a id desconocido (fantasma `_1`) devuelve 404, no 500', async () => {
    const ghost = await api('PUT', '/api/v1/buttons/71198146-4737-46e8-a3cc-c43f2f706601_1', { x: 1, y: 1, w: 1, h: 1 });
    expect(ghost.status).toBe(404);
    expect(String((ghost.json as any)?.error ?? '')).toMatch(/no encontrado/i);

    const missing = await api('PUT', '/api/v1/buttons/no-existe-xyz', { data: { label: 'x' } });
    expect(missing.status).toBe(404);
  });

  it('rechaza geometría inválida (w=99) sin persistir', async () => {
    const created = await api('POST', '/api/v1/buttons', {
      page_id: pageId, position: 20, x: 0, y: 0, w: 1, h: 1, data: {},
    });
    expect(created.status).toBe(201);
    const id = created.json.id as string;

    const bad = await api('PUT', `/api/v1/buttons/${id}`, { w: 99 });
    expect(bad.status).toBe(400);

    const db = new DatabaseService();
    expect(db.getButton(id)!.w).toBe(1);
  });
});
