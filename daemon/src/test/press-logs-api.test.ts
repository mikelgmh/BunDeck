/**
 * press-logs-api.test.ts — escritura desde executeButtonFlow + endpoints HTTP.
 *
 * Cubre: executeButtonFlow con 2 acciones (una falla) → 2 filas con mismo
 * runId + deviceId/deviceName + success/error + duration; respeto de empty,
 * quiet y logs.press_enabled; GET con filtros y validaciones 400; DELETE.
 *
 * Patrón: tmpdir + BUNDECK_DATA_DIR=TMP antes de importar db.
 */
import { describe, it, expect, beforeAll, beforeEach, mock } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ld-press-logs-api-test-'));
process.env.BUNDECK_DATA_DIR = TMP;

import { initDatabase, DatabaseService } from '../db';
import { ActionRunner } from '../action-runner';
import type { PluginLoader } from '../plugin-loader';
import { handlePressLogs } from '../api/press-logs';

let db: DatabaseService;
let runner: ActionRunner;

function makeFakeLoader(): PluginLoader {
  return { setActionCallbacks: () => {} } as unknown as PluginLoader;
}

async function callPressLogs(method: string, urlPath: string) {
  const url = new URL(urlPath, 'http://localhost');
  return handlePressLogs(new Request(url, { method }), {
    url,
    method,
    path: url.pathname,
    db,
    services: {} as any,
  });
}

async function json(res: Response | null) {
  expect(res).not.toBeNull();
  return res!.json() as Promise<any>;
}

beforeAll(async () => {
  process.env.BUNDECK_DATA_DIR = TMP;
  await initDatabase();
  db = new DatabaseService();
  db.createProfile({ id: 'prof1', name: 'P1', data: {} });
  db.createPage({ id: 'page1', profile_id: 'prof1', name: 'Principal', order_idx: 0, is_folder: 0, data: {} } as any);
  try {
    db.createDevice({ id: 'dev1', name: 'Deck Mini', kind: 'deck', model: 'mini', cols: null, rows: null, hw_path: null } as any);
  } catch { /* ya existe en re-runs del fichero */ }
});

beforeEach(() => {
  db.clearPressLogs();
  db.setSetting('logs.press_enabled', 'true');
  runner = new ActionRunner(makeFakeLoader());
  runner.registerAction('test.echo', mock(async (params: any) => ({ echo: params?.msg ?? 'ok' })));
  runner.registerAction('test.fail', mock(async () => { throw new Error('boom programado'); }));
});

const BUTTON = { id: 'btn1', page_id: 'page1', position: 4, data: { mode: 'seq', actions: [], rules: [] } };

function twoActionButton() {
  return {
    ...BUTTON,
    data: {
      mode: 'seq',
      actions: [
        { type: 'test.echo', parameters: { msg: 'hola' } },
        { type: 'test.fail', parameters: {} },
      ],
      rules: [],
    },
  };
}

describe('executeButtonFlow escribe press logs', () => {
  it('2 acciones (una falla) → 2 filas, mismo runId, deviceId, success/error, duration', async () => {
    const res = await runner.executeButtonFlow(twoActionButton() as any, {
      buttonId: 'btn1', pageId: 'page1', timestamp: Date.now(),
      deviceId: 'dev1', pressType: 'short',
    } as any);
    expect(res.success).toBe(false);
    expect(res.results).toHaveLength(2);

    const { items, total } = db.listPressLogs({ buttonId: 'btn1' });
    expect(total).toBe(2);
    expect(items).toHaveLength(2);
    // Mismo runId de pulsación
    expect(items[0].runId).toBe(res.runId);
    expect(items[1].runId).toBe(res.runId);
    // Dispositivo resuelto (id + nombre)
    expect(items[0].deviceId).toBe('dev1');
    expect(items[0].deviceName).toBe('Deck Mini');
    // Éxito / fallo por acción
    const byType = Object.fromEntries(items.map((r) => [r.actionType, r]));
    expect(byType['test.echo'].success).toBe(true);
    expect(byType['test.fail'].success).toBe(false);
    expect(byType['test.fail'].error).toContain('boom programado');
    // Duración presente
    expect(typeof byType['test.echo'].durationMs).toBe('number');
    expect(byType['test.echo'].durationMs).toBeGreaterThanOrEqual(0);
    // profileId resuelto vía la página; position del botón
    expect(byType['test.echo'].profileId).toBe('prof1');
    expect(byType['test.echo'].position).toBe(4);
    expect(byType['test.echo'].pressType).toBe('short');
    // actionIndex secuencial
    expect(items.map((r) => r.actionIndex).sort()).toEqual([0, 1]);
  });

  it('no escribe si empty, si quiet ni si logs.press_enabled=false', async () => {
    const empty = await runner.executeButtonFlow(
      { id: 'btn-empty', data: { mode: 'seq', actions: [], rules: [] } } as any,
      { timestamp: Date.now() } as any,
    );
    expect(empty.empty).toBe(true);
    expect(db.listPressLogs({}).total).toBe(0);

    await runner.executeButtonFlow(twoActionButton() as any, {
      buttonId: 'btn1', timestamp: Date.now(), quiet: true,
    } as any);
    expect(db.listPressLogs({}).total).toBe(0);

    db.setSetting('logs.press_enabled', 'false');
    await runner.executeButtonFlow(twoActionButton() as any, {
      buttonId: 'btn1', timestamp: Date.now(),
    } as any);
    expect(db.listPressLogs({}).total).toBe(0);
  });

  it('nunca persiste parameters (secretos)', async () => {
    await runner.executeButtonFlow({
      ...BUTTON,
      data: { mode: 'seq', actions: [{ type: 'test.echo', parameters: { password: 's3cr3t' } }], rules: [] },
    } as any, { buttonId: 'btn1', timestamp: Date.now() } as any);
    const raw = db.listPressLogs({ buttonId: 'btn1' });
    expect(raw.total).toBe(1);
    expect(JSON.stringify(raw.items)).not.toContain('s3cr3t');
    expect(JSON.stringify(raw.items)).not.toContain('password');
  });
});

describe('GET press logs (API)', () => {
  it('GET /buttons/:id/logs filtra y pagina; botón borrado → items []', async () => {
    db.addPressLog({ buttonId: 'g1', actionType: 'a.x', success: true, pressType: 'short', deviceId: 'dev1', ts: 1000 });
    db.addPressLog({ buttonId: 'g1', actionType: 'a.y', success: false, error: 'x', pressType: 'long', ts: 2000 });

    const all = await json(await callPressLogs('GET', '/api/v1/buttons/g1/logs?limit=50&offset=0'));
    expect(all.total).toBe(2);
    expect(all.limit).toBe(50);
    expect(all.offset).toBe(0);

    const failed = await json(await callPressLogs('GET', '/api/v1/buttons/g1/logs?success=false'));
    expect(failed.total).toBe(1);
    expect(failed.items[0].actionType).toBe('a.y');

    const page = await json(await callPressLogs('GET', '/api/v1/buttons/g1/logs?limit=1&offset=1'));
    expect(page.total).toBe(2);
    expect(page.items).toHaveLength(1);

    // Botón inexistente (borrado): 200 con items vacíos, no 404
    const gone = await callPressLogs('GET', '/api/v1/buttons/no-existe/logs');
    expect(gone!.status).toBe(200);
    expect((await gone!.json() as any).items).toEqual([]);
  });

  it('GET valida: 400 si limit>500, offset<0 o since/until no numéricos', async () => {
    for (const q of ['?limit=501', '?offset=-1', '?since=abc', '?until=xx', '?limit=no']) {
      const res = await callPressLogs('GET', `/api/v1/buttons/g1/logs${q}`);
      expect(res!.status).toBe(400);
    }
  });

  it('GET /actions/logs exige actionType; GET /press-logs combina', async () => {
    db.addPressLog({ buttonId: 'h1', actionType: 'shell.shell', deviceId: 'dev1', ts: 100 });
    db.addPressLog({ buttonId: 'h2', actionType: 'http.request', deviceId: 'dev1', ts: 200 });

    const missing = await callPressLogs('GET', '/api/v1/actions/logs');
    expect(missing!.status).toBe(400);

    const byAction = await json(await callPressLogs('GET', '/api/v1/actions/logs?actionType=shell.shell'));
    expect(byAction.total).toBe(1);
    expect(byAction.items[0].buttonId).toBe('h1');

    const generic = await json(
      await callPressLogs('GET', '/api/v1/press-logs?deviceId=dev1&actionType=http.request')
    );
    expect(generic.total).toBe(1);
    expect(generic.items[0].buttonId).toBe('h2');
  });
});

describe('DELETE press logs (API)', () => {
  it('DELETE por botón, por actionType y genérico devuelven {deleted}', async () => {
    db.addPressLog({ buttonId: 'd1', actionType: 'a.x', ts: 100 });
    db.addPressLog({ buttonId: 'd1', actionType: 'a.y', ts: 200 });
    db.addPressLog({ buttonId: 'd2', actionType: 'a.x', ts: 300 });

    const delBtn = await json(await callPressLogs('DELETE', '/api/v1/buttons/d1/logs'));
    expect(delBtn.deleted).toBe(2);
    expect(db.listPressLogs({}).total).toBe(1);

    const delAction = await json(await callPressLogs('DELETE', '/api/v1/actions/logs?actionType=a.x'));
    expect(delAction.deleted).toBe(1);
    expect(db.listPressLogs({}).total).toBe(0);

    db.addPressLog({ buttonId: 'e1', actionType: 'a.z', ts: 100 });
    db.addPressLog({ buttonId: 'e1', actionType: 'a.z', ts: 9999 });
    const delBefore = await json(await callPressLogs('DELETE', '/api/v1/press-logs?buttonId=e1&before=1000'));
    expect(delBefore.deleted).toBe(1);
    expect(db.listPressLogs({}).total).toBe(1);
  });
});
