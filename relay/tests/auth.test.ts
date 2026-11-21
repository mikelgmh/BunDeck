import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeviceStore } from '../src/store';
import { PairingStore } from '../src/pairing';
import { RelayServer } from '../src/relay';
import { generateIdentity } from '../src/crypto';

const TOKEN = 'auth-test-token';
const servers: RelayServer[] = [];
const stores: DeviceStore[] = [];

function startRelay(): RelayServer {
  const dir = mkdtempSync(join(tmpdir(), 'relay-auth-test-'));
  const store = new DeviceStore(dir);
  stores.push(store);
  const relay = new RelayServer({ token: TOKEN, store, pairing: new PairingStore() });
  relay.listen(0, '127.0.0.1'); // puerto efímero
  servers.push(relay);
  return relay;
}

afterEach(() => {
  for (const r of servers.splice(0)) r.stop();
  for (const s of stores.splice(0)) s.close();
});

const msg = (type: string, extra: Record<string, unknown> = {}) => ({
  v: 1,
  type,
  from: 'dev-a',
  nonce: `n-${Math.random()}`,
  exp: Date.now() + 60_000,
  ...extra,
});

/** WS con buffer permanente (mismo patrón que relay.test.ts: sin races). */
function connect(port: number, token = TOKEN): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${token}`);
    (ws as any)._buf = [] as any[];
    ws.addEventListener('message', (e) => {
      try {
        (ws as any)._buf.push(JSON.parse(String((e as MessageEvent).data)));
      } catch {
        /* ignora no-JSON */
      }
    });
    ws.addEventListener('open', () => resolve(ws), { once: true });
    ws.addEventListener('error', () => reject(new Error('ws connect failed')), { once: true });
  });
}

function nextOf(ws: WebSocket, pred: (m: any) => boolean, timeoutMs = 3000): Promise<any> {
  const buf = (ws as any)._buf as any[];
  const take = (): any | undefined => {
    const i = buf.findIndex(pred);
    return i >= 0 ? buf.splice(i, 1)[0] : undefined;
  };
  const hit = take();
  if (hit !== undefined) return Promise.resolve(hit);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      clearInterval(poll);
      reject(new Error('timeout waiting for message'));
    }, timeoutMs);
    const poll = setInterval(() => {
      const m = take();
      if (m !== undefined) {
        clearTimeout(timer);
        clearInterval(poll);
        resolve(m);
      }
    }, 5);
  });
}

/** Intenta abrir un WS y resuelve con lo que pase: 'open' = aceptado (mal), resto = rechazado (bien). */
function tryOpen(url: string, timeoutMs = 3000): Promise<string> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    ws.addEventListener('close', (e) => resolve(`close:${(e as CloseEvent).code}`));
    ws.addEventListener('open', () => {
      try {
        ws.close();
      } catch {
        /* noop */
      }
      resolve('open');
    });
    ws.addEventListener('error', () => resolve('error'));
    setTimeout(() => {
      try {
        ws.close();
      } catch {
        /* noop */
      }
      resolve('timeout');
    }, timeoutMs);
  });
}

describe('relay auth (token compartido)', () => {
  test('WS sin token es rechazado (no llega a open)', async () => {
    const relay = startRelay();
    const res = await tryOpen(`ws://127.0.0.1:${relay.port}/`);
    expect(res).not.toBe('open');
  });

  test('WS con token erróneo es rechazado (no llega a open)', async () => {
    const relay = startRelay();
    const res = await tryOpen(`ws://127.0.0.1:${relay.port}/?token=token-incorrecto`);
    expect(res).not.toBe('open');
  });

  test('WS con token válido acepta register (responde registered)', async () => {
    const relay = startRelay();
    const id = generateIdentity();
    const ws = await connect(relay.port, TOKEN);
    try {
      await nextOf(ws, (m) => m.type === 'connected');
      ws.send(JSON.stringify(msg('register', { from: 'dev-a', payload: { deviceId: 'dev-a', pubKey: id.publicKey } })));
      const reg = await nextOf(ws, (m) => m.type === 'registered');
      expect(reg.payload).toMatchObject({ deviceId: 'dev-a', online: true });
    } finally {
      ws.close();
    }
  });

  test('POST /pair sin Bearer → 401', async () => {
    const relay = startRelay();
    const res = await fetch(`http://127.0.0.1:${relay.port}/pair`, { method: 'POST' });
    expect(res.status).toBe(401);
  });

  test('POST /pair con token erróneo → 401', async () => {
    const relay = startRelay();
    const res = await fetch(`http://127.0.0.1:${relay.port}/pair`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token-incorrecto' },
    });
    expect(res.status).toBe(401);
  });

  test('POST /pair con token válido → 200 con code de 6 dígitos + expiresIn', async () => {
    const relay = startRelay();
    const res = await fetch(`http://127.0.0.1:${relay.port}/pair`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { code: string; expiresIn: number };
    expect(body.code).toMatch(/^\d{6}$/);
    expect(body.expiresIn).toBeGreaterThan(0);
    expect(body.expiresIn).toBeLessThanOrEqual(300);
  });

  test('GET /health accesible sin token', async () => {
    const relay = startRelay();
    const res = await fetch(`http://127.0.0.1:${relay.port}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, service: 'libredeck-relay' });
  });

  test('GET /stats accesible sin token y no filtra ids ni pubKeys', async () => {
    const relay = startRelay();
    const id = generateIdentity();
    const ws = await connect(relay.port, TOKEN);
    try {
      await nextOf(ws, (m) => m.type === 'connected');
      ws.send(JSON.stringify(msg('register', { from: 'dev-s3cr3t', payload: { deviceId: 'dev-s3cr3t', pubKey: id.publicKey } })));
      await nextOf(ws, (m) => m.type === 'registered');

      const res = await fetch(`http://127.0.0.1:${relay.port}/stats`); // sin token
      expect(res.status).toBe(200);
      const stats = (await res.json()) as Record<string, unknown>;
      expect(stats.online).toBe(1);
      expect(stats.devices).toBe(1);
      const raw = JSON.stringify(stats);
      expect(raw).not.toContain('dev-s3cr3t'); // sin deviceIds
      expect(raw).not.toContain(id.publicKey); // sin pubKeys
    } finally {
      ws.close();
    }
  });

  test('rate-limit HTTP: 61 POST /pair desde la misma IP → el 61º es 429', async () => {
    const relay = startRelay();
    const base = `http://127.0.0.1:${relay.port}`;
    const headers = { Authorization: `Bearer ${TOKEN}` };
    for (let i = 0; i < 60; i++) {
      const res = await fetch(`${base}/pair`, { method: 'POST', headers });
      expect(res.status).toBe(200);
      await res.arrayBuffer(); // drena el body antes de la siguiente
    }
    const limited = await fetch(`${base}/pair`, { method: 'POST', headers });
    expect(limited.status).toBe(429);
    const body = (await limited.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ error: 'rate-limited' });
  });
});
