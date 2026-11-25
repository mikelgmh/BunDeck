import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeviceStore } from '../src/store';
import { PairingStore } from '../src/pairing';
import { RelayServer } from '../src/relay';

const TOKEN = 'test-relay-token';
const servers: RelayServer[] = [];
const stores: DeviceStore[] = [];
const sockets: WebSocket[] = [];

function startRelay(): RelayServer {
  const dir = mkdtempSync(join(tmpdir(), 'relay-revoke-test-'));
  const store = new DeviceStore(dir);
  stores.push(store);
  const relay = new RelayServer({ token: TOKEN, store, pairing: new PairingStore() });
  relay.listen(0, '127.0.0.1');
  servers.push(relay);
  return relay;
}

afterEach(async () => {
  for (const s of sockets.splice(0)) {
    try { s.close(); } catch { /* noop */ }
  }
  for (const r of servers.splice(0)) r.stop();
  for (const s of stores.splice(0)) s.close();
  await new Promise((r) => setTimeout(r, 25));
});

class FakeDaemon {
  ws!: WebSocket;
  buf: any[] = [];
  httpHandler: ((m: any) => void) | null = null;

  async connect(port: number): Promise<this> {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${TOKEN}`);
    sockets.push(this.ws);
    this.ws.addEventListener('message', (e) => {
      let m: any = null;
      try { m = JSON.parse(String((e as MessageEvent).data)); } catch { return; }
      this.buf.push(m);
      try { if (m.kind === 'http-req' && this.httpHandler) this.httpHandler(m); } catch { /* test */ }
    });
    await new Promise<void>((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve(), { once: true });
      this.ws.addEventListener('error', () => reject(new Error('daemon connect failed')), { once: true });
    });
    return this;
  }

  send(o: unknown): void { this.ws.send(JSON.stringify(o)); }

  next(pred: (m: any) => boolean, timeoutMs = 3000): Promise<any> {
    const take = (): any | undefined => {
      const i = this.buf.findIndex(pred);
      return i >= 0 ? this.buf.splice(i, 1)[0] : undefined;
    };
    const hit = take();
    if (hit !== undefined) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { clearInterval(poll); reject(new Error('timeout')); }, timeoutMs);
      const poll = setInterval(() => {
        const m = take();
        if (m !== undefined) { clearTimeout(timer); clearInterval(poll); resolve(m); }
      }, 5);
    });
  }
}

const CODE = 'revoke-code-abc123';
const TOK = 'cd'.repeat(32);

async function bindSession(port: number): Promise<FakeDaemon> {
  const d = await new FakeDaemon().connect(port);
  d.send({ v: 1, kind: 'tunnel-register', deviceId: 'daemon-revoke-1' });
  await d.next((m) => m.kind === 'tunnel-registered');
  d.send({ v: 1, kind: 'ui-publish', urlCode: CODE, exp: Date.now() + 600_000 });
  await d.next((m) => m.kind === 'ui-published');
  await fetch(`http://127.0.0.1:${port}/ui/${CODE}`);
  const req = await d.next((m) => m.kind === 'ui-request');
  d.send({ v: 1, kind: 'ui-decision', reqId: req.reqId, allow: true });
  await d.next((m) => m.kind === 'ui-decision-ack');
  d.send({ v: 1, kind: 'ui-bind', urlCode: CODE, sessionToken: TOK, exp: Date.now() + 600_000 });
  await d.next((m) => m.kind === 'ui-bound');
  return d;
}

describe('revocación corta relay: tráfico + puente WS', () => {
  test('publish→bind→aprobar→unbind: /t da 401, puente WS se cierra y no revalida', async () => {
    const relay = startRelay();
    const base = `http://127.0.0.1:${relay.port}`;
    const d = await bindSession(relay.port);
    d.httpHandler = (m) => {
      d.send({ v: 1, kind: 'http-res', id: m.id, status: 200, headers: { 'content-type': 'text/plain' }, bodyB64: Buffer.from('ok', 'utf8').toString('base64') });
    };

    // Sesión viva: HTTP y WS funcionan.
    const ok = await fetch(`${base}/t/${TOK}/hello`);
    expect(ok.status).toBe(200);
    const ws = new WebSocket(`ws://127.0.0.1:${relay.port}/t/${TOK}/ws`);
    sockets.push(ws);
    const closed = new Promise((resolve) => {
      ws.addEventListener('close', (e) => resolve((e as CloseEvent).code));
    });
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true });
      ws.addEventListener('error', () => reject(new Error('browser connect failed')), { once: true });
    });

    // Revocar.
    d.send({ v: 1, kind: 'ui-unbind', sessionToken: TOK });
    const ack = await d.next((m) => m.kind === 'ui-unbound');
    expect(ack.sessionToken).toBe(TOK);

    // El puente abierto se cierra y el HTTP posterior da 401.
    expect(await closed).toBe(1008);
    const gone = await fetch(`${base}/t/${TOK}/hello`);
    expect(gone.status).toBe(401);
    expect(await gone.json()).toEqual({ error: 'invalid-token' });
    // El daemon recibió el aviso para limpiar su lado del puente.
    const wsClose = await d.next((m) => m.kind === 'ws-close');
    expect(typeof wsClose.id).toBe('string');
    // Nuevo WS con el token revocado no abre.
    const ws2 = new WebSocket(`ws://127.0.0.1:${relay.port}/t/${TOK}/ws`);
    sockets.push(ws2);
    const code2 = await new Promise((resolve) => {
      ws2.addEventListener('close', (e) => resolve((e as CloseEvent).code));
      ws2.addEventListener('open', () => resolve(0));
    });
    expect(code2).not.toBe(0);
    // Poll del código: expired (no vuelve a approved).
    const st = await (await fetch(`${base}/ui/${CODE}/status`)).json();
    expect(st.status).toBe('expired');
  });

  test('unbind falla peticiones HTTP en vuelo con 401 (no esperan al timeout)', async () => {
    const relay = startRelay();
    const base = `http://127.0.0.1:${relay.port}`;
    const d = await bindSession(relay.port);
    // El daemon tarda en responder a propósito.
    d.httpHandler = (_m) => { /* sin respuesta: queda en vuelo */ };

    const flight = fetch(`${base}/t/${TOK}/lento`);
    await new Promise((r) => setTimeout(r, 150));
    d.send({ v: 1, kind: 'ui-unbind', sessionToken: TOK });
    await d.next((m) => m.kind === 'ui-unbound');
    const res = await flight;
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'invalid-token' });
  });

  test('sesión rebind (sin código) también se revoca: 401 + polls expired', async () => {
    const relay = startRelay();
    const base = `http://127.0.0.1:${relay.port}`;
    const d = await new FakeDaemon().connect(relay.port);
    d.send({ v: 1, kind: 'tunnel-register', deviceId: 'daemon-rebind-1' });
    await d.next((m) => m.kind === 'tunnel-registered');
    d.httpHandler = (m) => {
      d.send({ v: 1, kind: 'http-res', id: m.id, status: 200, headers: { 'content-type': 'text/plain' }, bodyB64: Buffer.from('rebind-ok', 'utf8').toString('base64') });
    };
    d.send({ v: 1, kind: 'ui-rebind', sessionToken: TOK, exp: Date.now() + 600_000 });
    await d.next((m) => m.kind === 'ui-rebound');
    expect((await fetch(`${base}/t/${TOK}/p`)).status).toBe(200);

    d.send({ v: 1, kind: 'ui-unbind', sessionToken: TOK });
    await d.next((m) => m.kind === 'ui-unbound');
    expect((await fetch(`${base}/t/${TOK}/p`)).status).toBe(401);
  });
});
