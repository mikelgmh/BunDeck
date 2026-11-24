import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeviceStore } from '../src/store';
import { PairingStore } from '../src/pairing';
import { RelayServer, extractTunnelToken, getClientIp } from '../src/relay';

const TOKEN = 'ratelimit-webrtc-token';
const servers: RelayServer[] = [];
const stores: DeviceStore[] = [];
const sockets: WebSocket[] = [];

function startRelay(opts: Record<string, unknown> = {}): RelayServer {
  const dir = mkdtempSync(join(tmpdir(), 'relay-ratelimit-webrtc-'));
  const store = new DeviceStore(dir);
  stores.push(store);
  const relay = new RelayServer({ token: TOKEN, store, pairing: new PairingStore(), ...(opts as object) });
  relay.listen(0, '127.0.0.1');
  servers.push(relay);
  return relay;
}

afterEach(async () => {
  for (const s of sockets.splice(0)) {
    try {
      s.close();
    } catch {
      /* noop */
    }
  }
  for (const r of servers.splice(0)) r.stop();
  for (const s of stores.splice(0)) s.close();
  await new Promise((r) => setTimeout(r, 25));
});

describe('rate-limit diferenciado + per-token + webrtc turn', () => {
  test('extractTunnelToken solo acepta hex 32+', () => {
    expect(extractTunnelToken('/t/abcdef0123456789abcdef0123456789/x')).toBe('abcdef0123456789abcdef0123456789');
    expect(extractTunnelToken('/t/corto/x')).toBeNull();
    expect(extractTunnelToken('/t/no-hex-zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz/x')).toBeNull();
    expect(extractTunnelToken('/ui/abc')).toBeNull();
  });

  test('/t/* por token: buckets independientes con misma IP', async () => {
    const relay = startRelay({ rateLimitT: 5 });
    const base = `http://127.0.0.1:${relay.port}`;
    const tokA = 'a'.repeat(64);
    const tokB = 'b'.repeat(64);
    // 5 con tokenA OK (401 invalid-token cuenta igual para el bucket)
    for (let i = 0; i < 5; i++) {
      const r = await fetch(`${base}/t/${tokA}/api/v1/profiles`);
      expect([401, 502, 504]).toContain(r.status);
      await r.arrayBuffer();
    }
    // 6º con tokenA → 429
    const limited = await fetch(`${base}/t/${tokA}/api/v1/profiles`);
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('5');
    await limited.arrayBuffer();
    // tokenB con misma IP sigue OK (bucket distinto)
    const okB = await fetch(`${base}/t/${tokB}/api/v1/profiles`);
    expect([401, 502, 504]).toContain(okB.status);
    await okB.arrayBuffer();
  });

  test('/ui/* con límite propio 120 por defecto: 60 ráfaga OK', async () => {
    const relay = startRelay();
    const base = `http://127.0.0.1:${relay.port}`;
    for (let i = 0; i < 60; i++) {
      const r = await fetch(`${base}/ui/codigo-inexistente-${i}/status`);
      expect(r.status).toBe(200);
      await r.arrayBuffer();
    }
  });

  test('ui-bind con turn → status devuelve turn+rtc solo en primer poll', async () => {
    const relay = startRelay();
    const base = `http://127.0.0.1:${relay.port}`;
    const ws = new WebSocket(`ws://127.0.0.1:${relay.port}/?token=${TOKEN}`);
    sockets.push(ws);
    const buf: Array<Record<string, unknown>> = [];
    ws.addEventListener('message', (e) => {
      try {
        buf.push(JSON.parse(String((e as MessageEvent).data)));
      } catch {
        /* noop */
      }
    });
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true } as object);
      ws.addEventListener('error', () => reject(new Error('ws open failed')), { once: true } as object);
    });
    const send = (o: unknown) => ws.send(JSON.stringify(o));
    const next = async (pred: (m: Record<string, unknown>) => boolean, timeoutMs = 3000) => {
      const take = () => {
        const i = buf.findIndex(pred);
        return i >= 0 ? buf.splice(i, 1)[0]! : undefined;
      };
      const hit = take();
      if (hit) return hit;
      const t0 = Date.now();
      while (Date.now() - t0 < timeoutMs) {
        await new Promise((r) => setTimeout(r, 5));
        const m = take();
        if (m) return m;
      }
      throw new Error('timeout waiting daemon msg');
    };
    send({ v: 1, kind: 'tunnel-register', deviceId: 'dev-turn-1' });
    await next((m) => m.kind === 'tunnel-registered');
    const urlCode = 'turntestcode123';
    send({ v: 1, kind: 'ui-publish', urlCode, exp: Date.now() + 600_000 });
    await next((m) => m.kind === 'ui-published');
    await fetch(`${base}/ui/${urlCode}`);
    const req = await next((m) => m.kind === 'ui-request');
    send({ v: 1, kind: 'ui-decision', reqId: req.reqId, allow: true });
    await next((m) => m.kind === 'ui-decision-ack');
    const sessionToken = 'c'.repeat(64);
    const turn = { urls: ['stun:stun.l.google.com:19302'], username: 'u1', credential: 'p1', ttl: 3600 };
    send({ v: 1, kind: 'ui-bind', urlCode, sessionToken, exp: Date.now() + 600_000, turn });
    await next((m) => m.kind === 'ui-bound');
    const s1 = (await (await fetch(`${base}/ui/${urlCode}/status`)).json()) as Record<string, unknown>;
    expect(s1.status).toBe('approved');
    expect(s1.sessionToken).toBe(sessionToken);
    expect(s1.turn).toMatchObject({ urls: turn.urls, username: 'u1' });
    expect(s1.rtc).toBe(true);
    const s2 = (await (await fetch(`${base}/ui/${urlCode}/status`)).json()) as Record<string, unknown>;
    expect(s2.status).toBe('approved');
    expect(s2.sessionToken).toBeUndefined();
    expect(s2.turn).toBeUndefined();
  });

  test('getClientIp respeta X-Forwarded-For solo con trustProxy', () => {
    const fakeServer = { requestIP: () => ({ address: '10.0.0.1' }) } as never;
    const req = new Request('http://x/', { headers: { 'x-forwarded-for': '1.2.3.4, 10.0.0.1' } });
    expect(getClientIp(req, fakeServer, false)).toBe('10.0.0.1');
    expect(getClientIp(req, fakeServer, true)).toBe('1.2.3.4');
  });
});
