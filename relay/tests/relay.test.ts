import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeviceStore } from '../src/store';
import { PairingStore } from '../src/pairing';
import { RelayServer } from '../src/relay';
import { generateIdentity, openFromOpaque, sealToOpaque } from '../src/crypto';

const TOKEN = 'test-relay-token';
const servers: RelayServer[] = [];
const stores: DeviceStore[] = [];

function startRelay(): RelayServer {
  const dir = mkdtempSync(join(tmpdir(), 'relay-test-'));
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

function connect(port: number, token = TOKEN): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${token}`);
    // Buffer permanente desde la creación: ningún mensaje se pierde
    // aunque llegue antes de enganchar el wait (evita races con 'connected').
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

async function register(ws: WebSocket, deviceId: string, pubKey: string): Promise<void> {
  ws.send(JSON.stringify(msg('register', { from: deviceId, payload: { deviceId, pubKey } })));
  await nextOf(ws, (m) => m.type === 'registered');
}

describe('relay integration', () => {
  test('routing: A -> B entrega el opaco intacto; el relay no ve el plaintext', async () => {
    const relay = startRelay();
    const a = generateIdentity();
    const b = generateIdentity();

    const wsA = await connect(relay.port);
    const wsB = await connect(relay.port);
    try {
      // Consume el 'connected' inicial en ambos.
      await Promise.all([
        nextOf(wsA, (m) => m.type === 'connected'),
        nextOf(wsB, (m) => m.type === 'connected'),
      ]);
      await register(wsA, 'dev-a', a.publicKey);
      await register(wsB, 'dev-b', b.publicKey);

      const secret = ' Pulsa botón 7 ';
      const opaque = sealToOpaque(secret, b.publicKey, a.secretKey);
      const delivered = nextOf(wsB, (m) => m.type === 'signal');
      wsA.send(
        JSON.stringify(msg('signal', { to: 'dev-b', payloadEncrypted: opaque })),
      );
      const got = await delivered;
      expect(got.from).toBe('dev-a');
      expect(got.to).toBe('dev-b');
      expect(got.payloadEncrypted).toBe(opaque); // el relay no tocó el cifrado
      expect(Buffer.from(openFromOpaque(got.payloadEncrypted, b.secretKey)!).toString('utf8')).toBe(secret);
    } finally {
      wsA.close();
      wsB.close();
    }
  });

  test('sin cola: destino offline -> {type:error, reason:offline}', async () => {
    const relay = startRelay();
    const a = generateIdentity();
    const wsA = await connect(relay.port);
    try {
      await nextOf(wsA, (m) => m.type === 'connected');
      await register(wsA, 'dev-a', a.publicKey);
      const errP = nextOf(wsA, (m) => m.type === 'error');
      wsA.send(JSON.stringify(msg('signal', { to: 'ghost', payloadEncrypted: 'opaco' })));
      const errm = await errP;
      expect(errm.reason).toBe('offline');
    } finally {
      wsA.close();
    }
  });

  test('pairing: POST /pair genera código; request-pair lo consume una vez', async () => {
    const relay = startRelay();
    const base = `http://127.0.0.1:${relay.port}`;

    const res = await fetch(`${base}/pair`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const { code, expiresIn } = (await res.json()) as { code: string; expiresIn: number };
    expect(code).toMatch(/^\d{6}$/);
    expect(expiresIn).toBeLessThanOrEqual(300);

    // Sin token no se puede generar.
    const denied = await fetch(`${base}/pair`, { method: 'POST' });
    expect(denied.status).toBe(401);

    const a = generateIdentity();
    const wsA = await connect(relay.port);
    try {
      await nextOf(wsA, (m) => m.type === 'connected');
      await register(wsA, 'dev-a', a.publicKey);
      wsA.send(JSON.stringify(msg('request-pair', { payload: { code } })));
      const paired = await nextOf(wsA, (m) => m.type === 'paired');
      expect(paired.payload).toMatchObject({ paired: true });
      // Reutilizar el mismo código falla.
      wsA.send(JSON.stringify(msg('request-pair', { payload: { code } })));
      const errm = await nextOf(wsA, (m) => m.type === 'error');
      expect(errm.reason).toBe('invalid-code');
    } finally {
      wsA.close();
    }
  });

  test('expirados y sobredimensionados se rechazan', async () => {
    const relay = startRelay();
    const a = generateIdentity();
    const wsA = await connect(relay.port);
    try {
      await nextOf(wsA, (m) => m.type === 'connected');
      await register(wsA, 'dev-a', a.publicKey);

      // exp hace 10 min (> skew 5 min) -> expired.
      wsA.send(JSON.stringify({ ...msg('ping'), exp: Date.now() - 10 * 60_000 }));
      expect((await nextOf(wsA, (m) => m.type === 'error')).reason).toBe('expired');

      // > 64 KB -> too-large.
      wsA.send(JSON.stringify({ ...msg('ping'), payloadEncrypted: 'x'.repeat(70 * 1024) }));
      expect((await nextOf(wsA, (m) => m.type === 'error')).reason).toBe('too-large');
    } finally {
      wsA.close();
    }
  });

  test('ping/pong y /health + /stats sin datos sensibles', async () => {
    const relay = startRelay();
    const a = generateIdentity();
    const wsA = await connect(relay.port);
    try {
      await nextOf(wsA, (m) => m.type === 'connected');
      await register(wsA, 'dev-a', a.publicKey);
      wsA.send(JSON.stringify(msg('ping')));
      expect((await nextOf(wsA, (m) => m.type === 'pong')).type).toBe('pong');

      const base = `http://127.0.0.1:${relay.port}`;
      const health = (await (await fetch(`${base}/health`)).json()) as Record<string, unknown>;
      expect(health.ok).toBe(true);
      const stats = (await (await fetch(`${base}/stats`)).json()) as Record<string, unknown>;
      expect(stats.online).toBe(1);
      expect(stats.devices).toBe(1);
      const raw = JSON.stringify(stats);
      expect(raw).not.toContain('dev-a'); // sin ids
      expect(raw).not.toContain(a.publicKey); // sin pubkeys
    } finally {
      wsA.close();
    }
  });

  test('sin token no se puede conectar el WS', async () => {
    const relay = startRelay();
    const ws = new WebSocket(`ws://127.0.0.1:${relay.port}/`);
    const closed = await new Promise<string>((resolve) => {
      ws.addEventListener('close', (e) => resolve(`close:${(e as CloseEvent).code}`));
      ws.addEventListener('open', () => resolve('open'));
      setTimeout(() => resolve('timeout'), 3000);
    });
    expect(closed).not.toBe('open');
    try {
      ws.close();
    } catch {
      /* noop */
    }
  });
});
