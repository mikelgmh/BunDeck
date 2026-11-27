import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeviceStore } from '../src/store';
import { PairingStore } from '../src/pairing';
import { RelayServer } from '../src/relay';

const TOKEN = 'test-ws-data-token';
const servers: RelayServer[] = [];
const stores: DeviceStore[] = [];
const sockets: WebSocket[] = [];

function startRelay(opts: Record<string, unknown> = {}): RelayServer {
  const dir = mkdtempSync(join(tmpdir(), 'relay-ws-data-'));
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

/** Daemon falso mínimo: registra, publica y auto-responde http-req. */
class FakeDaemon {
  ws!: WebSocket;
  buf: any[] = [];

  async connect(port: number): Promise<this> {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${TOKEN}`);
    sockets.push(this.ws);
    this.ws.addEventListener('message', (e) => {
      let m: any = null;
      try {
        m = JSON.parse(String((e as MessageEvent).data));
      } catch {
        return;
      }
      this.buf.push(m);
      try {
        if (m.kind === 'http-req') {
          this.ws.send(
            JSON.stringify({
              v: 1,
              kind: 'http-res',
              id: m.id,
              status: 200,
              headers: { 'content-type': 'text/plain' },
              bodyB64: Buffer.from(`ok:${m.path}`, 'utf8').toString('base64'),
            }),
          );
        }
      } catch {
        /* el test decide */
      }
    });
    await new Promise<void>((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve(), { once: true });
      this.ws.addEventListener('error', () => reject(new Error('daemon connect failed')), { once: true });
    });
    return this;
  }

  send(o: unknown): void {
    this.ws.send(JSON.stringify(o));
  }

  next(pred: (m: any) => boolean, timeoutMs = 3000): Promise<any> {
    const take = (): any | undefined => {
      const i = this.buf.findIndex(pred);
      return i >= 0 ? this.buf.splice(i, 1)[0] : undefined;
    };
    const hit = take();
    if (hit !== undefined) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        clearInterval(poll);
        reject(new Error('timeout waiting for daemon message'));
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
}

const CODE = 'wsdatacode-abc123';
const TOK = 'cd'.repeat(32);

async function approvedSession(relay: RelayServer): Promise<{ d: FakeDaemon; base: string }> {
  const base = `http://127.0.0.1:${relay.port}`;
  const d = await new FakeDaemon().connect(relay.port);
  d.send({ v: 1, kind: 'tunnel-register', deviceId: 'daemon-ws-data' });
  await d.next((m) => m.kind === 'tunnel-registered');
  d.send({ v: 1, kind: 'ui-publish', urlCode: CODE, exp: Date.now() + 600_000 });
  await d.next((m) => m.kind === 'ui-published');
  await fetch(`${base}/ui/${CODE}`);
  const req = await d.next((m) => m.kind === 'ui-request');
  d.send({ v: 1, kind: 'ui-decision', reqId: req.reqId, allow: true });
  await d.next((m) => m.kind === 'ui-decision-ack');
  d.send({ v: 1, kind: 'ui-bind', urlCode: CODE, sessionToken: TOK, exp: Date.now() + 600_000 });
  await d.next((m) => m.kind === 'ui-bound');
  await (await fetch(`${base}/ui/${CODE}/status`)).json();
  return { d, base };
}

describe('rate-limit WS diferenciado control/datos', () => {
  test('ráfaga de http-res (20) pasa con el bucket de datos aunque el control sea estrecho', async () => {
    const relay = startRelay({ rateLimitWs: 10, rateLimitWsData: 600 });
    const { base } = await approvedSession(relay);
    // register+publish+decision+bind = 4 de control (límite 10); los 20
    // http-res van al bucket de datos (600). Con el limiter único viejo
    // (10) la ráfaga se habría descartado a partir del 11º mensaje.
    for (let i = 0; i < 20; i++) {
      const r = await fetch(`${base}/t/${TOK}/asset-${i}.js`);
      expect(r.status).toBe(200);
      expect(await r.text()).toBe(`ok:/asset-${i}.js`);
    }
    const stats = (await (await fetch(`${base}/stats`)).json()) as Record<string, unknown>;
    expect(stats.rateLimitedWsData).toBe(0);
  });

  test('el plano de control sigue limitado (tunnel-ping extra → rate-limited)', async () => {
    const relay = startRelay({ rateLimitWs: 3 });
    const d = await new FakeDaemon().connect(relay.port);
    d.send({ v: 1, kind: 'tunnel-register', deviceId: 'daemon-ctrl' });
    await d.next((m) => m.kind === 'tunnel-registered');
    // register consume 1 de 3; solo 2 pings más pasan.
    for (let i = 0; i < 5; i++) d.send({ v: 1, kind: 'tunnel-ping', ts: Date.now() });
    const err = await d.next((m) => m.kind === 'error' && m.error === 'rate-limited', 5000);
    expect(err.error).toBe('rate-limited');
    const stats = (await (await fetch(`http://127.0.0.1:${relay.port}/stats`)).json()) as Record<string, unknown>;
    expect(Number(stats.rateLimitedWsControl)).toBeGreaterThanOrEqual(1);
  });

  test('http-res descartado por rate-limit hace fail-fast 429 (no cuelga 30 s)', async () => {
    const relay = startRelay({ rateLimitWsData: 2, httpTimeoutMs: 15_000 });
    const { base } = await approvedSession(relay);
    // 2 http-res consumen el bucket de datos…
    for (let i = 0; i < 2; i++) {
      const r = await fetch(`${base}/t/${TOK}/ok-${i}`);
      expect(r.status).toBe(200);
      await r.arrayBuffer();
    }
    // …el 3º se descarta pero resuelve el httpPending con 429 inmediato.
    const t0 = Date.now();
    const r = await fetch(`${base}/t/${TOK}/colgada`);
    const elapsed = Date.now() - t0;
    expect(r.status).toBe(429);
    expect(elapsed).toBeLessThan(8000); // muy por debajo del httpTimeoutMs de 15 s
    expect(await r.json()).toEqual({ error: 'rate-limited' });
    const stats = (await (await fetch(`${base}/stats`)).json()) as Record<string, unknown>;
    expect(Number(stats.rateLimitedWsData)).toBeGreaterThanOrEqual(1);
  });
});
