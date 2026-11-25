/**
 * remote-ui-revoke.test.ts — REGRESIÓN: revocar una sesión UI debe
 * prohibir + ocultar el dispositivo y cortar el acceso.
 *
 * Cubre:
 * - DELETE /ui-sessions/:prefix → validateUiSession deniega,
 *   devicesForTokenPrefix vacío, tombstone unbind-pending creado,
 *   closeRtcForToken invocado, forgetDeviceEverywhere borra fila+sesión.
 * - buildUnifiedDevices ya no lista el dispositivo tras revocar+refrescar.
 * - Un `hello` posterior por el túnel con el token revocado NO resucita
 *   fila ni sesión (se rechaza con UI_TOKEN_REQUIRED).
 * - resyncUiState re-emite el ui-unbind pendiente (revocar con relay caído).
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ld-ui-revoke-test-'));
process.env.LIBREDECK_DATA_DIR = ROOT;

import { initDatabase, DatabaseService } from '../db';
import { handleRemote } from '../api/remote';
import { buildUnifiedDevices, forgetDeviceEverywhere } from '../api/devices';
import { WebSocketManager } from '../ws';
import {
  enqueueUiRequest,
  validateUiSession,
  clearUiPendingForTests,
  queueUiUnbind,
  listUiUnbindPending,
} from '../remote/ui-policy';
import { devicesForTokenPrefix, bindDeviceToToken } from '../remote/device-bindings';

let db: DatabaseService;
let services: any;
let broadcasts: any[];

function makeServices(): any {
  return {
    wsManager: {
      broadcast: (event: string, payload: any, topic?: string) => { broadcasts.push({ event, payload, topic }); },
      disconnectDevice: (_id: string) => 0,
      getSessions: () => [],
    },
    actionRunner: { executeAction: async (a: any) => ({ success: true, action: a?.type ?? '?' }) },
    pluginLoader: {},
    windowWatcher: {},
  };
}

async function remoteCall(p: string, method: string, body?: any) {
  const init: RequestInit = { method, headers: { 'content-type': 'application/json' } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const req = new Request(`http://localhost:3001${p}`, init);
  const url = new URL(`http://localhost:3001${p}`);
  const res = await handleRemote(req, { url, method, path: url.pathname, db, services });
  if (!res) throw new Error(`sin handler para ${method} ${p}`);
  let json: any = {};
  try { json = await res.json(); } catch { json = {}; }
  return { status: res.status, body: json };
}

function makeTunnelManager(): WebSocketManager {
  const mgr = Object.create(WebSocketManager.prototype) as WebSocketManager;
  (mgr as any).clients = new Map();
  (mgr as any).db = db;
  (mgr as any).server = null;
  return mgr;
}

function fakeWs(inbox: any[]): any {
  return {
    readyState: 1,
    sent: inbox,
    send(text: string) { inbox.push(JSON.parse(String(text))); },
    close() {},
  };
}

beforeEach(async () => {
  const dir = fs.mkdtempSync(path.join(ROOT, 't-'));
  process.env.LIBREDECK_DATA_DIR = dir;
  await initDatabase();
  db = new DatabaseService();
  try {
    for (const k of Object.keys(db.getAllSettings())) {
      if (k.startsWith('remote.ui.') || k === 'remote.relay.url') db.deleteSetting(k);
    }
  } catch { /* noop */ }
  broadcasts = [];
  services = makeServices();
  clearUiPendingForTests();
  try { delete (globalThis as any).__libredeckRemote; } catch { /* noop */ }
  db.setSetting('remote.ui.enabled', '1');
  db.setSetting('remote.relay.url', 'wss://relay.example.com');
});

async function approvedSession(deviceId = 'tablet-1') {
  const c = await remoteCall('/api/v1/remote/ui-code', 'POST', {});
  expect(c.status).toBe(200);
  const q = enqueueUiRequest(db, { urlCode: c.body.urlCode, ua: 'Tablet', ip: '10.0.0.5' });
  const a = await remoteCall(`/api/v1/remote/ui-pending/${q.reqId}/allow`, 'POST', {});
  expect(a.status).toBe(200);
  const token = String(a.body.sessionToken);
  const prefix = token.slice(0, 8);
  // Simula el hello del móvil: enlace + fila + sesión persistida.
  bindDeviceToToken(db, 'ui', deviceId, token);
  db.createDevice({ id: deviceId, name: 'Tablet', kind: 'browser', model: null, cols: null, rows: null, hw_path: null });
  db.upsertDeviceSession({ device_id: deviceId, name: 'Tablet', kind: 'browser' });
  return { token, prefix };
}

describe('remote-ui revoke: prohibir + ocultar', () => {
  it('DELETE revoca sesión, crea tombstone, cierra RTC y olvida el dispositivo', async () => {
    const { token, prefix } = await approvedSession('tablet-revoke-1');
    expect(validateUiSession(db, token).ok).toBe(true);
    expect(devicesForTokenPrefix(db, 'ui', prefix)).toEqual(['tablet-revoke-1']);

    let closedRtc: string[] = [];
    (globalThis as any).__libredeckRemote = {
      tunnel: {
        revokeUiSession: (_t: string) => true,
        closeRtcForToken: (t: string) => { closedRtc.push(t); return 1; },
      },
    };

    const del = await remoteCall(`/api/v1/remote/ui-sessions/${prefix}`, 'DELETE');
    expect(del.body).toMatchObject({ ok: true });
    expect(validateUiSession(db, token).ok).toBe(false);
    expect(devicesForTokenPrefix(db, 'ui', prefix)).toEqual([]);
    // Tombstone durable para resync (revocar con el relay caído).
    expect(listUiUnbindPending(db).some((e) => e.token === token)).toBe(true);
    expect(closedRtc).toEqual([token]);
    // Dispositivo olvidado: sin fila ni sesión ni enlace.
    expect(db.getDevice('tablet-revoke-1')).toBeNull();
    expect(db.getDeviceSession('tablet-revoke-1')).toBeFalsy();
    // Lista local ya no lo muestra tras refrescar.
    const list = buildUnifiedDevices(db, services);
    expect(list.some((d: any) => String(d.id) === 'tablet-revoke-1')).toBe(false);
    expect(broadcasts.some((b) => b.event === 'device.deleted')).toBe(true);
  });

  it('hello por túnel con token revocado NO resucita fila ni sesión', async () => {
    const { token } = await approvedSession('tablet-revive-1');
    // Revoca directamente (como el handler) y olvida el dispositivo.
    const { revokeUiSessionByPrefix } = await import('../remote/ui-policy');
    const found = revokeUiSessionByPrefix(db, token.slice(0, 8));
    expect(found).not.toBeNull();
    queueUiUnbind(db, token, found!.session.exp);
    forgetDeviceEverywhere(db, services, 'tablet-revive-1', { revokeTokens: false });
    expect(db.getDevice('tablet-revive-1')).toBeNull();

    // El móvil reintenta hello por el puente del túnel con el token viejo.
    const mgr = makeTunnelManager();
    const inbox: any[] = [];
    const clientId = 'tunnel:bridge-1';
    (mgr as any).clients.set(clientId, {
      id: clientId,
      ws: fakeWs(inbox),
      subscriptions: new Set(),
      deviceId: clientId,
      kind: 'relay',
      name: null,
      profileId: null,
      pageId: null,
      connectedAt: Date.now(),
      lastSeen: Date.now(),
      source: 'tunnel',
      ip: null,
      lanAuthed: true,
    });
    (mgr as any).handleClientMessage(clientId, {
      type: 'hello',
      payload: { deviceId: 'tablet-revive-1', kind: 'browser', name: 'Tablet', sessionToken: token },
    });
    const err = inbox.find((m) => m.type === 'error');
    expect(err?.payload?.code).toBe('UI_TOKEN_REQUIRED');
    // Nada resucitado: sin fila, sin sesión, sin enlace.
    expect(db.getDevice('tablet-revive-1')).toBeNull();
    expect(db.getDeviceSession('tablet-revive-1')).toBeFalsy();
    expect(devicesForTokenPrefix(db, 'ui', token.slice(0, 8))).toEqual([]);
    expect(buildUnifiedDevices(db, services).some((d: any) => String(d.id) === 'tablet-revive-1')).toBe(false);
  });

  it('resyncUiState re-emite el unbind pendiente aunque la sesión ya no exista', async () => {
    const { token } = await approvedSession('tablet-resync-1');
    const { revokeUiSessionByPrefix } = await import('../remote/ui-policy');
    const found = revokeUiSessionByPrefix(db, token.slice(0, 8));
    queueUiUnbind(db, token, found!.session.exp);

    const { TunnelClient } = await import('../remote/tunnel');
    const sent: any[] = [];
    const t = new TunnelClient(db as any, null, { deviceId: 'dev-resync-revoke', relayUrl: 'ws://127.0.0.1:9/nada' });
    (t as any).send = (o: unknown) => { sent.push(o); return true; };
    const r = (t as any).resyncUiState();
    expect(r.unbound).toBeGreaterThanOrEqual(1);
    expect(sent.some((m: any) => m.kind === 'ui-unbind' && m.sessionToken === token)).toBe(true);
    t.stop();
  });

  it('sesión vigente con ui-rebind legítimo sigue funcionando (no se rompe)', async () => {
    // Una sesión NO revocada debe re-anunciarse como ui-rebind (persistencia).
    const liveTok = 'cd'.repeat(32);
    const liveExp = Date.now() + 3600_000;
    db.setSetting(`remote.ui.session.${liveTok}`, JSON.stringify({ createdAt: Date.now(), exp: liveExp, ua: 't', ip: '1', revoked: false }));
    const { TunnelClient } = await import('../remote/tunnel');
    const sent: any[] = [];
    const t = new TunnelClient(db as any, null, { deviceId: 'dev-legit', relayUrl: 'ws://127.0.0.1:9/nada' });
    (t as any).send = (o: unknown) => { sent.push(o); return true; };
    const r = (t as any).resyncUiState();
    expect(r.rebound).toBe(1);
    expect(sent.some((m: any) => m.kind === 'ui-rebind' && m.sessionToken === liveTok)).toBe(true);
    t.stop();
    try { db.deleteSetting(`remote.ui.session.${liveTok}`); } catch { /* noop */ }
  });
});
