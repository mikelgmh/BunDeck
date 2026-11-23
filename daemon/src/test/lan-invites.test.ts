/**
 * lan-invites.test.ts — Control de acceso LAN solo-por-invitación.
 *
 * Cubre:
 * - Invitación: crear (anfitrión), canje de un solo uso, reutilización
 *   denegada, caducidad denegada, revocación de invitación.
 * - Sesiones: validez (header/cookie/query), caducidad, revocación por
 *   prefijo, listado sin token completo.
 * - Guard HTTP: directo sin token → 401 (API) / 403 HTML "sin permiso" (UI);
 *   localhost exento; túnel exento; públicas abiertas (health/config/ips);
 *   gestión solo-loopback (invitado válido → 403).
 * - Rate-limit de canje: 11º intento en la ventana → 429.
 * - WS: cuarentena hasta `hello` (subscribe → error LAN_INVITE_REQUIRED),
 *   `hello` sin nada → error, `hello` con código → session.state con
 *   lanAuthed, `hello` con sesión → OK; localhost exento.
 *
 * Aislamiento: LIBREDECK_DATA_DIR temporal por test (patrón
 * remote-ui-policy.test.ts) + purga de claves `remote.lan.*`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ld-lan-test-'));
process.env.LIBREDECK_DATA_DIR = ROOT;

import { initDatabase, DatabaseService } from '../db';
import { handleRemote } from '../api/remote';
import {
  createLanInvite,
  redeemLanInvite,
  revokeLanInvite,
  getLanInviteMeta,
  validateLanSession,
  listLanSessions,
  revokeLanSessionByPrefix,
  clearLanForTests,
  LAN_SESSION_TTL_MS,
} from '../remote/lan-invites';
import {
  evaluateLanAccess,
  lanDeniedResponse,
  isLoopbackIp,
  hasValidLanSession,
  resetLanRedeemLimiter,
  LAN_DENIED_CODE,
} from '../http/lan-guard';
import { WebSocketManager } from '../ws';

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
  const req = new Request(`http://127.0.0.1:3001${p}`, init);
  // El handler HTTP marca el contexto antes de rutear: aquí se simula
  // (loopback → anfitrión).
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
  const text = await res.text();
  try { json = text ? JSON.parse(text) : {}; } catch { json = { _raw: text }; }
  return { status: res.status, body: json, headers: res.headers };
}

function lanReq(pathname: string, opts?: { token?: string; code?: string; cookie?: string; method?: string }): Request {
  const url = new URL(`http://192.168.1.20:3001${pathname}`);
  if (opts?.code) url.searchParams.set('invite', opts.code);
  else if (opts?.token && (opts.method ?? 'GET') === 'GET' && pathname === '/') url.searchParams.set('invite', opts.token);
  const headers: Record<string, string> = {};
  if (opts?.token && pathname.startsWith('/api/')) headers['authorization'] = `Bearer ${opts.token}`;
  if (opts?.cookie) headers['cookie'] = opts.cookie;
  return new Request(url.toString(), { method: opts?.method ?? 'GET', headers });
}

beforeEach(async () => {
  const dir = fs.mkdtempSync(path.join(ROOT, 't-'));
  process.env.LIBREDECK_DATA_DIR = dir;
  await initDatabase();
  db = new DatabaseService();
  try {
    for (const k of Object.keys(db.getAllSettings())) {
      if (k.startsWith('remote.lan.') || k.startsWith('remote.ui.') || k === 'remote.relay.url') db.deleteSetting(k);
    }
  } catch { /* noop */ }
  try { delete process.env.RELAY_URL; } catch { /* noop */ }
  broadcasts = [];
  services = makeServices();
  resetLanRedeemLimiter();
  try { delete (globalThis as any).__libredeckWs; } catch { /* noop */ }
  clearLanForTests(db);
});

describe('lan-invites: ciclo de invitación', () => {
  it('crear → canjear (un solo uso) → sesión válida', () => {
    const inv = createLanInvite(db, 'móvil');
    expect(inv.code.length).toBeGreaterThanOrEqual(16);
    expect(getLanInviteMeta(db).present).toBe(true);
    const r = redeemLanInvite(db, inv.code, { ua: 'test', ip: '192.168.1.20' });
    expect(r.ok).toBe(true);
    expect(r.token!.length).toBe(64);
    expect(validateLanSession(db, r.token!).ok).toBe(true);
    // Invitación consumida: ya no hay vigente.
    expect(getLanInviteMeta(db).present).toBe(false);
  });

  it('reutilizar el código → denegado', () => {
    const inv = createLanInvite(db);
    expect(redeemLanInvite(db, inv.code).ok).toBe(true);
    const again = redeemLanInvite(db, inv.code);
    expect(again.ok).toBe(false);
  });

  it('código caducado → denegado', () => {
    const inv = createLanInvite(db);
    db.setSetting('remote.lan.invite', JSON.stringify({ ...inv, expiresAt: Date.now() - 1000 }));
    expect(redeemLanInvite(db, inv.code).ok).toBe(false);
    expect(getLanInviteMeta(db).present).toBe(false);
  });

  it('código desconocido → denegado', () => {
    expect(redeemLanInvite(db, 'AAAAAAAAAAAAAAAAAAAAAA').ok).toBe(false);
  });

  it('revocar invitación impide el canje', () => {
    const inv = createLanInvite(db);
    expect(revokeLanInvite(db)).toBe(true);
    expect(redeemLanInvite(db, inv.code).ok).toBe(false);
    expect(revokeLanInvite(db)).toBe(false);
  });

  it('generar sustituye a la anterior', () => {
    const a = createLanInvite(db);
    const b = createLanInvite(db);
    expect(b.code).not.toBe(a.code);
    expect(redeemLanInvite(db, a.code).ok).toBe(false);
    expect(redeemLanInvite(db, b.code).ok).toBe(true);
  });
});

describe('lan-invites: sesiones', () => {
  it('caducidad y revocación → denegadas; listado sin secreto', () => {
    const inv = createLanInvite(db);
    const r = redeemLanInvite(db, inv.code, { ua: 'Móvil', ip: '10.0.0.5', label: 'pepe' });
    const token = r.token!;
    const list = listLanSessions(db);
    expect(list).toHaveLength(1);
    expect(list[0].tokenPrefix).toBe(token.slice(0, 8));
    expect(JSON.stringify(list)).not.toContain(token);
    expect(list[0].ua).toBe('Móvil');
    expect(list[0].label).toBe('pepe');
    // Caducada.
    const raw = db.getSetting(`remote.lan.session.${token}`)!;
    db.setSetting(`remote.lan.session.${token}`, JSON.stringify({ ...JSON.parse(raw), exp: Date.now() - 1000 }));
    expect(validateLanSession(db, token).ok).toBe(false);
    // Revocada.
    const inv2 = createLanInvite(db);
    const r2 = redeemLanInvite(db, inv2.code);
    expect(validateLanSession(db, r2.token!).ok).toBe(true);
    expect(revokeLanSessionByPrefix(db, r2.token!.slice(0, 8))).toBe(true);
    expect(validateLanSession(db, r2.token!).ok).toBe(false);
    expect(revokeLanSessionByPrefix(db, 'deadbeef')).toBe(false);
  });
});

describe('lan-guard: HTTP', () => {
  it('isLoopbackIp', () => {
    expect(isLoopbackIp('127.0.0.1')).toBe(true);
    expect(isLoopbackIp('::1')).toBe(true);
    expect(isLoopbackIp('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackIp('192.168.1.20')).toBe(false);
    expect(isLoopbackIp(null)).toBe(false);
  });

  it('directo sin token por LAN → 401 API / 403 HTML UI', async () => {
    const api = evaluateLanAccess(db, lanReq('/api/v1/profiles'), '192.168.1.20');
    expect(api.ok).toBe(false);
    if (!api.ok) {
      expect(api.status).toBe(401);
      expect(api.code).toBe(LAN_DENIED_CODE);
    }
    const ui = evaluateLanAccess(db, lanReq('/'), '192.168.1.20');
    expect(ui.ok).toBe(false);
    if (!ui.ok) expect(ui.status).toBe(403);
    const denied = lanDeniedResponse(lanReq('/'), ui as any);
    expect(denied.status).toBe(403);
    const html = await denied.text();
    expect(html).toContain('Sin permiso');
    expect(html).toContain('data-cy="lan-denied"');
    const deniedApi = lanDeniedResponse(lanReq('/api/v1/profiles'), api as any);
    expect(deniedApi.status).toBe(401);
    expect(deniedApi.headers.get('content-type')).toContain('application/json');
  });

  it('localhost exento y túnel exento (todo pasa)', () => {
    expect(evaluateLanAccess(db, lanReq('/api/v1/profiles'), '127.0.0.1')).toMatchObject({ ok: true, via: 'loopback' });
    expect(evaluateLanAccess(db, lanReq('/api/v1/profiles'), '::1')).toMatchObject({ ok: true, via: 'loopback' });
    expect(evaluateLanAccess(db, lanReq('/'), null)).toMatchObject({ ok: true, via: 'tunnel' });
  });

  it('rutas públicas abiertas sin invitación; control cerrado', () => {
    for (const p of ['/health', '/config', '/api/v1/network/ips']) {
      expect(evaluateLanAccess(db, lanReq(p), '192.168.1.20')).toMatchObject({ ok: true, via: 'public' });
    }
    expect(evaluateLanAccess(db, lanReq('/api/v1/remote/lan-redeem', { method: 'POST' }), '192.168.1.20'))
      .toMatchObject({ ok: true, via: 'public' });
    expect(evaluateLanAccess(db, lanReq('/api/v1/actions/execute', { method: 'POST' }), '192.168.1.20').ok).toBe(false);
  });

  it('con sesión válida → OK (header, cookie y query)', () => {
    const r = redeemLanInvite(db, createLanInvite(db).code);
    const token = r.token!;
    expect(hasValidLanSession(db, lanReq('/api/v1/profiles', { token }))).toBe(true);
    expect(evaluateLanAccess(db, lanReq('/api/v1/actions/execute', { method: 'POST', token }), '192.168.1.20'))
      .toMatchObject({ ok: true, via: 'invite' });
    // Cookie (la que fija el canje para el navegador).
    expect(evaluateLanAccess(db, lanReq('/index.html', { cookie: `ld_lan=${token}` }), '192.168.1.20'))
      .toMatchObject({ ok: true, via: 'invite' });
    // Sesión por query (carga inicial).
    expect(evaluateLanAccess(db, lanReq('/', { token }), '192.168.1.20'))
      .toMatchObject({ ok: true, via: 'invite' });
    // Revocada → denegada.
    revokeLanSessionByPrefix(db, token.slice(0, 8));
    expect(evaluateLanAccess(db, lanReq('/api/v1/profiles', { token }), '192.168.1.20').ok).toBe(false);
  });

  it('?invite=<código> canjea al vuelo + fija cookie; reutilizar → denegado', () => {
    const inv = createLanInvite(db);
    const v = evaluateLanAccess(db, lanReq('/', { code: inv.code }), '192.168.1.20');
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.via).toBe('invite');
      expect(v.setCookie?.token).toBeDefined();
      // La sesión creada sirve para la API.
      const api = evaluateLanAccess(
        db, lanReq('/api/v1/profiles', { cookie: `ld_lan=${v.setCookie!.token}` }), '192.168.1.20');
      expect(api).toMatchObject({ ok: true, via: 'invite' });
    }
    // El código ya se consumió: sin cookie → denegado.
    expect(evaluateLanAccess(db, lanReq('/', { code: inv.code }), '192.168.1.99').ok).toBe(false);
  });

  it('gestión solo-anfitrión: invitado válido → 403, anónimo → 403/401', () => {
    const r = redeemLanInvite(db, createLanInvite(db).code);
    const token = r.token!;
    const asGuest = evaluateLanAccess(db, lanReq('/api/v1/remote/lan-sessions', { token }), '192.168.1.20');
    expect(asGuest.ok).toBe(false);
    if (!asGuest.ok) expect(asGuest.status).toBe(403);
    const anon = evaluateLanAccess(db, lanReq('/api/v1/remote/lan-sessions'), '192.168.1.20');
    expect(anon.ok).toBe(false);
    const host = evaluateLanAccess(db, lanReq('/api/v1/remote/lan-sessions'), '127.0.0.1');
    expect(host).toMatchObject({ ok: true, via: 'loopback' });
  });
});

describe('lan API: endpoints remote', () => {
  it('crear/listar/revocar invitación + sesiones (anfitrión)', async () => {
    let r = await remoteCall('/api/v1/remote/lan-invite', 'POST', { label: 'salón' });
    expect(r.status).toBe(200);
    expect(r.body.code).toBeDefined();
    expect(r.body.expiresAt).toBeGreaterThan(Date.now());
    const code: string = r.body.code;

    r = await remoteCall('/api/v1/remote/lan-invite', 'GET');
    expect(r.status).toBe(200);
    expect(r.body.present).toBe(true);

    // Canje + listado de sesiones (sin token completo).
    const { markLanContext: mark } = await import('../http/lan-guard');
    const redeemReq = new Request('http://127.0.0.1:3001/api/v1/remote/lan-redeem', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }),
    });
    mark(redeemReq, { via: 'public', peerIp: '127.0.0.1' });
    const redeemRes = await handleRemote(redeemReq, {
      url: new URL('http://127.0.0.1:3001/api/v1/remote/lan-redeem'),
      method: 'POST', path: '/api/v1/remote/lan-redeem', db, services,
    });
    expect(redeemRes!.status).toBe(200);
    const redeemBody = await redeemRes!.json();
    expect(redeemBody.sessionToken).toBeDefined();
    expect(redeemRes!.headers.get('set-cookie')).toContain('ld_lan=');

    r = await remoteCall('/api/v1/remote/lan-sessions', 'GET');
    expect(r.status).toBe(200);
    expect(r.body.sessions).toHaveLength(1);
    expect(JSON.stringify(r.body)).not.toContain(redeemBody.sessionToken);

    r = await remoteCall(`/api/v1/remote/lan-sessions/${redeemBody.sessionToken.slice(0, 8)}`, 'DELETE');
    expect(r.status).toBe(200);
    expect(validateLanSession(db, redeemBody.sessionToken).ok).toBe(false);

    r = await remoteCall('/api/v1/remote/lan-invite', 'DELETE');
    // Ya consumida al canjear → nada que revocar.
    expect(r.status).toBe(200);
  });

  it('canje con código malo → 401; rate-limit → 429', async () => {
    const { markLanContext: mark } = await import('../http/lan-guard');
    const call = async (code: string) => {
      const req = new Request('http://127.0.0.1:3001/api/v1/remote/lan-redeem', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }),
      });
      mark(req, { via: 'public', peerIp: '10.9.9.9' });
      const res = await handleRemote(req, {
        url: new URL('http://127.0.0.1:3001/api/v1/remote/lan-redeem'),
        method: 'POST', path: '/api/v1/remote/lan-redeem', db, services,
      });
      return res!.status;
    };
    expect(await call('nope')).toBe(401);
    for (let i = 0; i < 9; i++) await call('nope');
    expect(await call('nope')).toBe(429);
  });
});

// ---- WS en cuarentena (puerto efímero) ----

let wsMgr: WebSocketManager | null = null;
let wsPort = 0;

async function startWs(): Promise<number> {
  wsMgr = new WebSocketManager(0);
  // Bun.serve con puerto 0 asigna uno efímero.
  await new Promise((r) => setTimeout(r, 50));
  wsPort = (wsMgr as any)?.server?.port ?? 0;
  expect(wsPort).toBeGreaterThan(0);
  return wsPort;
}

function wsConnect(extra?: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${wsPort}${extra ?? ''}`);
    ws.addEventListener('open', () => resolve(ws), { once: true });
    ws.addEventListener('error', (e) => reject(e), { once: true });
  });
}

function wsNext(ws: WebSocket): Promise<any> {
  return new Promise((resolve) => {
    ws.addEventListener('message', (ev: any) => {
      try { resolve(JSON.parse(String(ev.data))); } catch { resolve(null); }
    }, { once: true });
  });
}

describe('lan-guard: WebSocket en cuarentena', () => {
  let inviteCode: string;
  let sessionToken: string;

  function lanIp(): string | null {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { networkInterfaces } = require('node:os');
      for (const addrs of Object.values(networkInterfaces() as Record<string, any[]>)) {
        for (const a of addrs ?? []) {
          if (a?.family === 'IPv4' && !a?.internal) return a.address;
        }
      }
    } catch { /* noop */ }
    return null;
  }

  beforeEach(async () => {
    if (!wsMgr) await startWs();
    // OJO: solo hay UNA invitación vigente: primero se canjea la de la
    // sesión y DESPUÉS se crea la del código (crear sustituye).
    sessionToken = redeemLanInvite(db, createLanInvite(db, 'ws-sess').code).token!;
    inviteCode = createLanInvite(db, 'ws-test').code;
  });

  afterEach(() => {
    try { wsMgr?.close(); } catch { /* noop */ }
    wsMgr = null;
  });

  it('localhost nace autorizado; subscribe + hello OK', async () => {
    const ws = await wsConnect();
    try {
      const hello = await wsNext(ws); // connected
      expect(hello.type).toBe('connected');
      expect(hello.payload.lanAuthed).toBe(true);
      ws.send(JSON.stringify({ type: 'hello', payload: { deviceId: 'd-host' } }));
      const state = await wsNext(ws);
      expect(state.type).toBe('session.state');
      ws.send(JSON.stringify({ type: 'subscribe', payload: { topics: ['pages'] } }));
      const sub = await wsNext(ws);
      expect(sub.type).toBe('subscribed');
    } finally {
      ws.close();
    }
  });

  it('por LAN sin invitación: subscribe → error, hello vacío → error', async () => {
    const ip = lanIp();
    if (!ip) return; // sin interfaz LAN (CI): se cubre vía evaluateLanAccess
    const ws = new WebSocket(`ws://${ip}:${wsPort}`);
    await new Promise((res, rej) => {
      ws.addEventListener('open', () => res(null), { once: true });
      ws.addEventListener('error', (e) => rej(e), { once: true });
    });
    try {
      const connected = await wsNext(ws);
      expect(connected.payload.lanAuthRequired).toBe(true);
      ws.send(JSON.stringify({ type: 'subscribe', payload: { topics: ['pages'] } }));
      const denied = await wsNext(ws);
      expect(denied.type).toBe('error');
      expect(denied.payload.code).toBe(LAN_DENIED_CODE);
      ws.send(JSON.stringify({ type: 'hello', payload: { deviceId: 'd-guest' } }));
      const deniedHello = await wsNext(ws);
      expect(deniedHello.type).toBe('error');
      expect(deniedHello.payload.code).toBe(LAN_DENIED_CODE);
    } finally {
      ws.close();
    }
  });

  it('por LAN con código en hello → session.state autorizado; luego subscribe OK', async () => {
    const ip = lanIp();
    if (!ip) return;
    const ws = new WebSocket(`ws://${ip}:${wsPort}`);
    await new Promise((res, rej) => {
      ws.addEventListener('open', () => res(null), { once: true });
      ws.addEventListener('error', (e) => rej(e), { once: true });
    });
    try {
      await wsNext(ws); // connected
      ws.send(JSON.stringify({ type: 'hello', payload: { deviceId: 'd-guest2', invite: inviteCode } }));
      const state = await wsNext(ws);
      expect(state.type).toBe('session.state');
      expect(state.payload.lanAuthed).toBe(true);
      expect(typeof state.payload.lanSessionToken).toBe('string');
      // Código consumido: reutilizar por WS → error.
      const ws2 = new WebSocket(`ws://${ip}:${wsPort}`);
      await new Promise((res, rej) => {
        ws2.addEventListener('open', () => res(null), { once: true });
        ws2.addEventListener('error', (e) => rej(e), { once: true });
      });
      try {
        await wsNext(ws2);
        ws2.send(JSON.stringify({ type: 'hello', payload: { deviceId: 'd-guest3', invite: inviteCode } }));
        const denied = await wsNext(ws2);
        expect(denied.type).toBe('error');
      } finally {
        ws2.close();
      }
      // Con la sesión recién creada: subscribe OK.
      ws.send(JSON.stringify({ type: 'subscribe', payload: { topics: ['pages'] } }));
      const sub = await wsNext(ws);
      expect(sub.type).toBe('subscribed');
    } finally {
      ws.close();
    }
  });

  it('por LAN con sesión en query (?invite=) nace autorizado', async () => {
    const ip = lanIp();
    if (!ip) return;
    const ws = new WebSocket(`ws://${ip}:${wsPort}?invite=${encodeURIComponent(sessionToken)}`);
    await new Promise((res, rej) => {
      ws.addEventListener('open', () => res(null), { once: true });
      ws.addEventListener('error', (e) => rej(e), { once: true });
    });
    try {
      const connected = await wsNext(ws);
      expect(connected.payload.lanAuthed).toBe(true);
      ws.send(JSON.stringify({ type: 'hello', payload: { deviceId: 'd-guest4' } }));
      const state = await wsNext(ws);
      expect(state.type).toBe('session.state');
    } finally {
      ws.close();
    }
  });
});
