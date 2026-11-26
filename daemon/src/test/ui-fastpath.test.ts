/**
 * ui-fastpath.test.ts — Fast-path LAN pareado (credenciales ui+lan).
 *
 * Cubre (contrato fijo con el relay):
 * - (a) `POST ui-code` devuelve `lan` con invite 128 bits + IPs filtradas/
 *   rankeadas (misma lógica que `QrDialog.getDaemonLanIp`) + puertos + fp/dev.
 * - (b) `publishUiCode` emite `lan` SIN `code` (solo hints) y la
 *   republicación tras reconexión lo conserva; el `code` viaja UNA vez en
 *   el `ui-bind` del approve (post-aprobación).
 * - (c) `/config` (DEV handler) incluye `fp`/`dev` públicos.
 * - (d) Sin IPs → sin campo `lan` (sanitiza en origen).
 *
 * Aislamiento: LIBREDECK_DATA_DIR temporal por test (patrón
 * remote-ui-policy.test.ts). Las IPs se fijan parcheando
 * `require('node:os').networkInterfaces` (ui-policy lo lee dinámico).
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ld-fastpath-test-'));
process.env.LIBREDECK_DATA_DIR = ROOT;

import { initDatabase, DatabaseService } from '../db';
import { handleRemote } from '../api/remote';
import { createDaemonFetch } from '../http/handler';
import { TunnelClient } from '../remote/tunnel';
import {
  buildUiFastPathLan,
  filterAndRankLanIps,
  lanUiPort,
  readUiFastPathLan,
  DEV_FRONTEND_PORT,
} from '../remote/ui-policy';
import { publicIdentity } from '../remote/identity';
import { API_PORT, FRONTEND_PORT } from '../config';

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

async function remoteCall(p: string, method: string, body?: any) {
  const init: RequestInit = { method, headers: { 'content-type': 'application/json' } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const req = new Request(`http://127.0.0.1:3001${p}`, init);
  const { markLanContext } = await import('../http/lan-guard');
  markLanContext(req, { via: 'loopback', peerIp: '127.0.0.1' });
  const res = await handleRemote(req, {
    url: new URL(`http://127.0.0.1:3001${p}`),
    method,
    path: p,
    db,
    services,
  });
  if (!res) throw new Error(`sin handler para ${method} ${p}`);
  let json: any = {};
  try { json = await res.json(); } catch { json = {}; }
  return { status: res.status, body: json };
}

function enableUi(relay = 'wss://relay.example.test') {
  db.setSetting('remote.ui.enabled', '1');
  db.setSetting('remote.relay.url', relay);
}

/** Parchea networkInterfaces (ui-policy lo lee con require dinámico). */
function patchNet(impl: () => Record<string, Array<{ family: string; address: string; internal: boolean }>>): () => void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('node:os') as typeof import('node:os') & { networkInterfaces: () => unknown };
  const orig = mod.networkInterfaces;
  (mod as any).networkInterfaces = impl;
  return () => { (mod as any).networkInterfaces = orig; };
}

function mixedNets(): Record<string, Array<{ family: string; address: string; internal: boolean }>> {
  return {
    eth0: [
      { family: 'IPv4', address: '10.0.0.5', internal: false },
      { family: 'IPv4', address: '192.168.1.50', internal: false },
      { family: 'IPv4', address: '172.20.5.4', internal: false },
      { family: 'IPv4', address: '8.8.8.8', internal: false }, // pública: fuera
      { family: 'IPv6', address: 'fe80::1', internal: false }, // IPv6: fuera
      { family: 'IPv4', address: '127.0.0.1', internal: true }, // loopback: fuera
    ],
  };
}

async function waitFor(cond: () => boolean, timeoutMs = 8000, stepMs = 25): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (cond()) return;
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

beforeEach(async () => {
  const dir = fs.mkdtempSync(path.join(ROOT, 't-'));
  process.env.LIBREDECK_DATA_DIR = dir;
  await initDatabase();
  db = new DatabaseService();
  try {
    for (const k of Object.keys(db.getAllSettings())) {
      if (k.startsWith('remote.')) db.deleteSetting(k);
    }
  } catch { /* noop */ }
  try { delete process.env.RELAY_URL; } catch { /* noop */ }
  services = makeServices();
  try { delete (globalThis as any).__libredeckRemote; } catch { /* noop */ }
});

describe('ui-fastpath: filtro de IPs', () => {
  it('filtra no-RFC1918/loopback/IPv6, rankea 192.168.>10.>172.16-31 y top 4', () => {
    expect(filterAndRankLanIps([])).toEqual([]);
    expect(filterAndRankLanIps(['8.8.8.8', '127.0.0.1', 'fe80::1', '::1'])).toEqual([]);
    // 172.32 no es RFC1918 (rango 16-31): fuera.
    expect(filterAndRankLanIps(['172.32.0.1', '172.31.5.5', '10.1.2.3', '192.168.0.9', '8.8.8.8']))
      .toEqual(['192.168.0.9', '10.1.2.3', '172.31.5.5']);
    expect(filterAndRankLanIps([
      '172.16.0.1', '10.0.0.1', '192.168.0.1', '172.31.255.255', '192.168.0.2', '10.0.0.2',
    ])).toEqual(['192.168.0.1', '192.168.0.2', '10.0.0.1', '10.0.0.2']);
  });

  it('lanUiPort: embebido en prod, Astro en dev (el embebido no escucha en DEV)', () => {
    expect(lanUiPort(false)).toBe(FRONTEND_PORT);
    expect(lanUiPort(true)).toBe(DEV_FRONTEND_PORT);
    expect(DEV_FRONTEND_PORT).toBe(4321);
  });
});

describe('ui-fastpath: POST ui-code con lan', () => {
  it('(a) devuelve lan con invite 128 bits + ips filtradas + puertos + fp/dev; el segundo ui-code reutiliza el lan', async () => {
    const restore = patchNet(mixedNets);
    try {
      enableUi();
      const r = await remoteCall('/api/v1/remote/ui-code', 'POST', {});
      expect(r.status).toBe(200);
      expect(r.body.lan).toBeDefined();
      // Invite LAN 128 bits = 16 bytes en base64url (22 chars).
      expect(r.body.lan.code).toMatch(/^[A-Za-z0-9\-_]{22}$/);
      expect(r.body.lan.ips).toEqual(['192.168.1.50', '10.0.0.5', '172.20.5.4']);
      expect(r.body.lan.port).toBe(FRONTEND_PORT);
      expect(r.body.lan.apiPort).toBe(API_PORT);
      const pub = publicIdentity(db);
      expect(r.body.lan.fp).toBe(pub.fingerprint);
      expect(r.body.lan.dev).toBe(pub.deviceId);
      // Sin secretos en la respuesta (solo invite code + identidad pública).
      expect(JSON.stringify(r.body)).not.toMatch(/priv|secret|sessionToken/i);

      // Segundo ui-code: rota el QR de internet pero reutiliza el lan (>60 s de vida).
      const r2 = await remoteCall('/api/v1/remote/ui-code', 'POST', {});
      expect(r2.status).toBe(200);
      expect(r2.body.urlCode).not.toBe(r.body.urlCode);
      expect(r2.body.lan.code).toBe(r.body.lan.code);
      expect(r2.body.lan.ips).toEqual(r.body.lan.ips);
    } finally {
      restore();
    }
  });

  it('(d) sin IPs → sin campo lan (sanitiza en origen)', async () => {
    const restore = patchNet(() => ({}));
    try {
      enableUi();
      const r = await remoteCall('/api/v1/remote/ui-code', 'POST', {});
      expect(r.status).toBe(200);
      expect('lan' in r.body).toBe(false);
      // Helpers puros: sin IPs no hay lan y no se crea invite.
      expect(buildUiFastPathLan(db, { ips: [] })).toBeUndefined();
      expect(readUiFastPathLan(db, { ips: [] })).toBeUndefined();
    } finally {
      restore();
    }
  });
});

describe('ui-fastpath: tunnel publish + republicación', () => {
  it('(b) ui-publish emite lan SIN code (solo hints) y la reconexión lo conserva', async () => {
    const restore = patchNet(mixedNets);
    let relay: any = null;
    let serverWs: any = null;
    let connectCount = 0;
    const received: any[] = [];
    try {
      enableUi();
      const lan = buildUiFastPathLan(db)!;
      expect(lan).toBeDefined();

      relay = Bun.serve({
        port: 0,
        fetch(req, server) {
          if (server.upgrade(req)) return;
          return new Response('relay-fake', { status: 200 });
        },
        websocket: {
          open(ws: any) { serverWs = ws; connectCount += 1; },
          message(_ws: any, raw: any) {
            try { received.push(JSON.parse(String(raw))); } catch { /* noop */ }
          },
          close() { if (serverWs) serverWs = null; },
        },
      });
      const port = relay.port;
      const mgr: any = { broadcast: () => {} };
      const tunnel = new TunnelClient(db as any, mgr, {
        deviceId: 'dev-fastpath-1',
        relayUrl: `ws://127.0.0.1:${port}`,
      });
      tunnel.start();
      const receivedOf = (kind: string) => received.filter((m) => m?.kind === kind);
      await waitFor(() => receivedOf('tunnel-register').length >= 1);

      const exp = Date.now() + 600_000;
      tunnel.publishUiCode('FAST-URL-1', exp, lan);
      await waitFor(() => receivedOf('ui-publish').some((m) => m.urlCode === 'FAST-URL-1'));
      const first = receivedOf('ui-publish').find((m) => m.urlCode === 'FAST-URL-1')!;
      expect(first.exp).toBe(exp);
      // SEGURIDAD post-aprobación: el wire pre-aprobación lleva SOLO hints.
      expect(first.lan).toBeDefined();
      expect('code' in first.lan).toBe(false);
      expect(first.lan).toMatchObject({ ips: lan.ips, port: FRONTEND_PORT, apiPort: API_PORT });
      const pub = publicIdentity(db);
      expect(first.lan.fp).toBe(pub.fingerprint);
      expect(first.lan.dev).toBe(pub.deviceId);
      // En memoria sí se conserva el code (DB local) para republicar hints.
      const mem = tunnel.publishedCodes().find((p) => p.urlCode === 'FAST-URL-1')!;
      expect(mem.lan?.code).toBe(lan.code);

      // Fuerza reconexión desde el relay: el onopen loop debe republicar los mismos hints.
      received.length = 0;
      const before = connectCount;
      (tunnel as any).backoffMs = 50;
      try { (serverWs as any)?.close(); } catch { /* noop */ }
      await waitFor(() => connectCount > before, 10000);
      await waitFor(() => receivedOf('ui-publish').some((m) => m.urlCode === 'FAST-URL-1'), 10000);
      const repub = receivedOf('ui-publish').find((m) => m.urlCode === 'FAST-URL-1')!;
      expect('code' in repub.lan).toBe(false);
      expect(repub.lan).toEqual(first.lan);
      tunnel.stop();
    } finally {
      try { relay?.stop?.(true); } catch { /* noop */ }
      restore();
    }
  }, 20000);

  it('(b2) approve con túnel emite ui-bind CON lan.code válido + ips/puertos/fp', async () => {
    const restore = patchNet(mixedNets);
    let relay: any = null;
    const received: any[] = [];
    try {
      enableUi();
      relay = Bun.serve({
        port: 0,
        fetch(req, server) {
          if (server.upgrade(req)) return;
          return new Response('relay-fake', { status: 200 });
        },
        websocket: {
          open() {},
          message(_ws: any, raw: any) {
            try { received.push(JSON.parse(String(raw))); } catch { /* noop */ }
          },
        },
      });
      const mgr: any = { broadcast: () => {} };
      const tunnel = new TunnelClient(db as any, mgr, {
        deviceId: 'dev-fastpath-2',
        relayUrl: `ws://127.0.0.1:${relay.port}`,
      });
      tunnel.start();
      const receivedOf = (kind: string) => received.filter((m) => m?.kind === kind);
      await waitFor(() => receivedOf('tunnel-register').length >= 1);

      const exp = Date.now() + 600_000;
      (tunnel as any).enqueuePending({
        reqId: 'req-approve-lan',
        urlCode: 'FAST-URL-APPROVE',
        ua: 'U',
        ip: '1.2.3.4',
        receivedAt: Date.now(),
        expiresAt: Date.now() + 120_000,
      });
      const d = tunnel.decideUiRequest('req-approve-lan', true, exp);
      expect(d.ok).toBe(true);
      expect(d.allowed).toBe(true);
      await waitFor(() => receivedOf('ui-bind').length >= 1);
      const bind = receivedOf('ui-bind').find((m) => m.urlCode === 'FAST-URL-APPROVE')!;
      expect(bind).toBeDefined();
      // El ui-bind SÍ lleva el invite LAN 128 bits + alcanzabilidad.
      expect(bind.lan).toBeDefined();
      expect(bind.lan.code).toMatch(/^[A-Za-z0-9\-_]{22}$/);
      expect(bind.lan.ips).toEqual(['192.168.1.50', '10.0.0.5', '172.20.5.4']);
      expect(bind.lan.port).toBe(FRONTEND_PORT);
      expect(bind.lan.apiPort).toBe(API_PORT);
      const pub = publicIdentity(db);
      expect(bind.lan.fp).toBe(pub.fingerprint);
      // El retorno (para tests) incluye el mismo lan del wire.
      expect(d.lan?.code).toBe(bind.lan.code);
      tunnel.stop();
    } finally {
      try { relay?.stop?.(true); } catch { /* noop */ }
      restore();
    }
  }, 20000);
});

describe('ui-fastpath: /config con identidad pública', () => {
  it('(c) incluye fp/dev (ya públicos en QR/status)', async () => {
    const fetchFn = createDaemonFetch({
      wsManager: { broadcast: () => {} } as any,
      pluginLoader: {} as any,
      actionRunner: { executeAction: async () => ({ success: true }) } as any,
      windowWatcher: {} as any,
    });
    const res = await fetchFn(new Request('http://localhost:3001/config'));
    expect(res.status).toBe(200);
    const body = await res.json();
    const pub = publicIdentity(db);
    expect(body.fp).toBe(pub.fingerprint);
    expect(body.dev).toBe(pub.deviceId);
    expect(body.apiPort).toBe(API_PORT);
    expect(body.frontendPort).toBe(FRONTEND_PORT);
    expect(typeof body.wsPort).toBe('number');
  });
});
