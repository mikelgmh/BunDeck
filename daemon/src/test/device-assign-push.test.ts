/**
 * device-assign-push.test.ts — asignar pantalla empuja al instante por WS.
 *
 * Cubre el flujo "botón dispositivos → asignar página al iPad → el iPad
 * cambia al momento": PUT /profiles/:id/assignments con un navegador online
 * emite `page.navigate` dirigido SOLO a ese deviceId (sin tocar el global
 * ni a otros dispositivos), y a un offline le persiste la vista para la
 * reconexión (`hello` la aplica).
 */
import { describe, it, expect, beforeAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ld-assign-push-test-'));
process.env.LIBREDECK_DATA_DIR = TMP;
fs.mkdirSync(path.join(TMP, 'plugins'), { recursive: true });

import { initDatabase, DatabaseService } from '../db';
import { handleDevices } from '../api/devices';
import { WebSocketManager } from '../ws';

let db: DatabaseService;
let uidCounter = 0;
function uid(prefix: string): string {
  uidCounter += 1;
  return `${prefix}-${uidCounter}-${Math.random().toString(36).slice(2, 8)}`;
}

let profId = '';
let pageA = '';
let pageB = '';

function makeManager(): WebSocketManager {
  const mgr = Object.create(WebSocketManager.prototype) as WebSocketManager;
  (mgr as any).clients = new Map();
  (mgr as any).db = new DatabaseService();
  (mgr as any).server = null;
  (mgr as any).broadcast = function (type: string, payload: any, _topic?: string) {
    for (const c of (this as any).clients.values()) {
      if (_topic && !(c.subscriptions as Set<string>).has(_topic)) continue;
      try { c.ws.send(JSON.stringify({ type, payload })); } catch { /* noop */ }
    }
  };
  return mgr;
}

function fakeWs(inbox: any[]): any {
  return {
    readyState: 1,
    send(text: string) { inbox.push(JSON.parse(String(text))); },
    close() {},
  };
}

function addClient(mgr: WebSocketManager, clientId: string, deviceId: string, pageId: string): any[] {
  const inbox: any[] = [];
  (mgr as any).clients.set(clientId, {
    id: clientId, ws: fakeWs(inbox), subscriptions: new Set(['pages', 'devices']),
    deviceId, kind: 'browser', name: deviceId,
    profileId: profId, pageId, connectedAt: Date.now(), lastSeen: Date.now(),
    source: 'ws', ip: '127.0.0.1', lanAuthed: true,
  });
  db.upsertDeviceSession({ device_id: deviceId, name: deviceId, kind: 'browser', profile_id: profId, page_id: pageId });
  try {
    if (!db.getDevice(deviceId)) {
      db.createDevice({ id: deviceId, name: deviceId, kind: 'browser', model: null, cols: null, rows: null, hw_path: null } as any);
    }
  } catch { /* noop */ }
  return inbox;
}

function lastOfType(inbox: any[], type: string): any {
  const f = inbox.filter((m) => m.type === type);
  return f.length ? f[f.length - 1] : null;
}

beforeAll(async () => {
  await initDatabase();
  db = new DatabaseService();
  const prof = db.createProfile({ id: uid('prof'), name: 'Principal', data: {} });
  profId = prof.id;
  pageA = uid('page'); pageB = uid('page');
  db.createPage({ id: pageA, profile_id: profId, name: 'A', order_idx: 0, is_folder: 0, data: {} });
  db.createPage({ id: pageB, profile_id: profId, name: 'B', order_idx: 1, is_folder: 0, data: {} });
  db.setCurrentPage(pageA);
});

async function putAssignments(mgr: WebSocketManager, map: Record<string, string | null>) {
  const req = new Request(`http://localhost:3001/api/v1/profiles/${profId}/assignments`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ assignments: map }),
  });
  const res = await handleDevices(req, {
    url: new URL(req.url), method: 'PUT', path: `/api/v1/profiles/${profId}/assignments`,
    db, services: { wsManager: mgr } as any,
  });
  expect(res!.status).toBe(200);
  return res!.json();
}

describe('PUT assignments empuja page.navigate dirigido', () => {
  it('solo el dispositivo asignado navega; el resto y el global intactos', async () => {
    const mgr = makeManager();
    const hostInbox = addClient(mgr, 'c-host', 'dev-host', pageA);
    const ipadInbox = addClient(mgr, 'c-ipad', 'dev-ipad', pageA);
    db.setCurrentPage(pageA);

    await putAssignments(mgr, { 'dev-ipad': pageB });

    expect(db.getAssignments(profId)['dev-ipad']).toBe(pageB);
    // El iPad recibe el dirigido con su deviceId.
    const nav = lastOfType(ipadInbox, 'page.navigate');
    expect(nav).not.toBeNull();
    expect(nav.payload.pageId).toBe(pageB);
    expect(nav.payload.targetDeviceId).toBe('dev-ipad');
    // El host no recibe nada dirigido a otro.
    expect(lastOfType(hostInbox, 'page.navigate')).toBeNull();
    expect((mgr as any).clients.get('c-host').pageId).toBe(pageA);
    expect((mgr as any).clients.get('c-ipad').pageId).toBe(pageB);
    // El reparto no mueve el current global del anfitrión.
    expect(db.getSetting('current.page_id')).toBe(pageA);
  });

  it('si ya muestra esa página no se re-emite navegación', async () => {
    const mgr = makeManager();
    const inbox = addClient(mgr, 'c-x', 'dev-x', pageB);
    db.setAssignment(profId, 'dev-x', pageB);
    const before = inbox.filter((m) => m.type === 'page.navigate').length;
    await putAssignments(mgr, { 'dev-x': pageB });
    expect(inbox.filter((m) => m.type === 'page.navigate').length).toBe(before);
    expect(lastOfType(inbox, 'page.navigate')).toBeNull();
  });

  it('offline: persiste y hello lo aplica al reconectar', async () => {
    const mgr = makeManager();
    addClient(mgr, 'c-h', 'dev-h', pageA);
    // Sin WS vivo: solo fila + sesión persistida previa.
    db.createDevice({ id: 'dev-off', name: 'iPad', kind: 'browser', model: null, cols: null, rows: null, hw_path: null } as any);
    db.upsertDeviceSession({ device_id: 'dev-off', name: 'iPad', kind: 'browser', profile_id: profId, page_id: pageA });

    await putAssignments(mgr, { 'dev-off': pageB });
    expect(db.getDeviceSession('dev-off')?.page_id).toBe(pageB);

    // Reconexión: hello sin vista explícita recibe la asignada.
    const inbox: any[] = [];
    (mgr as any).clients.set('c-re', {
      id: 'c-re', ws: fakeWs(inbox), subscriptions: new Set(),
      deviceId: 'c-re', kind: 'unknown', name: null,
      profileId: null, pageId: null, connectedAt: Date.now(), lastSeen: Date.now(),
      source: 'ws', ip: '127.0.0.1', lanAuthed: true,
    });
    (mgr as any).handleClientMessage('c-re', { type: 'hello', payload: { deviceId: 'dev-off', kind: 'browser', name: 'iPad' } });
    expect(lastOfType(inbox, 'session.state')?.payload.pageId).toBe(pageB);
  });

  it('navigatePageTo dirigido al HW fija su sesión aunque esté en otro perfil (MCP/flujos)', async () => {
    const { streamDeckDriver } = await import('../hw-driver/streamdeck-driver');
    const prev = streamDeckDriver.getSessionView();
    const mgr = makeManager();
    try {
      const profX = db.createProfile({ id: uid('prof'), name: 'NX', data: {} }).id;
      const profY = db.createProfile({ id: uid('prof'), name: 'NY', data: {} }).id;
      const gx = uid('page'); db.createPage({ id: gx, profile_id: profX, name: 'GX', order_idx: 0, is_folder: 0, data: {} });
      const gy = uid('page'); db.createPage({ id: gy, profile_id: profY, name: 'GY', order_idx: 0, is_folder: 0, data: {} });
      await streamDeckDriver.setSessionView({ profileId: profY, pageId: gy });
      const res = (mgr as any).navigatePageTo({
        pageId: gx,
        originDeviceId: null,
        targets: { kind: 'devices', ids: [streamDeckDriver.getDeviceId()] },
        context: { via: 'mcp' },
      });
      expect(res.ok).toBe(true);
      await new Promise((r) => setTimeout(r, 50));
      expect(streamDeckDriver.getSessionView()).toEqual({ profileId: profX, pageId: gx });
    } finally {
      try {
        if (prev.profileId && prev.pageId) await streamDeckDriver.setSessionView({ profileId: prev.profileId, pageId: prev.pageId });
        else {
          (streamDeckDriver as any).sessionProfileId = prev.profileId;
          (streamDeckDriver as any).sessionPageId = prev.pageId;
        }
      } catch { /* mejor esfuerzo */ }
    }
  });
});

describe('PUT assignments: el HW sigue la asignación explícita aunque su sesión esté en otro perfil', () => {
  it('fija la sesión del driver (memoria + tabla) a la página asignada', async () => {
    const { streamDeckDriver } = await import('../hw-driver/streamdeck-driver');
    // Sin HW físico en tests: setSessionView guarda sesión sin repintar.
    const prev = streamDeckDriver.getSessionView();
    const mgr = makeManager();
    try {
      // Dos perfiles con cuadrícula 5×3; el HW "vive" en el otro.
      const profX = db.createProfile({ id: uid('prof'), name: 'X', data: {} }).id;
      const profY = db.createProfile({ id: uid('prof'), name: 'Y', data: {} }).id;
      const gx = uid('page'); db.createPage({ id: gx, profile_id: profX, name: 'GX', order_idx: 0, is_folder: 0, data: {} });
      const gy = uid('page'); db.createPage({ id: gy, profile_id: profY, name: 'GY', order_idx: 0, is_folder: 0, data: {} });
      const deck = uid('deck');
      db.createDevice({ id: deck, name: 'Deck', kind: 'deck', model: 'mk2', cols: 5, rows: 3, hw_path: null } as any);
      await streamDeckDriver.setSessionView({ profileId: profY, pageId: gy });
      expect(streamDeckDriver.getSessionView()).toEqual({ profileId: profY, pageId: gy });

      // Asignar en X: antes la guarda sameProfile lo ignoraba (sesión en Y).
      const req = new Request(`http://localhost:3001/api/v1/profiles/${profX}/assignments`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ assignments: { [deck]: gx } }),
      });
      const res = await handleDevices(req, {
        url: new URL(req.url), method: 'PUT', path: `/api/v1/profiles/${profX}/assignments`,
        db, services: { wsManager: mgr } as any,
      });
      expect(res!.status).toBe(200);
      expect(db.getAssignments(profX)[deck]).toBe(gx);
      // La sesión del HW sigue a la asignación explícita (perfil incluido).
      expect(streamDeckDriver.getSessionView()).toEqual({ profileId: profX, pageId: gx });
      expect(db.getDeviceSession(streamDeckDriver.getDeviceId())?.page_id).toBe(gx);
    } finally {
      // Restaurar la sesión del driver para no contaminar otros ficheros.
      try {
        if (prev.profileId && prev.pageId) await streamDeckDriver.setSessionView({ profileId: prev.profileId, pageId: prev.pageId });
        else {
          (streamDeckDriver as any).sessionProfileId = prev.profileId;
          (streamDeckDriver as any).sessionPageId = prev.pageId;
        }
      } catch { /* mejor esfuerzo */ }
    }
  });
});
