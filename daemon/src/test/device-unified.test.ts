/**
 * device-unified.test.ts — Lista unificada de dispositivos (sin altas manuales).
 *
 * - buildUnifiedDevices: auto-repara filas para sesiones, clasifica
 *   source (hardware/browser/manual) y marca online por WS.
 * - device-bindings: enlace deviceId ↔ prefijo de sesión.
 * - forgetDeviceEverywhere: olvidar = prohibir (revoca sesión vinculada,
 *   borra filas, cierra WS).
 * - kind 'browser' válido en POST/backup y acepta páginas libres.
 */
import { describe, it, expect, beforeAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ld-devunified-test-'));
process.env.LIBREDECK_DATA_DIR = TMP;
fs.mkdirSync(path.join(TMP, 'plugins'), { recursive: true });

import { initDatabase, DatabaseService, purgeManualDevices } from '../db';
import { buildUnifiedDevices, forgetDeviceEverywhere, handleDevices } from '../api/devices';
import { bindDeviceToToken, devicesForTokenPrefix, boundPrefixForDevice } from '../remote/device-bindings';
import { createLanInvite, redeemLanInvite, validateLanSession, listLanSessions } from '../remote/lan-invites';
import { validateBackup, buildBackup } from '../backup';

let db: DatabaseService;
let uidCounter = 0;
function uid(prefix: string): string {
  uidCounter += 1;
  return `${prefix}-${uidCounter}-${Math.random().toString(36).slice(2, 8)}`;
}

const svc = (sessions: any[] = []) => ({
  wsManager: {
    getSessions: () => sessions,
    broadcast() {},
    disconnectDevice() {},
  },
});

beforeAll(async () => {
  await initDatabase();
  db = new DatabaseService();
});

describe('device-bindings (enlace deviceId ↔ sesión)', () => {
  it('guarda solo el prefijo y resuelve en ambos sentidos', () => {
    const deviceId = uid('dev');
    bindDeviceToToken(db, 'lan', deviceId, 'abcdef1234567890');
    expect(boundPrefixForDevice(db, 'lan', deviceId)).toBe('abcdef12');
    expect(devicesForTokenPrefix(db, 'lan', 'abcdef12')).toContain(deviceId);
    expect(devicesForTokenPrefix(db, 'ui', 'abcdef12')).not.toContain(deviceId);
  });
});

describe('buildUnifiedDevices (lista unificada)', () => {
  it('auto-repara filas para sesiones y clasifica source/online', () => {
    const browserId = uid('browser');
    db.upsertDeviceSession({ device_id: browserId, name: 'Navegador', kind: 'browser' });
    const listed = buildUnifiedDevices(db, svc([
      { deviceId: browserId, connected: true },
    ]));
    const row = listed.find((d: any) => d.id === browserId);
    expect(row).toBeTruthy();
    expect(row.kind).toBe('browser');
    expect(row.source).toBe('browser');
    expect(row.online).toBe(true);
  });

  it('la sesión hardware se clasifica como hardware', () => {
    db.upsertDeviceSession({ device_id: 'streamdeck-local', name: null, kind: 'hardware' });
    const listed = buildUnifiedDevices(db, svc([]));
    const row = listed.find((d: any) => d.id === 'streamdeck-local');
    expect(row).toBeTruthy();
    expect(row.kind).toBe('deck');
    expect(row.source).toBe('hardware');
    expect(row.online).toBe(false);
  });

  it('las filas heredadas sin sesión son manual y offline', () => {
    const legacyId = uid('legacy');
    db.createDevice({ id: legacyId, name: 'Móvil viejo', kind: 'phone', model: null, cols: null, rows: null, hw_path: null } as any);
    const listed = buildUnifiedDevices(db, svc([]));
    const legacy = listed.find((d: any) => d.id === legacyId);
    expect(legacy).toBeTruthy();
    expect(legacy.source).toBe('manual');
    expect(legacy.online).toBe(false);
    db.deleteDevice(legacyId);
  });

  it('ordena hardware primero', () => {
    const listed = buildUnifiedDevices(db, svc([]));
    expect(listed[0].source).toBe('hardware');
  });
});

describe('purgeStaleDeviceSessions (higiene de fantasmas)', () => {
  it('purga sesiones viejas y la lista unificada no las resucita', () => {
    const ghostId = uid('ghost');
    db.upsertDeviceSession({ device_id: ghostId, name: 'Navegador', kind: 'browser' });
    // Envejecer la sesión 31 días a mano.
    (db as any).db.prepare('UPDATE device_sessions SET updated_at = ? WHERE device_id = ?')
      .run(Date.now() - 31 * 24 * 3600 * 1000, ghostId);
    const freshId = uid('fresh');
    db.upsertDeviceSession({ device_id: freshId, name: 'Navegador', kind: 'browser' });
    const listed = buildUnifiedDevices(db, svc([
      { deviceId: freshId, connected: true },
    ]));
    expect(db.getDeviceSession(ghostId)).toBeNull();
    expect(listed.find((d: any) => d.id === ghostId)).toBeFalsy();
    expect(db.getDeviceSession(freshId)).toBeTruthy();
    expect(listed.find((d: any) => d.id === freshId)).toBeTruthy();
    db.deleteDevice(freshId);
    db.deleteDeviceSession(freshId);
  });
});

describe('purgeManualDevices (adiós a los manuales)', () => {
  it('purga filas sin sesión y conserva las respaldadas', () => {
    const manualId = uid('manual');
    db.createDevice({ id: manualId, name: 'Viejo', kind: 'phone', model: null, cols: null, rows: null, hw_path: null } as any);
    const keptId = uid('kept');
    db.createDevice({ id: keptId, name: 'Navegador', kind: 'browser', model: null, cols: null, rows: null, hw_path: null } as any);
    db.upsertDeviceSession({ device_id: keptId, name: 'Navegador', kind: 'browser' });
    const removed = purgeManualDevices(db);
    expect(removed).toContain(manualId);
    expect(removed).not.toContain(keptId);
    expect(db.getDevice(manualId)).toBeNull();
    expect(db.getDevice(keptId)).toBeTruthy();
  });
});

describe('hardware siempre listado y no eliminable', () => {
  const call = (p: string, init?: RequestInit) => {
    const req = new Request(`http://localhost:3001${p}`, init);
    const url = new URL(req.url);
    return handleDevices(req, { url, method: req.method, path: p, db, services: svc() as any });
  };
  const json = (init?: RequestInit & { body?: any }) =>
    ({ ...init, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(init?.body ?? {}) }) as RequestInit;

  it('streamdeck-local siempre aparece aunque no tenga sesión', () => {
    db.deleteDeviceSession('streamdeck-local');
    const listed = buildUnifiedDevices(db, svc([]));
    const hw = listed.find((d: any) => d.id === 'streamdeck-local');
    expect(hw).toBeTruthy();
    expect(hw.source).toBe('hardware');
    expect(hw.kind).toBe('deck');
  });

  it('DELETE del hardware → 403 y forget lo rechaza', async () => {
    const res = await call('/api/v1/devices/streamdeck-local', { method: 'DELETE' });
    expect(res!.status).toBe(403);
    expect(db.getDevice('streamdeck-local')).toBeTruthy();
    expect(forgetDeviceEverywhere(db, svc() as any, 'streamdeck-local').forgotten).toBe(false);
  });

  it('PUT del hardware solo admite renombrar', async () => {
    const bad = await call('/api/v1/devices/streamdeck-local', json({ method: 'PUT', body: { kind: 'phone' } }));
    expect(bad!.status).toBe(400);
    const okRes = await call('/api/v1/devices/streamdeck-local', json({ method: 'PUT', body: { name: 'Mi Deck' } }));
    expect(okRes!.status).toBe(200);
    expect((await okRes!.json()).device.name).toBe('Mi Deck');
    await call('/api/v1/devices/streamdeck-local', json({ method: 'PUT', body: { name: 'Stream Deck' } }));
  });
});

describe('kind browser en API y backup', () => {
  const call = (p: string, init?: RequestInit) => {
    const req = new Request(`http://localhost:3001${p}`, init);
    const url = new URL(req.url);
    return handleDevices(req, { url, method: req.method, path: p, db, services: svc() as any });
  };
  const json = (init?: RequestInit & { body?: any }) =>
    ({ ...init, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(init?.body ?? {}) }) as RequestInit;

  it('POST acepta browser y el backup lo valida', async () => {
    const created = await (await call('/api/v1/devices', json({ method: 'POST', body: { name: 'Móvil salón', kind: 'browser' } })))!.json();
    expect(created.kind).toBe('browser');
    expect(validateBackup(buildBackup(db)).valid).toBe(true);
    await call(`/api/v1/devices/${created.id}`, { method: 'DELETE' });
  });
});

describe('forgetDeviceEverywhere (olvidar = prohibir)', () => {
  it('revoca la sesión LAN vinculada y borra filas', async () => {
    const deviceId = uid('browser');
    db.createDevice({ id: deviceId, name: 'Navegador', kind: 'browser', model: null, cols: null, rows: null, hw_path: null } as any);
    db.upsertDeviceSession({ device_id: deviceId, name: 'Navegador', kind: 'browser' });
    const invite = createLanInvite(db, 'test');
    const redeemed = redeemLanInvite(db, invite.code, { ua: 'test', ip: '192.168.1.2' });
    expect(redeemed.ok).toBe(true);
    bindDeviceToToken(db, 'lan', deviceId, redeemed.token!);

    let disconnected = '';
    const services = { wsManager: { broadcast() {}, disconnectDevice: (id: string) => { disconnected = id; } } };
    const res = forgetDeviceEverywhere(db, services as any, deviceId);
    expect(res.forgotten).toBe(true);
    // Sesión revocada: ya no valida (entrada prohibida).
    expect(validateLanSession(db, redeemed.token!).ok).toBe(false);
    expect(listLanSessions(db).find((s) => s.tokenPrefix === redeemed.token!.slice(0, 8))?.revoked).toBe(true);
    // Filas borradas y WS cerrado.
    expect(db.getDevice(deviceId)).toBeNull();
    expect(db.getDeviceSession(deviceId)).toBeNull();
    expect(boundPrefixForDevice(db, 'lan', deviceId)).toBeNull();
    expect(disconnected).toBe(deviceId);
  });
});
