/**
 * remote-relay-settings.test.ts — URL del relay configurable desde Ajustes.
 *
 * Contrato:
 * - Default: relay público (`DEFAULT_PUBLIC_RELAY_URL`).
 * - `RELAY_URL` en env tiene prioridad sobre el setting.
 * - Setting válido (`ws(s)://`, o `http(s)://` normalizado) → efectivo.
 * - Inválido (`''`, otros esquemas, basura) → 400 y no persiste.
 * - Centinela ('off'/'none'/'disabled') → desactivado ('' efectivo).
 * - `url: null` → borra el setting → vuelve al default.
 * - `GET /status` expone `relay.envOverride`.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ld-remote-relay-settings-'));
process.env.LIBREDECK_DATA_DIR = ROOT;

import { initDatabase, DatabaseService } from '../db';
import { handleRemote } from '../api/remote';
import {
  DEFAULT_PUBLIC_RELAY_URL,
  RELAY_URL_KEY,
  isValidRelayUrl,
  normalizeRelayUrl,
  isRelayDisabledValue,
  resolveRelayUrl,
} from '../remote/public-relay';

let db: DatabaseService;
let services: any;

function makeServices(): any {
  const broadcasts: Array<{ type: string; payload: unknown; topic?: string }> = [];
  return {
    broadcasts,
    wsManager: {
      broadcast: (type: string, payload: unknown, topic?: string) => {
        broadcasts.push({ type, payload, topic });
      },
    },
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
  try {
    for (const k of Object.keys(db.getAllSettings())) {
      if (k.startsWith('remote.')) db.deleteSetting(k);
    }
  } catch { /* sin getAllSettings: nada que purgar */ }
  services = makeServices();
  try { delete (globalThis as any).__libredeckRemote; } catch { /* noop */ }
});

describe('public-relay: validación y normalización', () => {
  it('acepta ws:// y wss://', () => {
    expect(isValidRelayUrl('wss://relay.example.test')).toBe(true);
    expect(isValidRelayUrl('ws://localhost:3003')).toBe(true);
  });

  it('acepta http(s):// solo para normalizar a ws/wss', () => {
    expect(isValidRelayUrl('https://relay.example.test')).toBe(true);
    expect(normalizeRelayUrl('https://relay.example.test')).toBe('wss://relay.example.test/');
    expect(normalizeRelayUrl('http://localhost:3003/x')).toBe('ws://localhost:3003/x');
  });

  it('rechaza resto y cadena vacía', () => {
    expect(isValidRelayUrl('')).toBe(false);
    expect(isValidRelayUrl('   ')).toBe(false);
    expect(isValidRelayUrl(null)).toBe(false);
    expect(isValidRelayUrl(undefined)).toBe(false);
    expect(isValidRelayUrl('ftp://x.test')).toBe(false);
    expect(isValidRelayUrl('relay.example.test')).toBe(false);
    expect(isValidRelayUrl('not a url')).toBe(false);
    expect(normalizeRelayUrl('')).toBeNull();
  });

  it('centinelas: desactivan y son válidas para el PUT', () => {
    for (const s of ['off', 'none', 'disabled', 'OFF']) {
      expect(isRelayDisabledValue(s)).toBe(true);
      expect(isValidRelayUrl(s)).toBe(true);
    }
    expect(isRelayDisabledValue(null)).toBe(false);
    expect(isRelayDisabledValue('wss://x.test')).toBe(false);
  });

  it('null/ausencia = default público; env > setting', () => {
    expect(resolveRelayUrl(db)).toBe(DEFAULT_PUBLIC_RELAY_URL);
    expect(DEFAULT_PUBLIC_RELAY_URL).toBe('wss://relay.bundeck.app');
    db.setSetting(RELAY_URL_KEY, 'wss://relay-settings.example.test');
    expect(resolveRelayUrl(db)).toBe('wss://relay-settings.example.test');
    process.env.RELAY_URL = 'wss://relay-env.example.test';
    expect(resolveRelayUrl(db)).toBe('wss://relay-env.example.test');
    delete process.env.RELAY_URL;
    db.setSetting(RELAY_URL_KEY, 'off');
    expect(resolveRelayUrl(db)).toBe('');
  });
});

describe('remote-relay-settings: PUT /api/v1/remote/relay', () => {
  it('default público sin configuración', async () => {
    const r = await remoteCall(db, services, '/api/v1/remote/status', 'GET');
    expect(r.status).toBe(200);
    expect(r.body.relay.url).toBe('wss://relay.bundeck.app');
    expect(r.body.relay.envOverride).toBe(false);
  });

  it('env override gana y marca envOverride', async () => {
    process.env.RELAY_URL = 'wss://relay-env.example.test';
    const r = await remoteCall(db, services, '/api/v1/remote/status', 'GET');
    expect(r.body.relay.url).toBe('wss://relay-env.example.test');
    expect(r.body.relay.envOverride).toBe(true);
  });

  it('setting custom válido persiste y se refleja en qr', async () => {
    (globalThis as any).__libredeckRemote = {
      relay: { stop: () => {}, start: () => {}, getState: () => 'connected' },
      tunnel: { stop: () => {}, start: () => {} },
    };
    const put = await remoteCall(db, services, '/api/v1/remote/relay', 'PUT', { url: 'wss://relay-custom.example.test' });
    expect(put.status).toBe(200);
    expect(put.body.ok).toBe(true);
    expect(put.body.url).toBe('wss://relay-custom.example.test/');
    expect(db.getSetting(RELAY_URL_KEY)).toBe('wss://relay-custom.example.test/');
    const qr = await remoteCall(db, services, '/api/v1/remote/qr', 'GET');
    expect(qr.body.relayUrl).toBe('wss://relay-custom.example.test/');
    const bc = services.broadcasts.find((b: any) => b.type === 'remote.relay-changed');
    expect(bc).toBeDefined();
  });

  it('normaliza http(s):// a ws/wss al persistir', async () => {
    const put = await remoteCall(db, services, '/api/v1/remote/relay', 'PUT', { url: 'https://relay.example.test' });
    expect(put.status).toBe(200);
    expect(db.getSetting(RELAY_URL_KEY)).toBe('wss://relay.example.test/');
  });

  it('inválida → 400 y no persiste', async () => {
    for (const bad of ['', '   ', 'ftp://x.test', 'notaurl', 'notaurl', 123]) {
      const r = await remoteCall(db, services, '/api/v1/remote/relay', 'PUT', { url: bad });
      expect(r.status).toBe(400);
    }
    expect(db.getSetting(RELAY_URL_KEY)).toBeNull();
    const st = await remoteCall(db, services, '/api/v1/remote/status', 'GET');
    expect(st.body.relay.url).toBe('wss://relay.bundeck.app');
  });

  it('off → desactivado (relay "")', async () => {
    const put = await remoteCall(db, services, '/api/v1/remote/relay', 'PUT', { url: 'off' });
    expect(put.status).toBe(200);
    expect(put.body.url).toBe('');
    const st = await remoteCall(db, services, '/api/v1/remote/status', 'GET');
    expect(st.body.relay.url).toBe('');
    const qr = await remoteCall(db, services, '/api/v1/remote/qr', 'GET');
    expect(qr.body.relayUrl).toBe('');
  });

  it('null → borra el setting y vuelve al default', async () => {
    db.setSetting(RELAY_URL_KEY, 'wss://relay-custom.example.test');
    const put = await remoteCall(db, services, '/api/v1/remote/relay', 'PUT', { url: null });
    expect(put.status).toBe(200);
    expect(put.body.url).toBe('wss://relay.bundeck.app');
    expect(db.getSetting(RELAY_URL_KEY)).toBeNull();
  });
});
