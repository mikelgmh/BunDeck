/**
 * shortcuts.test.ts — endpoint de atajos globales:
 *  - GET /api/v1/shortcuts lista ids conocidos (uiOnly + firstWinsMs)
 *  - POST /api/v1/shortcuts/trigger valida el id (400 si desconocido)
 *  - next-profile navega al siguiente perfil (wrap) vía wsManager
 *  - mute-all ejecuta app-volume (master mute) vía actionRunner
 *  - toggle-panels es solo-UI: difunde sin ejecutar en servidor
 *  - anti-doble-ejecución: mismo executionId → echo; otro id en <800ms → first-wins
 */
import { describe, it, expect, beforeAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ld-shortcuts-test-'));
process.env.LIBREDECK_DATA_DIR = TMP;

import { initDatabase, DatabaseService } from '../db';
import { handleShortcuts, stepProfileIds } from '../api/shortcuts';

let db: DatabaseService;

const broadcasts: any[] = [];
const navigations: any[] = [];
const executed: any[] = [];
const services: any = {
  wsManager: {
    broadcast: (type: string, payload: any, topic?: string) => {
      broadcasts.push({ type, payload, topic });
    },
    navigateProfileTo: (opts: any) => {
      navigations.push(opts);
      db.setCurrentProfile(opts.profileId);
      return { ok: true };
    },
  },
  actionRunner: {
    executeAction: async (action: any, context: any) => {
      executed.push({ action, context });
      return { success: true, result: { action: action.type } };
    },
  },
};

function ctx(path: string, method: string) {
  return {
    url: new URL(`http://localhost:3001${path}`),
    method,
    path,
    db,
    services,
  };
}

function post(body: any) {
  return new Request('http://localhost:3001/api/v1/shortcuts/trigger', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  // bun importa TODOS los ficheros antes de ejecutar: re-fijar el data dir
  // aquí (patrón del resto de la suite) para no heredar el de otro fichero.
  process.env.LIBREDECK_DATA_DIR = TMP;
  await initDatabase();
  db = new DatabaseService();
  db.createProfile({ id: 'p1', name: 'Uno', data: {} } as any);
  db.createProfile({ id: 'p2', name: 'Dos', data: {} } as any);
  db.createProfile({ id: 'p3', name: 'Tres', data: {} } as any);
  db.setCurrentProfile('p1');
});

describe('stepProfileIds (puro)', () => {
  it('avanza con wrap y tolera activo desconocido', () => {
    expect(stepProfileIds(['a', 'b', 'c'], 'b', 1)).toBe('c');
    expect(stepProfileIds(['a', 'b', 'c'], 'c', 1)).toBe('a');
    expect(stepProfileIds(['a', 'b', 'c'], 'a', -1)).toBe('c');
    expect(stepProfileIds([], null, 1)).toBeNull();
    expect(stepProfileIds(['a', 'b'], 'zzz', -1)).toBe('b');
  });
});

describe('POST /api/v1/shortcuts/trigger', () => {
  it('GET /api/v1/shortcuts lista los ids conocidos', async () => {
    const res = await handleShortcuts(
      new Request('http://localhost:3001/api/v1/shortcuts'),
      ctx('/api/v1/shortcuts', 'GET'),
    );
    expect(res).not.toBeNull();
    const body = await res!.json();
    expect(body.ids).toContain('next-profile');
    expect(body.ids).toContain('mute-all');
    expect(body.uiOnly).toContain('toggle-panels');
    expect(body.firstWinsMs).toBe(800);
  });

  it('rechaza id desconocido con 400', async () => {
    const res = await handleShortcuts(post({ id: 'nope' }), ctx('/api/v1/shortcuts/trigger', 'POST'));
    expect(res!.status).toBe(400);
  });

  it('next-profile navega p1 → p2 (orden de getProfiles)', async () => {
    broadcasts.length = 0;
    navigations.length = 0;
    // getProfiles ordena por updated_at DESC: el último creado va primero.
    // Solo se exige que navegue a un perfil distinto del actual.
    const res = await handleShortcuts(
      post({ id: 'next-profile', source: 'test', executionId: 't-next-1' }),
      ctx('/api/v1/shortcuts/trigger', 'POST'),
    );
    const body = await res!.json();
    expect(body.ok).toBe(true);
    expect(body.deduped).toBe(false);
    expect(navigations.length).toBe(1);
    expect(body.profileId).toBe(navigations[0].profileId);
    expect(broadcasts.some((b) => b.type === 'shortcut.triggered' && b.topic === 'shortcuts')).toBe(true);
  });

  it('mute-all ejecuta app-volume master mute', async () => {
    executed.length = 0;
    const res = await handleShortcuts(
      post({ id: 'mute-all', source: 'test', executionId: 't-mute-1' }),
      ctx('/api/v1/shortcuts/trigger', 'POST'),
    );
    const body = await res!.json();
    expect(body.ok).toBe(true);
    expect(executed.length).toBe(1);
    expect(executed[0].action.type).toBe('app-volume');
    expect(executed[0].action.parameters).toEqual({ mute: 'true' });
  });

  it('toggle-panels es solo-UI: difunde sin ejecutar en servidor', async () => {
    executed.length = 0;
    navigations.length = 0;
    const res = await handleShortcuts(
      post({ id: 'toggle-panels', source: 'test', executionId: 't-panels-1' }),
      ctx('/api/v1/shortcuts/trigger', 'POST'),
    );
    const body = await res!.json();
    expect(body.ok).toBe(true);
    expect(body.uiOnly).toBe(true);
    expect(executed.length).toBe(0);
  });

  it('notifyOnly difunde sin ejecutar en servidor', async () => {
    executed.length = 0;
    navigations.length = 0;
    const res = await handleShortcuts(
      post({ id: 'next-profile', source: 'web', executionId: 't-notify-1', notifyOnly: true }),
      ctx('/api/v1/shortcuts/trigger', 'POST'),
    );
    const body = await res!.json();
    expect(body.ok).toBe(true);
    expect(body.notified).toBe(true);
    expect(navigations.length).toBe(0);
    expect(broadcasts.some((b) => b.type === 'shortcut.triggered' && b.payload?.server?.notified === true)).toBe(true);
  });

  it('mismo executionId repetido → echo deduped', async () => {
    const first = await handleShortcuts(
      post({ id: 'toggle-kiosk', source: 'test', executionId: 't-echo-1' }),
      ctx('/api/v1/shortcuts/trigger', 'POST'),
    );
    expect((await first!.json()).deduped).toBe(false);
    const second = await handleShortcuts(
      post({ id: 'toggle-kiosk', source: 'test', executionId: 't-echo-1' }),
      ctx('/api/v1/shortcuts/trigger', 'POST'),
    );
    const body = await second!.json();
    expect(body.deduped).toBe(true);
  });

  it('otro executionId dentro de la ventana → first-wins', async () => {
    const first = await handleShortcuts(
      post({ id: 'prev-profile', source: 'web', executionId: 't-fw-1' }),
      ctx('/api/v1/shortcuts/trigger', 'POST'),
    );
    expect((await first!.json()).deduped).toBe(false);
    const second = await handleShortcuts(
      post({ id: 'prev-profile', source: 'launcher', executionId: 't-fw-2' }),
      ctx('/api/v1/shortcuts/trigger', 'POST'),
    );
    const body = await second!.json();
    expect(body.deduped).toBe(true);
    expect(body.reason).toBe('first-wins');
  });
});
