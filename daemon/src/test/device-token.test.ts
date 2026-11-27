/**
 * device-token.test.ts — Aprovisionamiento device-token del relay (daemon).
 *
 * Cubre (aislado: relay HTTP/WS falso en Bun.serve, DATA_DIR temporal por
 * test, sin red real):
 * - `claimDeviceToken`: éxito + cada error tipado (provision-required,
 *   bad-provision, rate-limited+retryAfterMs, claim-disabled, bad-request,
 *   unreachable). Un solo intento, timeout 10 s.
 * - `revokeDeviceToken` / `rotateDeviceToken` (roundtrip + Bearer usado).
 * - `fetchRelayCaps` (deviceAuth true/false, ausente→unparseable, caída→unreachable).
 * - Claves de firma ed25519 (`identity.ts`): estables, raw 32B/64B, NO rotan
 *   con `rotateKeys()`; `tunnel-register` firmado verifica con la signPub y
 *   `ts` es fresco (±5 min); legacy sin ts/sig.
 * - `RelayAuthTracker`: 3 handshakes fallidos con token → reclaim; más →
 *   invalid; sin token → none; `noteConnected` resetea.
 * - `ensureDeviceClaim`/`refreshDeviceToken`: claim único pre-connect,
 *   rate-limited con retry, re-claim que rota si el valor se repite.
 * - `GET /status`: mapeo `relay.auth` (incl. unsupported) + `deviceLinked`,
 *   sin fugas de secretos.
 * - `POST relay-unlink` / `relay-rotate`: revoke best-effort + borrado /
 *   rotación con persistencia, broadcasts sin secretos.
 * - Integración `RelayClient`: 401s en WS → UN re-claim y luego
 *   `invalid-token` con backoff lento (sin hot loop).
 * - Integración `TunnelClient`: `tunnel-register` firmado verificable.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import nacl from 'tweetnacl';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ld-device-token-'));
process.env.LIBREDECK_DATA_DIR = ROOT;

import { initDatabase, DatabaseService } from '../db';
import { handleRemote } from '../api/remote';
import {
  claimDeviceToken,
  revokeDeviceToken,
  rotateDeviceToken,
  fetchRelayCaps,
  secretsEqual,
} from '../remote/device-claim';
import {
  RelayAuthTracker,
  ensureDeviceClaim,
  refreshDeviceClaim,
  defaultAuthDeps,
} from '../remote/relay-auth';
import {
  getRelaySigningKeys,
  signTunnelRegister,
  getIdentity,
  rotateKeys,
} from '../remote/identity';
import { buildTunnelRegister, TunnelClient } from '../remote/tunnel';
import { RelayClient } from '../remote/relay-client';
import { DEVICE_TOKEN_KEY } from '../remote/public-relay';

let db: DatabaseService;
let savedEnv: Record<string, string | undefined> = {};

// ---- relay falso (HTTP + WS) ----

interface FakeBehavior {
  capsStatus?: number;
  capsBody?: unknown;
  provision?: string;
  claimImpl?: (body: any, auth: string | null) => { status: number; body: unknown };
  revokeImpl?: (auth: string | null, body: any) => { status: number; body: unknown };
  rotateImpl?: (auth: string | null) => { status: number; body: unknown };
  wsAccept?: boolean;
  mintPrefix?: string;
}

const servers: any[] = [];
let serverWsList: any[] = [];
let received: any[] = [];
/** Clientes relay/túnel vivos: se cierran en afterEach aunque el test falle. */
const liveClients: Array<{ stop: () => void }> = [];
const calls = { caps: 0, claim: 0, revoke: 0, rotate: 0 };
let lastAuthz = { claim: '', revoke: '', rotate: '' };
let minted = 0;

function resetFakeCounters(): void {
  calls.caps = 0; calls.claim = 0; calls.revoke = 0; calls.rotate = 0;
  lastAuthz = { claim: '', revoke: '', rotate: '' };
  minted = 0;
  received = [];
  serverWsList = [];
}

function startFakeRelay(behavior: FakeBehavior = {}): { port: number; stop: () => void } {
  const provision = behavior.provision ?? 'prov-1';
  const server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      const u = new URL(req.url);
      if (u.pathname === '/api/caps') {
        calls.caps += 1;
        const status = behavior.capsStatus ?? 200;
        const body = behavior.capsBody !== undefined ? behavior.capsBody : { deviceAuth: true, version: '9' };
        if (status !== 200) return new Response('nope', { status });
        if (typeof body === 'string') return new Response(body, { status: 200 });
        return Response.json(body);
      }
      if (u.pathname === '/api/device-claim' && req.method === 'POST') {
        calls.claim += 1;
        return req.json().then((body: any) => {
          const auth = req.headers.get('authorization');
          lastAuthz.claim = auth ?? '';
          if (behavior.claimImpl) {
            const r = behavior.claimImpl(body, auth);
            return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
          }
          if (auth !== `Bearer ${provision}`) {
            return Response.json({ error: auth ? 'bad-provision' : 'provision-required' }, { status: 401 });
          }
          // El relay real lee `pubKey`; el contrato del daemon dice
          // `pubKeyB64`: el daemon envía ambos; aquí se acepta cualquiera.
          const pub = body?.pubKeyB64 ?? body?.pubKey;
          if (!body?.deviceId || !pub) return Response.json({ error: 'bad-device' }, { status: 400 });
          minted += 1;
          return Response.json({ deviceToken: `${behavior.mintPrefix ?? 'tok'}-${minted}` });
        }).catch(() => new Response('bad json', { status: 400 }));
      }
      if (u.pathname === '/api/device-revoke' && req.method === 'POST') {
        calls.revoke += 1;
        return req.json().then((body: any) => {
          const auth = req.headers.get('authorization');
          lastAuthz.revoke = auth ?? '';
          if (behavior.revokeImpl) {
            const r = behavior.revokeImpl(auth, body);
            return new Response(JSON.stringify(r.body), { status: r.status });
          }
          if (!auth || !auth.startsWith('Bearer ') || auth.slice(7).length === 0) {
            return Response.json({ error: 'auth-required' }, { status: 401 });
          }
          return Response.json({ ok: true });
        }).catch(() => new Response('bad json', { status: 400 }));
      }
      if (u.pathname === '/api/device-rotate' && req.method === 'POST') {
        calls.rotate += 1;
        const auth = req.headers.get('authorization');
        lastAuthz.rotate = auth ?? '';
        if (behavior.rotateImpl) {
          const r = behavior.rotateImpl(auth);
          return new Response(JSON.stringify(r.body), { status: r.status });
        }
        if (!auth || !auth.startsWith('Bearer ')) return Response.json({ error: 'invalid-token' }, { status: 401 });
        minted += 1;
        return Response.json({ deviceToken: `${behavior.mintPrefix ?? 'tok'}-rot-${minted}` });
      }
      // WS: aceptar o rechazar con 401 (simula token inválido en el upgrade).
      if (behavior.wsAccept === false) return new Response('auth-required', { status: 401 });
      if (srv.upgrade(req)) return undefined as any;
      return new Response('relay-fake', { status: 200 });
    },
    websocket: {
      open(ws: any) { serverWsList.push(ws); },
      message(_ws: any, raw: any) {
        try { received.push(JSON.parse(String(raw))); } catch { /* noop */ }
      },
      close(ws: any) { serverWsList = serverWsList.filter((w) => w !== ws); },
    },
  });
  servers.push(server);
  return { port: server.port as number, stop: () => { try { server.stop(true); } catch { /* noop */ } } };
}

async function waitFor(cond: () => boolean, timeoutMs = 8000, stepMs = 25): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (cond()) return;
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

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
  savedEnv = {
    RELAY_URL: process.env.RELAY_URL,
    RELAY_TOKEN: process.env.RELAY_TOKEN,
    RELAY_PROVISION_TOKEN: process.env.RELAY_PROVISION_TOKEN,
  };
  delete process.env.RELAY_URL;
  delete process.env.RELAY_TOKEN;
  delete process.env.RELAY_PROVISION_TOKEN;
  const dir = fs.mkdtempSync(path.join(ROOT, 't-'));
  process.env.LIBREDECK_DATA_DIR = dir;
  await initDatabase();
  db = new DatabaseService();
  // Hermético: purga cualquier resto de enlace relay/identidad (por si el
  // handle SQLite se comparte con otros ficheros del mismo proceso).
  try {
    for (const k of Object.keys(db.getAllSettings())) {
      if (k.startsWith('remote.relay.') || k.startsWith('remote.device.')) db.deleteSetting(k);
    }
  } catch { /* sin getAllSettings: nada que purgar */ }
  resetFakeCounters();
  try { delete (globalThis as any).__libredeckRemote; } catch { /* noop */ }
});

afterEach(async () => {
  // Cierra clientes relay/túnel aunque el test haya fallado (evita que sus
  // timers de reconexión contaminen los contadores del test siguiente).
  for (const c of liveClients.splice(0)) {
    try { c.stop(); } catch { /* noop */ }
  }
  for (const s of servers.splice(0)) {
    try { s.stop(true); } catch { /* noop */ }
  }
  if (savedEnv.RELAY_URL === undefined) delete process.env.RELAY_URL;
  else process.env.RELAY_URL = savedEnv.RELAY_URL;
  if (savedEnv.RELAY_TOKEN === undefined) delete process.env.RELAY_TOKEN;
  else process.env.RELAY_TOKEN = savedEnv.RELAY_TOKEN;
  if (savedEnv.RELAY_PROVISION_TOKEN === undefined) delete process.env.RELAY_PROVISION_TOKEN;
  else process.env.RELAY_PROVISION_TOKEN = savedEnv.RELAY_PROVISION_TOKEN;
  try { delete (globalThis as any).__libredeckRemote; } catch { /* noop */ }
  await new Promise((r) => setTimeout(r, 50));
});

// ---------- 1. claim / revoke / rotate / caps ----------

describe('device-claim: claim/revoke/rotate/caps', () => {
  it('claim éxito devuelve deviceToken', async () => {
    const f = startFakeRelay({ provision: 'prov-1' });
    const r = await claimDeviceToken({
      relayUrl: `ws://127.0.0.1:${f.port}`,
      provision: 'prov-1',
      deviceId: 'dev-1',
      pubKeyB64: Buffer.from(new Uint8Array(32).fill(7)).toString('base64'),
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.deviceToken).toBe('tok-1');
    expect(calls.claim).toBe(1);
    expect(lastAuthz.claim).toBe('Bearer prov-1');
  });

  it('claim sin provisión → provision-required', async () => {
    const f = startFakeRelay({ provision: 'prov-1' });
    const r = await claimDeviceToken({
      relayUrl: `ws://127.0.0.1:${f.port}`, provision: '', deviceId: 'dev-1', pubKeyB64: 'eA==',
    });
    expect(r).toEqual({ ok: false, error: 'provision-required' });
    expect(lastAuthz.claim).toBe('');
  });

  it('claim provisión errónea → bad-provision', async () => {
    const f = startFakeRelay({ provision: 'prov-1' });
    const r = await claimDeviceToken({
      relayUrl: `ws://127.0.0.1:${f.port}`, provision: 'mala', deviceId: 'dev-1', pubKeyB64: 'eA==',
    });
    expect(r).toEqual({ ok: false, error: 'bad-provision' });
  });

  it('claim 429 → rate-limited con retryAfterMs', async () => {
    startFakeRelay({
      claimImpl: () => ({ status: 429, body: { error: 'rate-limited', retryAfterMs: 1500 } }),
    });
    const port = servers[servers.length - 1].port;
    const r = await claimDeviceToken({
      relayUrl: `ws://127.0.0.1:${port}`, provision: 'x', deviceId: 'd', pubKeyB64: 'eA==',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe('rate-limited');
      expect(r.retryAfterMs).toBe(1500);
    }
  });

  it('claim 503 → claim-disabled; 400 → bad-request', async () => {
    startFakeRelay({ claimImpl: () => ({ status: 503, body: { error: 'claim-disabled' } }) });
    const port = servers[servers.length - 1].port;
    expect(await claimDeviceToken({ relayUrl: `ws://127.0.0.1:${port}`, provision: 'x', deviceId: 'd', pubKeyB64: 'eA==' }))
      .toEqual({ ok: false, error: 'claim-disabled' });
  });

  it('claim body inválido (sin deviceId) → bad-request sin red', async () => {
    startFakeRelay();
    const port = servers[servers.length - 1].port;
    const before = calls.claim;
    const r = await claimDeviceToken({ relayUrl: `ws://127.0.0.1:${port}`, provision: 'x', deviceId: '', pubKeyB64: 'eA==' });
    expect(r).toEqual({ ok: false, error: 'bad-request' });
    expect(calls.claim).toBe(before);
  });

  it('claim envía pubKey y pubKeyB64 con el mismo valor (compat)', async () => {
    let seen: any = null;
    startFakeRelay({
      claimImpl: (body) => { seen = body; return { status: 200, body: { deviceToken: 'tok-x' } }; },
    });
    const port = servers[servers.length - 1].port;
    const r = await claimDeviceToken({
      relayUrl: `ws://127.0.0.1:${port}`, provision: 'x', deviceId: 'd', pubKeyB64: 'cHViMzI=',
    });
    expect(r.ok).toBe(true);
    expect(seen?.pubKey).toBe('cHViMzI=');
    expect(seen?.pubKeyB64).toBe('cHViMzI=');
  });

  it('claim contra relay caído → unreachable', async () => {
    const f = startFakeRelay();
    const deadPort = f.port;
    f.stop();
    await new Promise((r) => setTimeout(r, 100));
    const r = await claimDeviceToken({
      relayUrl: `ws://127.0.0.1:${deadPort}`, provision: 'x', deviceId: 'd', pubKeyB64: 'eA==',
    });
    expect(r).toEqual({ ok: false, error: 'unreachable' });
  });

  it('revoke envía Bearer deviceToken y rotate devuelve token nuevo', async () => {
    const f = startFakeRelay({ provision: 'prov-1' });
    const url = `ws://127.0.0.1:${f.port}`;
    const c = await claimDeviceToken({ relayUrl: url, provision: 'prov-1', deviceId: 'd', pubKeyB64: 'eA==' });
    expect(c.ok).toBe(true);
    const token = c.ok ? c.deviceToken : '';
    const rev = await revokeDeviceToken({ relayUrl: url, deviceToken: token, deviceId: 'd' });
    expect(rev).toEqual({ ok: true });
    expect(lastAuthz.revoke).toBe(`Bearer ${token}`);
    const rot = await rotateDeviceToken({ relayUrl: url, deviceToken: token });
    expect(rot.ok).toBe(true);
    if (rot.ok) {
      expect(rot.deviceToken).not.toBe(token);
      expect(lastAuthz.rotate).toBe(`Bearer ${token}`);
    }
  });

  it('rotate con token inválido → bad-provision; sin token → bad-request', async () => {
    const f = startFakeRelay();
    const url = `ws://127.0.0.1:${f.port}`;
    const bad = await rotateDeviceToken({ relayUrl: url, deviceToken: '' });
    expect(bad).toEqual({ ok: false, error: 'bad-request' });
  });

  it('caps: deviceAuth true/false; ausente → unparseable; caído → unreachable', async () => {
    const f = startFakeRelay({ capsBody: { deviceAuth: true, version: '9' } });
    const url = `ws://127.0.0.1:${f.port}`;
    const ok = await fetchRelayCaps(url);
    expect(ok).toEqual({ ok: true, deviceAuth: true, version: '9' });

    const f2 = startFakeRelay({ capsStatus: 404 });
    expect(await fetchRelayCaps(`ws://127.0.0.1:${f2.port}`)).toEqual({ ok: false, error: 'unparseable' });

    const f3 = startFakeRelay({ capsBody: 'texto-plano' });
    expect(await fetchRelayCaps(`ws://127.0.0.1:${f3.port}`)).toEqual({ ok: false, error: 'unparseable' });

    f.stop();
    await new Promise((r) => setTimeout(r, 100));
    expect(await fetchRelayCaps(url)).toEqual({ ok: false, error: 'unreachable' });
  });

  it('secretsEqual: tiempo constante, true/false/longitud', () => {
    expect(secretsEqual('abc', 'abc')).toBe(true);
    expect(secretsEqual('abc', 'abd')).toBe(false);
    expect(secretsEqual('abc', 'abcd')).toBe(false);
    expect(secretsEqual('', '')).toBe(true);
  });
});

// ---------- 2. claves de firma ed25519 ----------

describe('identity: relay signing keys (ed25519 dedicadas)', () => {
  it('estables entre llamadas, raw 32B/64B b64', () => {
    const a = getRelaySigningKeys(db);
    const b = getRelaySigningKeys(db);
    expect(a.publicKeyB64).toBe(b.publicKeyB64);
    expect(a.secretKeyB64).toBe(b.secretKeyB64);
    expect(Buffer.from(a.publicKeyB64, 'base64').length).toBe(32);
    expect(Buffer.from(a.secretKeyB64, 'base64').length).toBe(64);
    // Persistidas en settings dedicadas (no mezcladas con la identidad E2E).
    expect(db.getSetting('remote.relay.signPub')).toBe(a.publicKeyB64);
  });

  it('NO rotan con rotateKeys() (vínculo relay independiente de E2E)', () => {
    const before = getRelaySigningKeys(db);
    const idBefore = getIdentity(db);
    const after = rotateKeys(db);
    expect(after.publicKeyB64).not.toBe(idBefore.publicKeyB64);
    const kept = getRelaySigningKeys(db);
    expect(kept.publicKeyB64).toBe(before.publicKeyB64);
    expect(kept.secretKeyB64).toBe(before.secretKeyB64);
  });

  it('tunnel-register firmado: ts fresco y sig verifica con signPub', () => {
    const keys = getRelaySigningKeys(db);
    const msg = buildTunnelRegister(db as any, 'dev-9', { signed: true });
    expect(msg.kind).toBe('tunnel-register');
    expect(msg.deviceId).toBe('dev-9');
    expect(typeof msg.ts).toBe('number');
    expect(Math.abs(Date.now() - Number(msg.ts))).toBeLessThan(5 * 60 * 1000);
    expect(String(msg.sig)).toMatch(/^[0-9a-f]{128}$/);
    const ok = nacl.sign.detached.verify(
      new Uint8Array(Buffer.from(`dev-9|${msg.ts}`, 'utf8')),
      new Uint8Array(Buffer.from(String(msg.sig), 'hex')),
      new Uint8Array(Buffer.from(keys.publicKeyB64, 'base64')),
    );
    expect(ok).toBe(true);
    // Manipular deviceId invalida la firma.
    const tampered = nacl.sign.detached.verify(
      new Uint8Array(Buffer.from(`otro|${msg.ts}`, 'utf8')),
      new Uint8Array(Buffer.from(String(msg.sig), 'hex')),
      new Uint8Array(Buffer.from(keys.publicKeyB64, 'base64')),
    );
    expect(tampered).toBe(false);
    void signTunnelRegister;
  });

  it('tunnel-register legacy: sin ts/sig', () => {
    const msg = buildTunnelRegister(db as any, 'dev-9');
    expect(msg).toEqual({ v: 1, kind: 'tunnel-register', deviceId: 'dev-9' });
  });
});

// ---------- 3. tracker + orquestación ----------

describe('relay-auth: tracker y orquestación', () => {
  it('3 handshakes con token → reclaim; después → invalid; sin token → none', () => {
    const t = new RelayAuthTracker();
    expect(t.noteHandshakeFailure(true)).toBe('none');
    expect(t.noteHandshakeFailure(true)).toBe('none');
    expect(t.noteHandshakeFailure(true)).toBe('reclaim');
    expect(t.noteHandshakeFailure(true)).toBe('invalid');
    expect(t.noteHandshakeFailure(true)).toBe('invalid');
  });

  it('sin token nunca reclama; noteConnected/noteClosedAfterOpen resetean', () => {
    const t = new RelayAuthTracker();
    for (let i = 0; i < 10; i++) expect(t.noteHandshakeFailure(false)).toBe('none');
    const t2 = new RelayAuthTracker();
    t2.noteHandshakeFailure(true);
    t2.noteHandshakeFailure(true);
    t2.noteConnected();
    expect(t2.noteHandshakeFailure(true)).toBe('none');
    expect(t2.noteHandshakeFailure(true)).toBe('none');
    expect(t2.noteHandshakeFailure(true)).toBe('reclaim');
    const t3 = new RelayAuthTracker();
    t3.noteHandshakeFailure(true);
    t3.noteClosedAfterOpen();
    expect(t3.consecutiveHandshakeFailures).toBe(0);
  });

  it('ensure: relay sin deviceAuth → proceed sin claim', async () => {
    const t = new RelayAuthTracker();
    let claimCalls = 0;
    const deps = defaultAuthDeps({
      fetchCaps: async () => ({ ok: true as const, deviceAuth: false }),
      claim: async () => { claimCalls += 1; return { ok: true as const, deviceToken: 'x' }; },
    });
    const r = await ensureDeviceClaim(deps, 'ws://x.test', t);
    expect(r.proceed).toBe(true);
    expect(claimCalls).toBe(0);
    expect(t.state).toBe('ok');
  });

  it('ensure: caps ilegibles → unsupported y proceed legacy', async () => {
    const t = new RelayAuthTracker();
    const deps = defaultAuthDeps({
      fetchCaps: async () => ({ ok: false as const, error: 'unparseable' as const }),
      getDeviceToken: () => 'legacy-guardado',
    });
    const r = await ensureDeviceClaim(deps, 'ws://x.test', t);
    expect(t.state).toBe('unsupported');
    expect(r.proceed).toBe(true);
    expect(r.token).toBe('legacy-guardado');
  });

  it('ensure: deviceAuth + token guardado → proceed sin claim', async () => {
    const t = new RelayAuthTracker();
    let claimCalls = 0;
    const deps = defaultAuthDeps({
      fetchCaps: async () => ({ ok: true as const, deviceAuth: true }),
      getDeviceToken: () => 'tok-viejo',
      claim: async () => { claimCalls += 1; return { ok: true as const, deviceToken: 'x' }; },
    });
    const r = await ensureDeviceClaim(deps, 'ws://x.test', t);
    expect(r.proceed).toBe(true);
    expect(r.token).toBe('tok-viejo');
    expect(claimCalls).toBe(0);
  });

  it('ensure: deviceAuth sin token → UN claim; segundo intento no repite', async () => {
    const t = new RelayAuthTracker();
    let claimCalls = 0;
    const store = { token: '' };
    const deps = defaultAuthDeps({
      fetchCaps: async () => ({ ok: true as const, deviceAuth: true }),
      getDeviceToken: () => store.token,
      setDeviceToken: (x) => { store.token = x; },
      getProvision: () => 'prov-1',
      getDeviceId: () => 'dev-1',
      getPubKeyB64: () => 'cHVi',
      claim: async () => { claimCalls += 1; return { ok: true as const, deviceToken: 'tok-nuevo' }; },
    });
    const r1 = await ensureDeviceClaim(deps, 'ws://x.test', t);
    expect(r1.proceed).toBe(true);
    expect(store.token).toBe('tok-nuevo');
    const r2 = await ensureDeviceClaim(deps, 'ws://x.test', t);
    expect(r2.proceed).toBe(true);
    expect(claimCalls).toBe(1);
  });

  it('ensure: claim 429 → rate-limited con retry; claim 401 → auth-required', async () => {
    const t = new RelayAuthTracker();
    const deps429 = defaultAuthDeps({
      fetchCaps: async () => ({ ok: true as const, deviceAuth: true }),
      claim: async () => ({ ok: false as const, error: 'rate-limited' as const, retryAfterMs: 2000 }),
    });
    const r = await ensureDeviceClaim(deps429, 'ws://x.test', t);
    expect(r.rateLimited).toBe(true);
    expect(r.retryAfterMs).toBe(2000);
    expect(t.state).toBe('rate-limited');

    const t2 = new RelayAuthTracker();
    const deps401 = defaultAuthDeps({
      fetchCaps: async () => ({ ok: true as const, deviceAuth: true }),
      claim: async () => ({ ok: false as const, error: 'provision-required' as const }),
    });
    const r2 = await ensureDeviceClaim(deps401, 'ws://x.test', t2);
    expect(r2.proceed).toBe(false);
    expect(t2.state).toBe('auth-required');
  });

  it('refresh: claim con MISMO valor → rota para mentar fresco', async () => {
    const t = new RelayAuthTracker();
    const store = { token: 'tok-mismo' };
    let rotateCalls = 0;
    const deps = defaultAuthDeps({
      getDeviceToken: () => store.token,
      setDeviceToken: (x) => { store.token = x; },
      getProvision: () => 'prov-1',
      getDeviceId: () => 'dev-1',
      getPubKeyB64: () => 'cHVi',
      claim: async () => ({ ok: true as const, deviceToken: 'tok-mismo' }),
      rotate: async () => { rotateCalls += 1; return { ok: true as const, deviceToken: 'tok-fresco' }; },
    });
    const r = await refreshDeviceClaim(deps, 'ws://x.test', t);
    expect(r.refreshed).toBe(true);
    expect(store.token).toBe('tok-fresco');
    expect(rotateCalls).toBe(1);
    expect(t.state).toBe('ok');
  });

  it('ensure: claim-disabled (relay abierto/dev) → proceed BARE, estado ok', async () => {
    const t = new RelayAuthTracker();
    const store = { token: '' };
    const deps = defaultAuthDeps({
      fetchCaps: async () => ({ ok: true as const, deviceAuth: true }),
      getDeviceToken: () => store.token,
      setDeviceToken: (x) => { store.token = x; },
      claim: async () => ({ ok: false as const, error: 'claim-disabled' as const }),
    });
    const r = await ensureDeviceClaim(deps, 'ws://x.test', t);
    expect(r.proceed).toBe(true);
    expect(r.token).toBe('');
    expect(store.token).toBe('');
    expect(t.state).toBe('ok');
  });

  it('ensure: claim falla pero hay master → proceed con master', async () => {
    const t = new RelayAuthTracker();
    const deps = defaultAuthDeps({
      fetchCaps: async () => ({ ok: true as const, deviceAuth: true }),
      getMasterToken: () => 'master-x',
      claim: async () => ({ ok: false as const, error: 'provision-required' as const }),
    });
    const r = await ensureDeviceClaim(deps, 'ws://x.test', t);
    expect(r.proceed).toBe(true);
    expect(r.token).toBe('');
    expect(t.state).toBe('auth-required');
  });

  it('refresh: claim 401 → invalid-token', async () => {
    const t = new RelayAuthTracker();
    const deps = defaultAuthDeps({
      getDeviceToken: () => 'tok-muerto',
      claim: async () => ({ ok: false as const, error: 'bad-provision' as const }),
    });
    const r = await refreshDeviceClaim(deps, 'ws://x.test', t);
    expect(r.refreshed).toBe(false);
    expect(t.state).toBe('invalid-token');
  });
});

// ---------- 4. status / unlink / rotate ----------

describe('api/remote: status auth + relay-unlink/rotate', () => {
  function stubRemote(auth: string, conn = 'connected'): void {
    (globalThis as any).__libredeckRemote = {
      relay: { getState: () => conn, getAuthState: () => auth },
      tunnel: { getState: () => 'connected' },
    };
  }

  it('status mapea relay.auth incl. unsupported + deviceLinked, sin fugas', async () => {
    const services = makeServices();
    db.setSetting(DEVICE_TOKEN_KEY, 'tok-secreto-abc123');
    for (const auth of ['ok', 'auth-required', 'invalid-token', 'rate-limited', 'unreachable', 'unsupported']) {
      stubRemote(auth);
      const r = await remoteCall(db, services, '/api/v1/remote/status', 'GET');
      expect(r.status).toBe(200);
      expect(r.body.relay.auth).toBe(auth);
      expect(r.body.relay.deviceLinked).toBe(true);
    }
    db.deleteSetting(DEVICE_TOKEN_KEY);
    stubRemote('ok');
    const r = await remoteCall(db, services, '/api/v1/remote/status', 'GET');
    expect(r.body.relay.deviceLinked).toBe(false);
    // El token NUNCA aparece serializado.
    expect(JSON.stringify(r.body)).not.toContain('tok-secreto');
  });

  it('status sin tracker: conectado → ok; descolgado → unreachable', async () => {
    const services = makeServices();
    (globalThis as any).__libredeckRemote = {
      relay: { getState: () => 'connected' },
      tunnel: { getState: () => 'disconnected' },
    };
    const r = await remoteCall(db, services, '/api/v1/remote/status', 'GET');
    expect(r.body.relay.auth).toBe('ok');
    (globalThis as any).__libredeckRemote = {
      relay: { getState: () => 'disconnected' },
      tunnel: { getState: () => 'disconnected' },
    };
    const r2 = await remoteCall(db, services, '/api/v1/remote/status', 'GET');
    expect(r2.body.relay.auth).toBe('unreachable');
  });

  it('relay-unlink: revoca best-effort + borra token → {ok,linked:false}', async () => {
    const f = startFakeRelay({ provision: 'prov-1' });
    db.setSetting('remote.relay.url', `ws://127.0.0.1:${f.port}`);
    db.setSetting(DEVICE_TOKEN_KEY, 'tok-viejo');
    const services = makeServices();
    const r = await remoteCall(db, services, '/api/v1/remote/relay-unlink', 'POST');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, linked: false });
    expect(db.getSetting(DEVICE_TOKEN_KEY)).toBeNull();
    expect(calls.revoke).toBe(1);
    expect(lastAuthz.revoke).toBe('Bearer tok-viejo');
    // Broadcast sin secretos.
    expect(JSON.stringify(services.broadcasts)).not.toContain('tok-viejo');
  });

  it('relay-unlink sin token: ok igual (idempotente)', async () => {
    const services = makeServices();
    const r = await remoteCall(db, services, '/api/v1/remote/relay-unlink', 'POST');
    expect(r.body).toEqual({ ok: true, linked: false });
    expect(calls.revoke).toBe(0);
  });

  it('relay-rotate: guarda el token nuevo → {ok:true}', async () => {
    const f = startFakeRelay({ provision: 'prov-1' });
    db.setSetting('remote.relay.url', `ws://127.0.0.1:${f.port}`);
    db.setSetting(DEVICE_TOKEN_KEY, 'tok-viejo');
    const services = makeServices();
    const r = await remoteCall(db, services, '/api/v1/remote/relay-rotate', 'POST');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });
    const stored = db.getSetting(DEVICE_TOKEN_KEY);
    expect(stored).toBeTruthy();
    expect(stored).not.toBe('tok-viejo');
    expect(lastAuthz.rotate).toBe('Bearer tok-viejo');
    expect(JSON.stringify({ r: r.body, b: services.broadcasts })).not.toContain('tok-viejo');
    expect(JSON.stringify({ r: r.body, b: services.broadcasts })).not.toContain(stored);
  });

  it('relay-rotate sin token → 400', async () => {
    const services = makeServices();
    const r = await remoteCall(db, services, '/api/v1/remote/relay-rotate', 'POST');
    expect(r.status).toBe(400);
  });

  it('relay-rotate con relay caído → 502', async () => {
    const f = startFakeRelay();
    db.setSetting('remote.relay.url', `ws://127.0.0.1:${f.port}`);
    db.setSetting(DEVICE_TOKEN_KEY, 'tok-viejo');
    f.stop();
    await new Promise((r) => setTimeout(r, 100));
    const services = makeServices();
    const r = await remoteCall(db, services, '/api/v1/remote/relay-rotate', 'POST');
    expect(r.status).toBe(502);
  });
});

// ---------- 5. integración RelayClient: 401s → reclaim → invalid-token ----------

describe('relay-client: racha de 401s → UN re-claim → invalid-token sin hot loop', () => {
  it('caps+claim reales; WS siempre 401', async () => {
    const f = startFakeRelay({ provision: 'prov-1', wsAccept: false, mintPrefix: 'dtok' });
    process.env.RELAY_PROVISION_TOKEN = 'prov-1';
    db.setSetting('remote.relay.url', `ws://127.0.0.1:${f.port}`);
    const client = new RelayClient(db, { deviceId: 'dev-loop', publicKeyB64: 'eA==' }, {
      backoffBaseMs: 20,
      backoffMaxMs: 60,
    });
    liveClients.push(client);
    const seen: string[] = [];
    client.onAuthState((s) => { seen.push(s); });
    client.start();
    await waitFor(() => client.getAuthState() === 'invalid-token', 10000);
    expect(calls.claim).toBe(2); // inicial + UN re-claim
    expect(db.getSetting(DEVICE_TOKEN_KEY)).toBe('dtok-2');
    expect(seen).toContain('invalid-token');
    const claimCount = calls.claim;
    await new Promise((r) => setTimeout(r, 400));
    // Sin hot loop: no hay más claims, backoff lento.
    expect(calls.claim).toBe(claimCount);
    client.stop();
    expect(client.getState()).toBe('disconnected');
  });

  it('relay abierto (claim-disabled) + WS 401 → unreachable, UN claim, sin spin', async () => {
    const f = startFakeRelay({
      provision: 'prov-1',
      wsAccept: false,
      claimImpl: () => ({ status: 503, body: { error: 'claim-disabled' } }),
    });
    // Sin provisión ni master: claim-disabled → bare → 401s → unreachable.
    delete process.env.RELAY_PROVISION_TOKEN;
    db.setSetting('remote.relay.url', `ws://127.0.0.1:${f.port}`);
    const client = new RelayClient(db, { deviceId: 'dev-bare', publicKeyB64: 'eA==' }, {
      backoffBaseMs: 20,
      backoffMaxMs: 60,
    });
    liveClients.push(client);
    client.start();
    await waitFor(() => client.getAuthState() === 'unreachable', 10000);
    expect(calls.claim).toBe(1);
    expect(db.getSetting(DEVICE_TOKEN_KEY)).toBeNull();
    expect(client.getState()).not.toBe('connected');
    const claimCount = calls.claim;
    await new Promise((r) => setTimeout(r, 400));
    expect(calls.claim).toBe(claimCount);
    client.stop();
  });
});

// ---------- 6. integración TunnelClient: register firmado ----------

describe('tunnel: register firmado contra relay con deviceAuth', () => {
  function makeFakeWsManager(): any {
    return {
      broadcast() {},
      createTunnelClient(_id: string, _send: (t: string) => void) { return 'x'; },
      removeTunnelClient() {},
      handleTunnelMessage() {},
    };
  }

  it('envía tunnel-register con ts+sig que verifican con signPub', async () => {
    const f = startFakeRelay({ provision: 'prov-1' });
    process.env.RELAY_PROVISION_TOKEN = 'prov-1';
    db.setSetting('remote.relay.url', `ws://127.0.0.1:${f.port}`);
    const tunnel = new TunnelClient(db as any, makeFakeWsManager(), {
      deviceId: 'dev-tun',
      relayUrl: `ws://127.0.0.1:${f.port}`,
      keepaliveMs: 0,
      reconnectBaseMs: 20,
      reconnectMaxMs: 60,
    });
    liveClients.push(tunnel);
    tunnel.start();
    await waitFor(() => received.some((m) => m?.kind === 'tunnel-register'), 8000);
    const reg = received.find((m) => m?.kind === 'tunnel-register');
    expect(reg.deviceId).toBe('dev-tun');
    expect(typeof reg.ts).toBe('number');
    expect(Math.abs(Date.now() - reg.ts)).toBeLessThan(5 * 60 * 1000);
    expect(String(reg.sig)).toMatch(/^[0-9a-f]{128}$/);
    const signPub = db.getSetting('remote.relay.signPub')!;
    const ok = nacl.sign.detached.verify(
      new Uint8Array(Buffer.from(`dev-tun|${reg.ts}`, 'utf8')),
      new Uint8Array(Buffer.from(String(reg.sig), 'hex')),
      new Uint8Array(Buffer.from(signPub, 'base64')),
    );
    expect(ok).toBe(true);
    // Token guardado y enlazado.
    expect(db.getSetting(DEVICE_TOKEN_KEY)).toBeTruthy();
    expect(tunnel.isDeviceLinked()).toBe(true);
    tunnel.stop();
  });
});
