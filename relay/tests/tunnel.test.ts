import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeviceStore } from '../src/store';
import { PairingStore } from '../src/pairing';
import { RelayServer } from '../src/relay';
import { setUiPageHandler, TunnelState } from '../src/tunnel';

const TOKEN = 'test-relay-token';
const servers: RelayServer[] = [];
const stores: DeviceStore[] = [];
const sockets: WebSocket[] = [];

function startRelay(opts: { rateLimitPerMin?: number; uiRequestTimeoutMs?: number; httpTimeoutMs?: number } = {}): RelayServer {
  const dir = mkdtempSync(join(tmpdir(), 'relay-tunnel-test-'));
  const store = new DeviceStore(dir);
  stores.push(store);
  const relay = new RelayServer({ token: TOKEN, store, pairing: new PairingStore(), ...opts });
  relay.listen(0, '127.0.0.1'); // puerto efímero
  servers.push(relay);
  return relay;
}

afterEach(async () => {
  setUiPageHandler(null);
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

/** Daemon falso: habla `kind:*` y permite auto-responder http/ws. */
class FakeDaemon {
  ws!: WebSocket;
  buf: any[] = [];
  httpHandler: ((m: any) => void) | null = null;
  wsHandler: ((m: any) => void) | null = null;

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
        if (m.kind === 'http-req' && this.httpHandler) this.httpHandler(m);
        else if ((m.kind === 'ws-open' || m.kind === 'ws-msg' || m.kind === 'ws-close') && this.wsHandler) {
          this.wsHandler(m);
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

  clear(): void {
    this.buf = [];
  }
}

const CODE = 'testcode-abc123'; // 15 chars (>= 12)
const TOK = 'ab'.repeat(32); // 64 hex chars

async function registeredDaemon(port: number, deviceId = 'daemon-1'): Promise<FakeDaemon> {
  const d = await new FakeDaemon().connect(port);
  d.send({ v: 1, kind: 'tunnel-register', deviceId });
  const ack = await d.next((m) => m.kind === 'tunnel-registered');
  expect(ack.deviceId).toBe(deviceId);
  return d;
}

async function publishedCode(d: FakeDaemon, code = CODE, exp = Date.now() + 600_000): Promise<void> {
  d.send({ v: 1, kind: 'ui-publish', urlCode: code, exp });
  const ack = await d.next((m) => m.kind === 'ui-published');
  expect(ack.urlCode).toBe(code);
}

async function statusOf(base: string, code: string): Promise<any> {
  const res = await fetch(`${base}/ui/${code}/status`);
  expect(res.status).toBe(200);
  return res.json();
}

function browserMessages(): { ws: WebSocket; buf: any[]; next: (pred: (m: any) => boolean, t?: number) => Promise<any> } {
  const buf: any[] = [];
  const next = (pred: (m: any) => boolean, timeoutMs = 3000): Promise<any> => {
    const take = (): any | undefined => {
      const i = buf.findIndex(pred);
      return i >= 0 ? buf.splice(i, 1)[0] : undefined;
    };
    const hit = take();
    if (hit !== undefined) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        clearInterval(poll);
        reject(new Error('timeout waiting for browser message'));
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
  };
  const ws = null as unknown as WebSocket;
  return { ws, buf, next };
}

async function connectBrowser(url: string): Promise<{ ws: WebSocket; buf: any[]; next: (pred: (m: any) => boolean, t?: number) => Promise<any> }> {
  const helper = browserMessages();
  const ws = new WebSocket(url);
  sockets.push(ws);
  (ws as any).binaryType = 'arraybuffer';
  ws.addEventListener('message', (e) => {
    helper.buf.push((e as MessageEvent).data);
  });
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true });
    ws.addEventListener('error', () => reject(new Error('browser connect failed')), { once: true });
  });
  return { ws, buf: helper.buf, next: helper.next };
}

describe('túnel inverso', () => {
  test('register + publish + status pending', async () => {
    const relay = startRelay();
    const base = `http://127.0.0.1:${relay.port}`;
    const d = await registeredDaemon(relay.port);
    await publishedCode(d);
    expect(await statusOf(base, CODE)).toEqual({ status: 'pending' });
  });

  test('primera visita a /ui/<code> dispara ui-request (una sola vez)', async () => {
    const relay = startRelay();
    const base = `http://127.0.0.1:${relay.port}`;
    const d = await registeredDaemon(relay.port);
    await publishedCode(d);
    d.clear();

    const page = await fetch(`${base}/ui/${CODE}`, { headers: { 'user-agent': 'TestBrowser/1.0' } });
    expect(page.status).toBe(404); // sin waiting.ts: hueco documentado
    expect(await page.json()).toEqual({ error: 'ui-page-missing' });

    const req = await d.next((m) => m.kind === 'ui-request');
    expect(req.urlCode).toBe(CODE);
    expect(typeof req.reqId).toBe('string');
    expect(req.ua).toBe('TestBrowser/1.0');
    expect(typeof req.ip).toBe('string');

    // Segunda visita: no reenvía.
    d.clear();
    await fetch(`${base}/ui/${CODE}`);
    await new Promise((r) => setTimeout(r, 200));
    expect(d.buf.filter((m) => m.kind === 'ui-request')).toHaveLength(0);
  });

  test('deny → denied', async () => {
    const relay = startRelay();
    const base = `http://127.0.0.1:${relay.port}`;
    const d = await registeredDaemon(relay.port);
    await publishedCode(d);
    await fetch(`${base}/ui/${CODE}`);
    const req = await d.next((m) => m.kind === 'ui-request');

    d.send({ v: 1, kind: 'ui-decision', reqId: req.reqId, allow: false });
    const ack = await d.next((m) => m.kind === 'ui-decision-ack');
    expect(ack.allow).toBe(false);
    expect(await statusOf(base, CODE)).toEqual({ status: 'denied' });
  });

  test('allow + bind → approved con token (una sola vez)', async () => {
    const relay = startRelay();
    const base = `http://127.0.0.1:${relay.port}`;
    const d = await registeredDaemon(relay.port);
    await publishedCode(d);
    await fetch(`${base}/ui/${CODE}`);
    const req = await d.next((m) => m.kind === 'ui-request');

    d.send({ v: 1, kind: 'ui-decision', reqId: req.reqId, allow: true });
    await d.next((m) => m.kind === 'ui-decision-ack');
    // Aprobado pero aún sin bind: sigue pending.
    expect(await statusOf(base, CODE)).toEqual({ status: 'pending' });

    d.send({ v: 1, kind: 'ui-bind', urlCode: CODE, sessionToken: TOK, exp: Date.now() + 600_000 });
    const bound = await d.next((m) => m.kind === 'ui-bound');
    expect(bound.urlCode).toBe(CODE);

    expect(await statusOf(base, CODE)).toEqual({ status: 'approved', sessionToken: TOK });
    // Segundo poll: approved pero sin token.
    expect(await statusOf(base, CODE)).toEqual({ status: 'approved' });
  });

  test('el QR caduca, pero la sesión aprobada sigue viva y el URL no se reutiliza', () => {
    let now = 1_000;
    const state = new TunnelState({ now: () => now });
    const socket = { send: () => true, close: () => {} };
    state.registerDevice(socket, 'daemon-expiry');
    expect(state.publish(socket, CODE, 10_000)).toEqual({ deviceId: 'daemon-expiry' });

    const request = state.ensureRequest(CODE, { ua: 'Mobile', ip: '127.0.0.1' });
    expect('reqId' in request).toBe(true);
    if (!('reqId' in request)) throw new Error('request was not created');
    expect(state.decide(request.reqId, true)).toBe('ok');
    expect(state.bind(CODE, TOK, 30_000)).toBe('ok');
    expect(state.status(CODE)).toEqual({ status: 'approved', sessionToken: TOK });

    now = 11_000;
    state.prune();
    expect(state.status(CODE)).toEqual({ status: 'approved' });
    expect(state.ensureRequest(CODE, { ua: 'Another mobile', ip: '127.0.0.2' })).toMatchObject({ state: 'bound' });

    now = 30_001;
    state.prune();
    expect(state.status(CODE)).toEqual({ status: 'expired' });
  });

  test('http-req → http-res roundtrip con eco (GET con query, POST con cuerpo)', async () => {
    const relay = startRelay();
    const base = `http://127.0.0.1:${relay.port}`;
    const d = await registeredDaemon(relay.port);
    d.httpHandler = (m) => {
      const bodyText = m.bodyB64 ? Buffer.from(m.bodyB64, 'base64').toString('utf8') : '';
      d.send({
        v: 1,
        kind: 'http-res',
        id: m.id,
        status: 200,
        headers: { 'content-type': 'text/plain', 'x-echo-path': m.path },
        bodyB64: Buffer.from(`echo:${m.method}:${m.path}:${bodyText}`).toString('base64'),
      });
    };
    await publishedCode(d);
    await fetch(`${base}/ui/${CODE}`);
    const req = await d.next((m) => m.kind === 'ui-request');
    d.send({ v: 1, kind: 'ui-decision', reqId: req.reqId, allow: true });
    await d.next((m) => m.kind === 'ui-decision-ack');
    d.send({ v: 1, kind: 'ui-bind', urlCode: CODE, sessionToken: TOK, exp: Date.now() + 600_000 });
    await d.next((m) => m.kind === 'ui-bound');
    await statusOf(base, CODE);

    const get = await fetch(`${base}/t/${TOK}/hello?x=1`);
    expect(get.status).toBe(200);
    expect(get.headers.get('x-echo-path')).toBe('/hello?x=1');
    expect(await get.text()).toBe('echo:GET:/hello?x=1:');

    const post = await fetch(`${base}/t/${TOK}/echo`, { method: 'POST', body: 'hola' });
    expect(post.status).toBe(200);
    expect(await post.text()).toBe('echo:POST:/echo:hola');
  });

  test('respuestas text/html reciben <base href> inyectado', async () => {
    const relay = startRelay();
    const base = `http://127.0.0.1:${relay.port}`;
    const d = await registeredDaemon(relay.port);
    d.httpHandler = (m) => {
      d.send({
        v: 1,
        kind: 'http-res',
        id: m.id,
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8', 'content-length': '999' },
        bodyB64: Buffer.from('<html><head><title>t</title><link rel="stylesheet" href="/_astro/index.css"></head><body><img src="/favicon.svg"><a href="/ui/abc">x</a></body></html>', 'utf8').toString('base64'),
      });
    };
    await publishedCode(d);
    await fetch(`${base}/ui/${CODE}`);
    const req = await d.next((m) => m.kind === 'ui-request');
    d.send({ v: 1, kind: 'ui-decision', reqId: req.reqId, allow: true });
    await d.next((m) => m.kind === 'ui-decision-ack');
    d.send({ v: 1, kind: 'ui-bind', urlCode: CODE, sessionToken: TOK, exp: Date.now() + 600_000 });
    await d.next((m) => m.kind === 'ui-bound');
    await statusOf(base, CODE);

    const res = await fetch(`${base}/t/${TOK}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(`<head><base href="/t/${TOK}/">`);
    expect(html).toContain('<title>t</title>');
    // Assets absolutos reescritos al prefijo del túnel para que carguen en el móvil.
    expect(html).toContain(`href="/t/${TOK}/_astro/index.css"`);
    expect(html).toContain(`src="/t/${TOK}/favicon.svg"`);
    // Las rutas /ui/… del relay no se tocan.
    expect(html).toContain('href="/ui/abc"');
  });

  test('token inválido → 401; token expirado → 401 expired', async () => {
    const relay = startRelay();
    const base = `http://127.0.0.1:${relay.port}`;
    const bad = await fetch(`${base}/t/zzz-no-existe/p`);
    expect(bad.status).toBe(401);
    expect(await bad.json()).toEqual({ error: 'invalid-token' });

    const d = await registeredDaemon(relay.port);
    await publishedCode(d);
    await fetch(`${base}/ui/${CODE}`);
    const req = await d.next((m) => m.kind === 'ui-request');
    d.send({ v: 1, kind: 'ui-decision', reqId: req.reqId, allow: true });
    await d.next((m) => m.kind === 'ui-decision-ack');
    d.send({ v: 1, kind: 'ui-bind', urlCode: CODE, sessionToken: TOK, exp: Date.now() - 1000 });
    await d.next((m) => m.kind === 'ui-bound');

    const exp = await fetch(`${base}/t/${TOK}/p`);
    expect(exp.status).toBe(401);
    expect(await exp.json()).toEqual({ error: 'expired' });
  });

  test('ui-unbind revoca: peticiones → 401 y polls → expired', async () => {
    const relay = startRelay();
    const base = `http://127.0.0.1:${relay.port}`;
    const d = await registeredDaemon(relay.port);
    await publishedCode(d);
    await fetch(`${base}/ui/${CODE}`);
    const req = await d.next((m) => m.kind === 'ui-request');
    d.send({ v: 1, kind: 'ui-decision', reqId: req.reqId, allow: true });
    await d.next((m) => m.kind === 'ui-decision-ack');
    d.send({ v: 1, kind: 'ui-bind', urlCode: CODE, sessionToken: TOK, exp: Date.now() + 600_000 });
    await d.next((m) => m.kind === 'ui-bound');
    expect((await statusOf(base, CODE)).status).toBe('approved');

    d.send({ v: 1, kind: 'ui-unbind', sessionToken: TOK });
    const ack = await d.next((m) => m.kind === 'ui-unbound');
    expect(ack.sessionToken).toBe(TOK);

    const gone = await fetch(`${base}/t/${TOK}/p`);
    expect(gone.status).toBe(401);
    expect(await statusOf(base, CODE)).toEqual({ status: 'expired' });
  });

  test('WS tuneleado: eco texto + binario, cierre avisa al daemon', async () => {
    const relay = startRelay();
    const base = `http://127.0.0.1:${relay.port}`;
    const d = await registeredDaemon(relay.port);
    const opened: string[] = [];
    const closed: string[] = [];
    d.wsHandler = (m) => {
      if (m.kind === 'ws-open') opened.push(m.id);
      else if (m.kind === 'ws-close') closed.push(m.id);
      else if (m.kind === 'ws-msg') {
        d.send({ v: 1, kind: 'ws-msg', id: m.id, dataB64: m.dataB64, isBinary: m.isBinary });
      }
    };
    await publishedCode(d);
    await fetch(`${base}/ui/${CODE}`);
    const req = await d.next((m) => m.kind === 'ui-request');
    d.send({ v: 1, kind: 'ui-decision', reqId: req.reqId, allow: true });
    await d.next((m) => m.kind === 'ui-decision-ack');
    d.send({ v: 1, kind: 'ui-bind', urlCode: CODE, sessionToken: TOK, exp: Date.now() + 600_000 });
    await d.next((m) => m.kind === 'ui-bound');
    await statusOf(base, CODE);

    const b = await connectBrowser(`ws://127.0.0.1:${relay.port}/t/${TOK}/ws`);
    expect(opened).toHaveLength(1);

    b.ws.send('hola-puente');
    expect(await b.next((m) => m === 'hola-puente')).toBe('hola-puente');

    b.ws.send(new Uint8Array([1, 2, 3]));
    const bin = await b.next((m) => m instanceof ArrayBuffer);
    expect([...new Uint8Array(bin as ArrayBuffer)]).toEqual([1, 2, 3]);

    b.ws.close();
    const closedMsg = await d.next((m) => m.kind === 'ws-close');
    expect(closedMsg.id).toBe(opened[0]);
    expect(closed).toContain(opened[0]);
  });

  test('rate-limit en /ui/*', async () => {
    const relay = startRelay({ rateLimitPerMin: 5 });
    const base = `http://127.0.0.1:${relay.port}`;
    const statuses: number[] = [];
    for (let i = 0; i < 8; i++) {
      const r = await fetch(`${base}/ui/codigo-inexistente-${i}/status`);
      statuses.push(r.status);
    }
    expect(statuses.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(statuses.slice(5)).toEqual([429, 429, 429]);
  });

  test('sin respuesta del daemon → 504', async () => {
    const relay = startRelay({ httpTimeoutMs: 200 });
    const base = `http://127.0.0.1:${relay.port}`;
    const d = await registeredDaemon(relay.port);
    // Sin httpHandler: el daemon nunca responde.
    await publishedCode(d);
    await fetch(`${base}/ui/${CODE}`);
    const req = await d.next((m) => m.kind === 'ui-request');
    d.send({ v: 1, kind: 'ui-decision', reqId: req.reqId, allow: true });
    await d.next((m) => m.kind === 'ui-decision-ack');
    d.send({ v: 1, kind: 'ui-bind', urlCode: CODE, sessionToken: TOK, exp: Date.now() + 600_000 });
    await d.next((m) => m.kind === 'ui-bound');
    await statusOf(base, CODE);

    const res = await fetch(`${base}/t/${TOK}/lento`);
    expect(res.status).toBe(504);
    expect(await res.json()).toEqual({ error: 'daemon-timeout' });
  });

  test('sin decisión en el timeout → denied', async () => {
    const relay = startRelay({ uiRequestTimeoutMs: 150 });
    const base = `http://127.0.0.1:${relay.port}`;
    const d = await registeredDaemon(relay.port);
    await publishedCode(d);
    await fetch(`${base}/ui/${CODE}`);
    await d.next((m) => m.kind === 'ui-request');
    await new Promise((r) => setTimeout(r, 300));
    expect(await statusOf(base, CODE)).toEqual({ status: 'denied' });
  });

  test('al caer el socket del daemon se borran publicaciones y sesiones', async () => {
    const relay = startRelay();
    const base = `http://127.0.0.1:${relay.port}`;
    const d = await registeredDaemon(relay.port);
    await publishedCode(d);
    await fetch(`${base}/ui/${CODE}`);
    const req = await d.next((m) => m.kind === 'ui-request');
    d.send({ v: 1, kind: 'ui-decision', reqId: req.reqId, allow: true });
    await d.next((m) => m.kind === 'ui-decision-ack');
    d.send({ v: 1, kind: 'ui-bind', urlCode: CODE, sessionToken: TOK, exp: Date.now() + 600_000 });
    await d.next((m) => m.kind === 'ui-bound');
    expect((await statusOf(base, CODE)).status).toBe('approved');

    d.ws.close();
    await new Promise((r) => setTimeout(r, 200));
    expect(await statusOf(base, CODE)).toEqual({ status: 'expired' });
    const res = await fetch(`${base}/t/${TOK}/p`);
    expect(res.status).toBe(401);
  });

  test('setUiPageHandler sirve la página de espera', async () => {
    const relay = startRelay();
    const base = `http://127.0.0.1:${relay.port}`;
    const d = await registeredDaemon(relay.port);
    await publishedCode(d);
    setUiPageHandler((code) => new Response(`<h1>espera ${code}</h1>`, { headers: { 'content-type': 'text/html' } }));

    const page = await fetch(`${base}/ui/${CODE}`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain(`espera ${CODE}`);
    // La visita también disparó ui-request aunque haya handler.
    const req = await d.next((m) => m.kind === 'ui-request');
    expect(req.urlCode).toBe(CODE);
  });

  test('ui-unpublish da de baja el código: polls → expired', async () => {
    const relay = startRelay();
    const base = `http://127.0.0.1:${relay.port}`;
    const d = await registeredDaemon(relay.port);
    await publishedCode(d);
    expect(await statusOf(base, CODE)).toEqual({ status: 'pending' });

    d.send({ v: 1, kind: 'ui-unpublish', urlCode: CODE });
    const ack = await d.next((m) => m.kind === 'ui-unpublished');
    expect(ack.urlCode).toBe(CODE);
    expect(await statusOf(base, CODE)).toEqual({ status: 'expired' });

    // Código desconocido → error sin romper nada.
    d.send({ v: 1, kind: 'ui-unpublish', urlCode: 'no-existe-12345' });
    const err = await d.next((m) => m.kind === 'error');
    expect(err.error).toBe('unknown-code');
  });

  test('ui-rebind restaura la sesión sin código (sobrevive a la caída del daemon)', async () => {
    const relay = startRelay();
    const base = `http://127.0.0.1:${relay.port}`;
    const echo = (d: FakeDaemon) => {
      d.httpHandler = (m) => {
        d.send({
          v: 1,
          kind: 'http-res',
          id: m.id,
          status: 200,
          headers: { 'content-type': 'text/plain' },
          bodyB64: Buffer.from('ok-rebind', 'utf8').toString('base64'),
        });
      };
    };
    const d = await registeredDaemon(relay.port);
    echo(d);
    // Sesión anunciada solo con rebind (sin publicar código antes).
    d.send({ v: 1, kind: 'ui-rebind', sessionToken: TOK, exp: Date.now() + 600_000 });
    const ack = await d.next((m) => m.kind === 'ui-rebound');
    expect(ack.sessionToken).toBe(TOK);

    const ok = await fetch(`${base}/t/${TOK}/p`);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe('ok-rebind');

    // Cae el daemon (el relay borra todo) y reconecta: re-anuncia y todo vale.
    d.ws.close();
    await new Promise((r) => setTimeout(r, 200));
    expect((await fetch(`${base}/t/${TOK}/p`)).status).toBe(401);

    const d2 = await registeredDaemon(relay.port, 'daemon-1');
    echo(d2);
    d2.send({ v: 1, kind: 'ui-rebind', sessionToken: TOK, exp: Date.now() + 600_000 });
    await d2.next((m) => m.kind === 'ui-rebound');
    const ok2 = await fetch(`${base}/t/${TOK}/p`);
    expect(ok2.status).toBe(200);
    expect(await ok2.text()).toBe('ok-rebind');
  });

  test('ui-rebind valida token, expiración y registro', async () => {
    const relay = startRelay();
    const d = await registeredDaemon(relay.port);
    d.send({ v: 1, kind: 'ui-rebind', sessionToken: 'no-hex', exp: Date.now() + 600_000 });
    expect((await d.next((m) => m.kind === 'error')).error).toBe('bad-token');
    d.send({ v: 1, kind: 'ui-rebind', sessionToken: TOK, exp: Date.now() - 1000 });
    expect((await d.next((m) => m.kind === 'error')).error).toBe('expired');
    d.send({ v: 1, kind: 'ui-rebind', sessionToken: TOK, exp: Date.now() + 30 * 24 * 3600 * 1000 });
    expect((await d.next((m) => m.kind === 'error')).error).toBe('bad-exp');
    // Socket sin registrar: el relay no sabe de qué device es.
    const raw = await new FakeDaemon().connect(relay.port);
    raw.send({ v: 1, kind: 'ui-rebind', sessionToken: TOK, exp: Date.now() + 600_000 });
    expect((await raw.next((m) => m.kind === 'error')).error).toBe('not-registered');
  });

  test('sesiones persistidas sobreviven al reinicio del relay', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-rebind-persist-'));
    const store = new DeviceStore(dir);
    stores.push(store);
    const persist = {
      saveSession: (s: { token: string; deviceId: string; exp: number; urlCode: string; turnJson: string | null }) =>
        store.saveTunnelSession(s),
      deleteSession: (token: string) => store.deleteTunnelSession(token),
      deleteDeviceSessions: (deviceId: string) => store.deleteTunnelSessionsByDevice(deviceId),
      loadSessions: () => store.listTunnelSessions(),
      pruneExpired: (now: number) => store.pruneTunnelSessions(now),
    };
    const mk = (): RelayServer => {
      const r = new RelayServer({ token: TOKEN, store, pairing: new PairingStore(), tunnelPersist: persist });
      r.listen(0, '127.0.0.1');
      servers.push(r);
      return r;
    };
    const relay = mk();
    const d = await registeredDaemon(relay.port);
    d.send({ v: 1, kind: 'ui-publish', urlCode: CODE, exp: Date.now() + 600_000 });
    await d.next((m) => m.kind === 'ui-published');
    d.send({ v: 1, kind: 'ui-bind', urlCode: CODE, sessionToken: TOK, exp: Date.now() + 600_000 });
    await d.next((m) => m.kind === 'ui-bound');
    expect(store.listTunnelSessions().some((s) => s.token === TOK)).toBe(true);

    // Reinicio del relay (misma BD): la sesión sigue en disco y el proxy
    // responde 502 daemon-offline (no 401) hasta que el daemon reconecte.
    relay.stop();
    servers.splice(servers.indexOf(relay), 1);
    const relay2 = mk();
    const base2 = `http://127.0.0.1:${relay2.port}`;
    const res = await fetch(`${base2}/t/${TOK}/p`);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'daemon-offline' });

    // El daemon reconecta y re-anuncia: vuelve a servir sin QR nuevo.
    const d2 = await registeredDaemon(relay2.port, 'daemon-1');
    d2.httpHandler = (m) => {
      d2.send({
        v: 1,
        kind: 'http-res',
        id: m.id,
        status: 200,
        headers: { 'content-type': 'text/plain' },
        bodyB64: Buffer.from('ok-persist', 'utf8').toString('base64'),
      });
    };
    d2.send({ v: 1, kind: 'ui-rebind', sessionToken: TOK, exp: Date.now() + 600_000 });
    await d2.next((m) => m.kind === 'ui-rebound');
    const ok = await fetch(`${base2}/t/${TOK}/p`);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe('ok-persist');
  });

  test('navegación a /t/ con sesión muerta devuelve HTML amable, no JSON', async () => {
    const relay = startRelay();
    const base = `http://127.0.0.1:${relay.port}`;
    const html = await fetch(`${base}/t/zzz-no-existe/`, { headers: { accept: 'text/html' } });
    expect(html.status).toBe(401);
    expect(html.headers.get('content-type') ?? '').toContain('text/html');
    const body = await html.text();
    expect(body).toContain('data-tunnel-gone="invalid-token"');
    expect(body).not.toContain('zzz-no-existe');
    // XHR/API sigue recibiendo JSON.
    const api = await fetch(`${base}/t/zzz-no-existe/api/v1/profiles`, { headers: { accept: 'application/json' } });
    expect(api.status).toBe(401);
    expect(await api.json()).toEqual({ error: 'invalid-token' });
  });
});
