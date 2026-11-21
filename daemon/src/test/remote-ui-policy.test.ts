/**
 * remote-ui-policy.test.ts — Política de acceso a la UI remota.
 *
 * Cubre: default deshabilitado (403), enable → code+url (https derivada de
 * wss), pending vacío/lleno, allow (token una sola vez + consume urlCode),
 * deny, sessions sin token completo, revoke, expiración de sesión y logs.
 *
 * Aislamiento: LIBREDECK_DATA_DIR temporal por test (patrón
 * remote-api.test.ts).
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ld-remote-ui-test-'));
process.env.LIBREDECK_DATA_DIR = ROOT;

import { initDatabase, DatabaseService } from '../db';
import { handleRemote } from '../api/remote';
import {
  enqueueUiRequest, validateUiSession, clearUiPendingForTests,
} from '../remote/ui-policy';

let db: DatabaseService;
let services: any;
let broadcasts: any[];

function makeServices(): any {
  return {
    wsManager: { broadcast: (event: string, payload: any, topic?: string) => { broadcasts.push({ event, payload, topic }); } },
    actionRunner: { executeAction: async (a: any) => ({ success: true, action: a?.type ?? '?' }) },
    pluginLoader: {},
    windowWatcher: {},
  };
}

async function remoteCall(p: string, method: string, body?: any) {
  const init: RequestInit = { method, headers: { 'content-type': 'application/json' } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const req = new Request(`http://localhost:3001${p}`, init);
  const res = await handleRemote(req, {
    url: new URL(`http://localhost:3001${p}`),
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

function enableUi(relay = 'wss://relay.example.com') {
  db.setSetting('remote.ui.enabled', '1');
  db.setSetting('remote.relay.url', relay);
}

beforeEach(async () => {
  const dir = fs.mkdtempSync(path.join(ROOT, 't-'));
  process.env.LIBREDECK_DATA_DIR = dir;
  await initDatabase();
  db = new DatabaseService();
  // Aislamiento: en suite completa `action-runner.test.ts` instala un
  // mock global de `../db` con un Map compartido (ver su cabecera), así que
  // la DB "fresca" no basta: se purgan las claves del módulo.
  try {
    for (const k of Object.keys(db.getAllSettings())) {
      if (k.startsWith('remote.ui.') || k === 'remote.relay.url') db.deleteSetting(k);
    }
  } catch { /* sin getAllSettings: nada que purgar */ }
  try { delete process.env.RELAY_URL; } catch { /* noop */ }
  broadcasts = [];
  services = makeServices();
  clearUiPendingForTests();
  try { delete (globalThis as any).__libredeckRemote; } catch { /* noop */ }
});

describe('remote-ui: default deshabilitado', () => {
  it('ui-code / ui-pending / ui-sessions / allow / deny → 403', async () => {
    expect((await remoteCall('/api/v1/remote/ui-code', 'POST', {})).status).toBe(403);
    expect((await remoteCall('/api/v1/remote/ui-pending', 'GET')).status).toBe(403);
    expect((await remoteCall('/api/v1/remote/ui-sessions', 'GET')).status).toBe(403);
    expect((await remoteCall('/api/v1/remote/ui-pending/x/allow', 'POST', {})).status).toBe(403);
    expect((await remoteCall('/api/v1/remote/ui-pending/x/deny', 'POST', {})).status).toBe(403);
    expect((await remoteCall('/api/v1/remote/ui-code', 'DELETE')).status).toBe(403);
    expect((await remoteCall('/api/v1/remote/ui-sessions/abcd', 'DELETE')).status).toBe(403);
  });
});

describe('remote-ui: toggle maestro', () => {
  it('POST /ui-enabled {enabled} → {ok, uiEnabled} y persiste; PUT alias; 400 sin boolean', async () => {
    let r = await remoteCall('/api/v1/remote/ui-enabled', 'POST', { enabled: true });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, uiEnabled: true });
    expect(db.getSetting('remote.ui.enabled')).toBe('1');
    expect((await remoteCall('/api/v1/remote/ui-code', 'POST', {})).status).toBe(200);

    r = await remoteCall('/api/v1/remote/ui-enabled', 'PUT', { enabled: false });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, uiEnabled: false });
    expect(db.getSetting('remote.ui.enabled')).toBe('0');
    expect((await remoteCall('/api/v1/remote/ui-code', 'POST', {})).status).toBe(403);

    expect((await remoteCall('/api/v1/remote/ui-enabled', 'POST', {})).status).toBe(400);
    expect((await remoteCall('/api/v1/remote/ui-enabled', 'POST', { enabled: 'yes' })).status).toBe(400);
  });

  it('GET /status incluye uiEnabled', async () => {
    let s = await remoteCall('/api/v1/remote/status', 'GET');
    expect(s.status).toBe(200);
    expect(s.body.uiEnabled).toBe(false);
    await remoteCall('/api/v1/remote/ui-enabled', 'POST', { enabled: true });
    s = await remoteCall('/api/v1/remote/status', 'GET');
    expect(s.body.uiEnabled).toBe(true);
  });
});

describe('remote-ui: código + url', () => {
  it('enable → code (6 dígitos) + urlCode (12 url-safe) + url https + expiresAt', async () => {
    enableUi();
    const r = await remoteCall('/api/v1/remote/ui-code', 'POST', {});
    expect(r.status).toBe(200);
    expect(r.body.code).toMatch(/^\d{6}$/);
    expect(r.body.urlCode).toMatch(/^[A-Za-z0-9\-_]{12}$/);
    expect(r.body.url).toBe(`https://relay.example.com/ui/${r.body.urlCode}`);
    expect(r.body.expiresAt).toBeGreaterThan(Date.now());
  });

  it('url https derivada de wss; ws→http; sin relay → url vacía', async () => {
    enableUi('wss://relay.example.com/');
    let r = await remoteCall('/api/v1/remote/ui-code', 'POST', {});
    expect(r.body.url.startsWith('https://relay.example.com/ui/')).toBe(true);

    enableUi('ws://lan.local:8080/path');
    r = await remoteCall('/api/v1/remote/ui-code', 'POST', {});
    expect(r.body.url.startsWith('http://lan.local:8080/path/ui/')).toBe(true);

    enableUi('');
    r = await remoteCall('/api/v1/remote/ui-code', 'POST', {});
    expect(r.body.url).toBe('');
  });

  it('DELETE ui-code revoca el vigente (segundo DELETE → revoked:false)', async () => {
    enableUi();
    await remoteCall('/api/v1/remote/ui-code', 'POST', {});
    const d1 = await remoteCall('/api/v1/remote/ui-code', 'DELETE');
    expect(d1.body).toMatchObject({ ok: true, revoked: true });
    const d2 = await remoteCall('/api/v1/remote/ui-code', 'DELETE');
    expect(d2.body).toMatchObject({ ok: true, revoked: false });
  });
});

describe('remote-ui: pendientes + aprobación', () => {
  it('pending vacío → []; tras enqueue (tunnel-client) → lleno con ua/ip', async () => {
    enableUi();
    const c = await remoteCall('/api/v1/remote/ui-code', 'POST', {});
    let p = await remoteCall('/api/v1/remote/ui-pending', 'GET');
    expect(p.body.pending).toEqual([]);

    const q = enqueueUiRequest(db, { urlCode: c.body.urlCode, ua: 'Mobile Safari', ip: '10.0.0.5' });
    expect(q.reqId).toBeTruthy();

    p = await remoteCall('/api/v1/remote/ui-pending', 'GET');
    expect(p.body.pending.length).toBe(1);
    expect(p.body.pending[0]).toMatchObject({ reqId: q.reqId, urlCode: c.body.urlCode, ua: 'Mobile Safari', ip: '10.0.0.5' });
  });

  it('allow genera sessionToken (32B hex) una vez + consume urlCode', async () => {
    enableUi();
    const c = await remoteCall('/api/v1/remote/ui-code', 'POST', {});
    const q = enqueueUiRequest(db, { urlCode: c.body.urlCode, ua: 'u', ip: '1.2.3.4' });

    const a = await remoteCall(`/api/v1/remote/ui-pending/${q.reqId}/allow`, 'POST', {});
    expect(a.status).toBe(200);
    expect(a.body.ok).toBe(true);
    expect(a.body.sessionToken).toMatch(/^[0-9a-f]{64}$/);
    expect(validateUiSession(db, a.body.sessionToken).ok).toBe(true);

    // El mismo reqId ya no existe (404) y el urlCode quedó consumido:
    // un segundo navegador con el mismo código es denegado/expirado.
    const again = await remoteCall(`/api/v1/remote/ui-pending/${q.reqId}/allow`, 'POST', {});
    expect(again.status).toBe(404);
    expect(() => enqueueUiRequest(db, { urlCode: c.body.urlCode, ua: 'u2', ip: '5.6.7.8' }))
      .toThrow(/denegado o expirado/i);
  });

  it('deny → {ok} sin crear sesión (store local, sin túnel)', async () => {
    enableUi();
    const c = await remoteCall('/api/v1/remote/ui-code', 'POST', {});
    const q = enqueueUiRequest(db, { urlCode: c.body.urlCode, ua: 'u', ip: '9.9.9.9' });

    const d = await remoteCall(`/api/v1/remote/ui-pending/${q.reqId}/deny`, 'POST', {});
    expect(d.body).toMatchObject({ ok: true });

    const s = await remoteCall('/api/v1/remote/ui-sessions', 'GET');
    expect(s.body.sessions).toEqual([]);
    // deny de reqId inexistente → 404
    expect((await remoteCall('/api/v1/remote/ui-pending/nope/deny', 'POST', {})).status).toBe(404);
  });

  it('código caducado → enqueue denegado + auditoría', async () => {
    enableUi();
    const c = await remoteCall('/api/v1/remote/ui-code', 'POST', {});
    const raw = JSON.parse(db.getSetting('remote.ui.code')!);
    raw.expiresAt = Date.now() - 1000;
    db.setSetting('remote.ui.code', JSON.stringify(raw));
    expect(() => enqueueUiRequest(db, { urlCode: c.body.urlCode }))
      .toThrow(/denegado o expirado/i);
    const logs = db.getLogs(50).map((l) => l.message).join('\n');
    expect(logs).toMatch(/caducado/i);
  });
});

describe('remote-ui: delegación al TunnelClient', () => {
  const TUN_TOKEN = 'ab'.repeat(32); // 64 hex

  function fakeTunnel(urlCode: string) {
    const decisions: any[] = [];
    const t: any = {
      decisions,
      pendings: [
        { reqId: 'tun-1', urlCode, ua: 'TunUA', ip: '7.7.7.7', receivedAt: Date.now(), expiresAt: Date.now() + 60000 },
      ],
      published: [] as any[],
      revoked: [] as string[],
      getPending() { return this.pendings; },
      decideUiRequest(reqId: string, allow: boolean, _exp?: number) {
        const i = this.pendings.findIndex((p: any) => p.reqId === reqId);
        if (i < 0) return { ok: false, allowed: false, error: 'reqId desconocido' };
        const [hit] = this.pendings.splice(i, 1);
        decisions.push({ reqId, allow, urlCode: hit.urlCode });
        if (!allow) return { ok: true, allowed: false };
        return { ok: true, allowed: true, sessionToken: TUN_TOKEN };
      },
      publishUiCode(urlCode: string, exp: number) { this.published.push({ urlCode, exp }); },
      unpublishUiCode(urlCode: string) { this.published = this.published.filter((p: any) => p.urlCode !== urlCode); },
      revokeUiSession(token: string) { this.revoked.push(token); return true; },
    };
    return t;
  }

  it('allow usa el túnel (ui-decision+ui-bind), persiste la sesión y consume el código', async () => {
    enableUi();
    const c = await remoteCall('/api/v1/remote/ui-code', 'POST', {});
    const tunnel = fakeTunnel(c.body.urlCode);
    // El ui-code recién creado se publicó en el relay al generarse.
    (globalThis as any).__libredeckRemote = { tunnel };
    tunnel.published.push({ urlCode: c.body.urlCode, exp: c.body.expiresAt });

    // El pendiente del túnel sale en el listado (receivedAt → createdAt).
    const p = await remoteCall('/api/v1/remote/ui-pending', 'GET');
    expect(p.body.pending).toEqual([
      { reqId: 'tun-1', urlCode: c.body.urlCode, ua: 'TunUA', ip: '7.7.7.7', createdAt: expect.any(Number) },
    ]);

    const a = await remoteCall('/api/v1/remote/ui-pending/tun-1/allow', 'POST', {});
    expect(a.body).toMatchObject({ ok: true, sessionToken: TUN_TOKEN });
    expect(tunnel.decisions).toContainEqual({ reqId: 'tun-1', allow: true, urlCode: c.body.urlCode });
    // Sesión persistida en settings (visible para /ui-sessions y validate).
    expect(validateUiSession(db, TUN_TOKEN)).toMatchObject({ ok: true });

    // urlCode de un solo uso: consumido en settings y retirado del relay.
    expect(db.getSetting('remote.ui.code')).toBeNull();
    expect(tunnel.published.some((x: any) => x.urlCode === c.body.urlCode)).toBe(false);

    // Revocar por prefijo pide unbind al túnel con el token completo.
    const del = await remoteCall(`/api/v1/remote/ui-sessions/${TUN_TOKEN.slice(0, 8)}`, 'DELETE');
    expect(del.body).toMatchObject({ ok: true });
    expect(tunnel.revoked).toEqual([TUN_TOKEN]);
    expect(validateUiSession(db, TUN_TOKEN).ok).toBe(false);
  });

  it('deny usa el túnel (ui-decision deny) sin crear sesión', async () => {
    enableUi();
    const c = await remoteCall('/api/v1/remote/ui-code', 'POST', {});
    const tunnel = fakeTunnel(c.body.urlCode);
    (globalThis as any).__libredeckRemote = { tunnel };

    const d = await remoteCall('/api/v1/remote/ui-pending/tun-1/deny', 'POST', {});
    expect(d.body).toMatchObject({ ok: true });
    expect(tunnel.decisions).toContainEqual({ reqId: 'tun-1', allow: false, urlCode: c.body.urlCode });
    const s = await remoteCall('/api/v1/remote/ui-sessions', 'GET');
    expect(s.body.sessions).toEqual([]);
  });
});

describe('remote-ui: sesiones', () => {
  it('listado sin token completo (solo prefijo 8) + revoke por prefijo', async () => {
    enableUi();
    const c = await remoteCall('/api/v1/remote/ui-code', 'POST', {});
    const q = enqueueUiRequest(db, { urlCode: c.body.urlCode, ua: 'u', ip: '1.1.1.1' });
    const a = await remoteCall(`/api/v1/remote/ui-pending/${q.reqId}/allow`, 'POST', {});
    const token = a.body.sessionToken as string;

    const s = await remoteCall('/api/v1/remote/ui-sessions', 'GET');
    expect(s.body.sessions.length).toBe(1);
    const row = s.body.sessions[0];
    expect(row.tokenPrefix).toBe(token.slice(0, 8));
    expect(JSON.stringify(s.body)).not.toContain(token);

    const del = await remoteCall(`/api/v1/remote/ui-sessions/${row.tokenPrefix}`, 'DELETE');
    expect(del.body).toMatchObject({ ok: true, revoked: row.tokenPrefix });
    expect(validateUiSession(db, token).ok).toBe(false);

    const s2 = await remoteCall('/api/v1/remote/ui-sessions', 'GET');
    expect(s2.body.sessions[0].revoked).toBe(true);
    // prefijo desconocido → 404
    expect((await remoteCall('/api/v1/remote/ui-sessions/deadbeef', 'DELETE')).status).toBe(404);
  });

  it('sesión expirada (exp manipulado) → inválida + log de uso expirado', async () => {
    enableUi();
    const c = await remoteCall('/api/v1/remote/ui-code', 'POST', {});
    const q = enqueueUiRequest(db, { urlCode: c.body.urlCode, ua: 'u', ip: '2.2.2.2' });
    const a = await remoteCall(`/api/v1/remote/ui-pending/${q.reqId}/allow`, 'POST', {});
    const token = a.body.sessionToken as string;

    const raw = JSON.parse(db.getSetting(`remote.ui.session.${token}`)!);
    raw.exp = Date.now() - 1000;
    db.setSetting(`remote.ui.session.${token}`, JSON.stringify(raw));

    expect(validateUiSession(db, token)).toMatchObject({ ok: false, reason: 'expirada' });
    const logs = db.getLogs(50).map((l) => l.message).join('\n');
    expect(logs).toMatch(/expirada/i);
  });

  it('eventos auditan (ui-code, aprobación, denegación, revocación) + broadcast topic remote', async () => {
    enableUi();
    await remoteCall('/api/v1/remote/ui-code', 'POST', {});
    const c2 = await remoteCall('/api/v1/remote/ui-code', 'POST', {});
    const q1 = enqueueUiRequest(db, { urlCode: c2.body.urlCode, ua: 'a', ip: '3.3.3.3' });
    await remoteCall(`/api/v1/remote/ui-pending/${q1.reqId}/allow`, 'POST', {});
    const c3 = await remoteCall('/api/v1/remote/ui-code', 'POST', {});
    const q2 = enqueueUiRequest(db, { urlCode: c3.body.urlCode, ua: 'b', ip: '4.4.4.4' });
    await remoteCall(`/api/v1/remote/ui-pending/${q2.reqId}/deny`, 'POST', {});
    const s = await remoteCall('/api/v1/remote/ui-sessions', 'GET');
    await remoteCall(`/api/v1/remote/ui-sessions/${s.body.sessions[0].tokenPrefix}`, 'DELETE');

    const msgs = db.getLogs(100).map((l) => l.message).join('\n');
    expect(msgs).toMatch(/código UI creado/);
    expect(msgs).toMatch(/aprobado/);
    expect(msgs).toMatch(/denegado/);
    expect(msgs).toMatch(/revocada/);

    const topics = new Set(broadcasts.map((b) => b.topic));
    expect(topics.has('remote')).toBe(true);
    const events = broadcasts.map((b) => b.event).join(' ');
    expect(events).toMatch(/remote\.ui-code/);
    expect(events).toMatch(/remote\.ui-allowed/);
    expect(events).toMatch(/remote\.ui-denied/);
    expect(events).toMatch(/remote\.ui-revoked/);
  });
});
