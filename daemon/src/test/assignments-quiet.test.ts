/**
 * assignments-quiet.test.ts — el GET de asignaciones NO debe emitir
 * `assignment.updated` cuando nada cambió.
 *
 * Bug: el handler emitía el broadcast en CADA GET. Como el propio frontend
 * está suscrito y al recibirlo refetchea (devices-changed → loadAssignments),
 * se formaba una tormenta auto-sostenida GET → broadcast → GET → … (~5
 * req/s hasta agotar los sockets del navegador: ERR_INSUFFICIENT_RESOURCES).
 *
 * Hermético en aislado (DB real) y en suite completa (mock global de
 * action-runner.test.ts): solo se afirma que dos GET idénticos seguidos no
 * generan broadcasts nuevos.
 */
import { describe, it, expect, beforeAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ld-asgq-test-'));
process.env.LIBREDECK_DATA_DIR = TMP;
fs.mkdirSync(path.join(TMP, 'plugins'), { recursive: true });

import { initDatabase, DatabaseService } from '../db';
import { setupAPIRoutes } from '../api/routes';

let profileId: string;
let pageId: string;
let deviceId = 'qa-deck-quiet';

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
  profileId = `prof-${suffix}`;
  pageId = `page-${suffix}`;
  deviceId = `qa-deck-${suffix}`;
  db.createProfile({ id: profileId, name: 'P', data: {} });
  db.createPage({ id: pageId, profile_id: profileId, name: 'Pg', order_idx: 0, is_folder: 0, data: {} } as any);
  try {
    (db as any).createDevice({ id: deviceId, name: 'Deck QA', kind: 'deck', model: 'mk2' });
  } catch {
    // mock sin createDevice con ese shape: se usa el id igualmente
  }
  try {
    db.setAssignment(profileId, deviceId, pageId);
  } catch { /* sin soporte: el GET igual debe ser silencioso */ }
});

describe('GET assignments silencioso sin cambios', () => {
  it('dos GET idénticos seguidos no emiten broadcasts nuevos', async () => {
    let broadcasts = 0;
    const services: any = {
      wsManager: { broadcast: () => { broadcasts++; } },
      pluginLoader: {},
      actionRunner: {},
      windowWatcher: {},
    };
    const get = () => setupAPIRoutes(req('GET', `/api/v1/profiles/${profileId}/assignments`), services);

    const r1 = await get();
    expect(r1.status).toBe(200);
    const afterFirst = broadcasts;

    const r2 = await get();
    expect(r2.status).toBe(200);
    // Nada cambió entre ambos: el segundo GET debe ser silencioso.
    // (El primero PUEDE emitir si el repair auto-asignó algo: no se afirma.)
    expect(broadcasts).toBe(afterFirst);

    const b1 = await r1.json();
    const b2 = await r2.json();
    expect(b2.assignments).toEqual(b1.assignments);
  });
});
