/**
 * remote-qr.test.ts — GET /api/v1/remote/qr (emparejamiento por QR).
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ld-remote-qr-test-'));
process.env.LIBREDECK_DATA_DIR = ROOT;

import { initDatabase, DatabaseService } from '../db';
import { handleRemote } from '../api/remote';
import { generateKeyPair, resetLocalSeq, resetReplay, configureReplayStore } from '../remote/crypto';

let db: DatabaseService;
let services: any;

function makeServices(): any {
  return {
    wsManager: { broadcast: () => {} },
    actionRunner: { executeAction: async (a: any) => ({ success: true, action: a?.type ?? '?' }) },
    pluginLoader: {},
    windowWatcher: {},
  };
}

async function remoteCall(d: DatabaseService, s: any, p: string, method: string, body?: any) {
  const init: RequestInit = { method, headers: { 'content-type': 'application/json' } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const req = new Request(`http://localhost:3001${p}`, init);
  const res = await handleRemote(req, {
    url: new URL(`http://localhost:3001${p}`),
    method,
    path: p,
    db: d,
    services: s,
  });
  if (!res) throw new Error(`sin handler para ${method} ${p}`);
  let json: any = {};
  try { json = await res.json(); } catch { json = {}; }
  return { status: res.status, body: json };
}

beforeEach(async () => {
  const dir = fs.mkdtempSync(path.join(ROOT, 't-'));
  process.env.LIBREDECK_DATA_DIR = dir;
  delete process.env.RELAY_URL;
  await initDatabase();
  db = new DatabaseService();
  services = makeServices();
  resetReplay();
  resetLocalSeq();
  configureReplayStore({
    getSeq: () => -1,
    setSeq: () => {},
    hasNonce: () => false,
    addNonce: () => {},
  });
  try { delete (globalThis as any).__libredeckRemote; } catch { /* noop */ }
});

describe('remote-qr: GET /qr', () => {
  it('devuelve todos los campos y qr parseable con v:1', async () => {
    const r = await remoteCall(db, services, '/api/v1/remote/qr', 'GET');
    expect(r.status).toBe(200);
    for (const k of ['code', 'fingerprint', 'deviceId', 'publicKey', 'expiresAt', 'relayUrl', 'qr']) {
      expect(r.body[k], `campo ${k}`).toBeDefined();
    }
    expect(r.body.code).toMatch(/^\d{6}$/);
    expect(typeof r.body.qr).toBe('string');
    // Sin secretos en el QR: solo identidad pública + código.
    expect(r.body.qr).not.toMatch(/priv|secret|token/i);

    const payload = JSON.parse(r.body.qr);
    expect(payload.v).toBe(1);
    expect(payload.code).toMatch(/^\d{6}$/);
    expect(payload.code).toBe(r.body.code);
    expect(payload.dev).toBe(r.body.deviceId);
    expect(payload.pub).toBe(r.body.publicKey);
    expect(payload.fp).toBe(r.body.fingerprint);
    expect(typeof payload.exp).toBe('number');
    expect(payload.exp).toBeGreaterThan(Date.now());
    expect(Math.abs(payload.exp - r.body.expiresAt)).toBeLessThan(1000);
    expect(typeof payload.relay).toBe('string');
  });

  it('flujo completo: qr → pair-accept acepta el code; segundo uso → 400', async () => {
    const qr = await remoteCall(db, services, '/api/v1/remote/qr', 'GET');
    expect(qr.status).toBe(200);
    const payload = JSON.parse(qr.body.qr as string);
    const kp = generateKeyPair();
    const peerId = `peer-${Math.random().toString(36).slice(2, 8)}`;

    const acc = await remoteCall(db, services, '/api/v1/remote/pair-accept', 'POST', {
      code: payload.code, remoteDeviceId: peerId, remotePubKey: kp.publicKeyB64, name: 'Móvil',
    });
    expect(acc.status).toBe(200);
    expect(acc.body.ok).toBe(true);
    // Pending consumido (un solo uso)
    expect(db.getSetting(`remote.pending.${payload.code}`)).toBeNull();

    // Segundo uso del mismo code con identidad válida → 400 (ya utilizado)
    const kp2 = generateKeyPair();
    const reuse = await remoteCall(db, services, '/api/v1/remote/pair-accept', 'POST', {
      code: payload.code, remoteDeviceId: `peer-otro`, remotePubKey: kp2.publicKeyB64,
    });
    expect(reuse.status).toBe(400);
    expect(String(reuse.body.error)).toMatch(/utilizado/i);
  });

  it('relay público por defecto; override por env/setting; "" explícito lo desactiva', async () => {
    // Sin configuración → relay público por defecto
    const def = await remoteCall(db, services, '/api/v1/remote/qr', 'GET');
    expect(def.status).toBe(200);
    expect(def.body.relayUrl).toBe('wss://bundeck.mikelgranero.com');
    expect(JSON.parse(def.body.qr as string).relay).toBe('wss://bundeck.mikelgranero.com');

    // Con RELAY_URL en env → se propaga a relayUrl y al payload
    process.env.RELAY_URL = 'wss://relay.example.test';
    const full = await remoteCall(db, services, '/api/v1/remote/qr', 'GET');
    expect(full.body.relayUrl).toBe('wss://relay.example.test');
    expect(JSON.parse(full.body.qr as string).relay).toBe('wss://relay.example.test');
    delete process.env.RELAY_URL;

    // Con setting remote.relay.url → también se propaga
    db.setSetting('remote.relay.url', 'wss://relay-settings.example.test');
    const viaSetting = await remoteCall(db, services, '/api/v1/remote/qr', 'GET');
    expect(viaSetting.body.relayUrl).toBe('wss://relay-settings.example.test');
    expect(JSON.parse(viaSetting.body.qr as string).relay).toBe('wss://relay-settings.example.test');

    // Setting a cadena vacía explícita → desactivado ("")
    db.setSetting('remote.relay.url', '');
    const off = await remoteCall(db, services, '/api/v1/remote/qr', 'GET');
    expect(off.status).toBe(200);
    expect(off.body.relayUrl).toBe('');
    expect(JSON.parse(off.body.qr as string).relay).toBe('');
  });
});
