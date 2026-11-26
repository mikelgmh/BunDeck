import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeviceStore } from '../src/store';
import { PairingStore } from '../src/pairing';
import { RelayServer } from '../src/relay';
import { setUiPageHandler, hashSecret, parseCookies, injectBaseForPrefix, isValidSid, isValidSecret } from '../src/tunnel';

const TOKEN = 'test-relay-token';
const servers: RelayServer[] = [];
const stores: DeviceStore[] = [];
const sockets: WebSocket[] = [];

function startRelay(opts: Record<string, unknown> = {}): RelayServer {
  const dir = mkdtempSync(join(tmpdir(), 'relay-sid-test-'));
  const store = new DeviceStore(dir);
  stores.push(store);
  const relay = new RelayServer({ token: TOKEN, store, pairing: new PairingStore(), ...opts });
  relay.listen(0, '127.0.0.1');
  servers.push(relay);
  return relay;
}

afterEach(async () => {
  setUiPageHandler(null);
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
      try {
        if (m.kind === 'http-req' && this.httpHandler) this.httpHandler(m);
      } catch { /* test */ }
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
      const timer = setTimeout(() => { clearInterval(poll); reject(new Error('timeout waiting for daemon message')); }, timeoutMs);
      const poll = setInterval(() => {
        const m = take();
        if (m !== undefined) { clearTimeout(timer); clearInterval(poll); resolve(m); }
      }, 5);
    });
  }
  clear(): void { this.buf = []; }
}

const CODE = 'sidcode-abc123';
const SID = 'ab'.repeat(16); // 32 hex
const SECRET = 'cd'.repeat(32); // 64 hex

async function registeredDaemon(port: number, deviceId = 'daemon-1'): Promise<FakeDaemon> {
  const d = await new FakeDaemon().connect(port);
  d.send({ v: 1, kind: 'tunnel-register', deviceId });
  await d.next((m) => m.kind === 'tunnel-registered');
  return d;
}

async function approveSid(d: FakeDaemon, base: string, code = CODE, sid = SID, secret = SECRET): Promise<{ sid: string; ticket: string }> {
  d.send({ v: 1, kind: 'ui-publish', urlCode: code, exp: Date.now() + 600_000 });
  await d.next((m) => m.kind === 'ui-published');
  await fetch(`${base}/ui/${code}`);
  const req = await d.next((m) => m.kind === 'ui-request');
  d.send({ v: 1, kind: 'ui-decision', reqId: req.reqId, allow: true });
  await d.next((m) => m.kind === 'ui-decision-ack');
  d.send({ v: 1, kind: 'ui-bind', urlCode: code, sid, secret, sessionToken: 'ef'.repeat(32), exp: Date.now() + 600_000 });
  const bound = await d.next((m) => m.kind === 'ui-bound');
  expect(bound.sid).toBe(sid);
  const st = await (await fetch(`${base}/ui/${code}/status`)).json();
  expect(st.status).toBe('approved');
  expect(st.sid).toBe(sid);
  expect(typeof st.ticket).toBe('string');
  return { sid: st.sid, ticket: st.ticket };
}

describe('split-token /s/<sid>/ + cookie', () => {
  test('helpers: sid/secret/hash/cookies/base', () => {
    expect(isValidSid(SID)).toBe(true);
    expect(isValidSid('zzz')).toBe(false);
    expect(isValidSecret(SECRET)).toBe(true);
    expect(isValidSecret('short')).toBe(false);
    expect(hashSecret(SECRET)).toMatch(/^[0-9a-f]{64}$/);
    const m = parseCookies('bundeck_s=abc123; Path=/s/x/');
    expect(m.get('bundeck_s')).toBe('abc123');
    const html = injectBaseForPrefix('<html><head></head><body><a href="/api/x">y</a></body></html>', '/s/abc');
    expect(html).toContain('<base href="/s/abc/">');
    expect(html).toContain('href="/s/abc/api/x"');
  });

  test('status emite sid+ticket (nunca sessionToken en URL)', async () => {
    const relay = startRelay();
    const base = `http://127.0.0.1:${relay.port}`;
    const d = await registeredDaemon(relay.port);
    const { sid, ticket } = await approveSid(d, base);
    expect(sid).toBe(SID);
    expect(ticket).toMatch(/^[0-9a-f]{64}$/);
  });

  test('sin cookie → 401; claim canjea ticket por cookie y el proxy funciona', async () => {
    const relay = startRelay();
    const base = `http://127.0.0.1:${relay.port}`;
    const d = await registeredDaemon(relay.port);
    d.httpHandler = (m) => {
      d.send({ v: 1, kind: 'http-res', id: m.id, status: 200, headers: { 'content-type': 'text/plain' }, bodyB64: Buffer.from(`ok:${m.path}`, 'utf8').toString('base64') });
    };
    const { sid, ticket } = await approveSid(d, base);

    // Sin cookie: 401 (no revela nada).
    const denied = await fetch(`${base}/s/${sid}/api/v1/ping`);
    expect(denied.status).toBe(401);

    // Claim con ticket: fija cookie HttpOnly con Path=/s/<sid>/.
    const claim = await fetch(`${base}/s/${sid}/claim?ticket=${ticket}`, { redirect: 'manual' });
    expect(claim.status).toBe(200);
    const setCookie = claim.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('bundeck_s=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain(`Path=/s/${sid}/`);
    expect(setCookie).not.toContain(ticket);
    const cookie = setCookie.split(';')[0];

    // Con cookie: proxy OK y la URL nunca contiene el secreto.
    const ok = await fetch(`${base}/s/${sid}/api/v1/ping`, { headers: { cookie } });
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe('ok:/api/v1/ping');

    // La cookie no se reenvía al daemon.
    let seenCookie: string | undefined;
    d.httpHandler = (m) => {
      seenCookie = (m.headers as Record<string, string>)?.cookie ?? (m.headers as Record<string, string>)?.Cookie;
      d.send({ v: 1, kind: 'http-res', id: m.id, status: 200, headers: { 'content-type': 'text/plain' }, bodyB64: Buffer.from('x', 'utf8').toString('base64') });
    };
    await fetch(`${base}/s/${sid}/x`, { headers: { cookie } });
    expect(seenCookie ?? '').not.toContain('bundeck_s');
  });

  test('ticket de un solo uso; ticket ajeno no vale', async () => {
    const relay = startRelay();
    const base = `http://127.0.0.1:${relay.port}`;
    const d = await registeredDaemon(relay.port);
    d.httpHandler = (m) => {
      d.send({ v: 1, kind: 'http-res', id: m.id, status: 200, headers: {}, bodyB64: Buffer.from('x', 'utf8').toString('base64') });
    };
    const { sid, ticket } = await approveSid(d, base);
    const first = await fetch(`${base}/s/${sid}/claim?ticket=${ticket}`, { redirect: 'manual' });
    expect(first.status).toBe(200);
    const cookie = (first.headers.get('set-cookie') ?? '').split(';')[0];
    expect(cookie).toContain('bundeck_s=');

    // Reuso del mismo ticket: 401.
    const replay = await fetch(`${base}/s/${sid}/claim?ticket=${ticket}`);
    expect(replay.status).toBe(401);

    // Ticket válido pero sid distinto: 401.
    const otherSid = 'ff'.repeat(16);
    const cross = await fetch(`${base}/s/${otherSid}/claim?ticket=${ticket}`);
    expect(cross.status).toBe(401);

    // Cookie de otra sid no autoriza.
    const bad = await fetch(`${base}/s/${otherSid}/api/v1/p`, { headers: { cookie } });
    expect(bad.status).toBe(401);
  });

  test('html inyecta <base href="/s/<sid>/"> y reescribe assets', async () => {
    const relay = startRelay();
    const base = `http://127.0.0.1:${relay.port}`;
    const d = await registeredDaemon(relay.port);
    d.httpHandler = (m) => {
      d.send({
        v: 1, kind: 'http-res', id: m.id, status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
        bodyB64: Buffer.from('<html><head><link rel="stylesheet" href="/_astro/a.css"></head><body><img src="/i.png"></body></html>', 'utf8').toString('base64'),
      });
    };
    const { sid, ticket } = await approveSid(d, base);
    const claim = await fetch(`${base}/s/${sid}/claim?ticket=${ticket}`, { redirect: 'manual' });
    const cookie = (claim.headers.get('set-cookie') ?? '').split(';')[0];
    const res = await fetch(`${base}/s/${sid}/`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(`<base href="/s/${sid}/">`);
    expect(html).toContain(`href="/s/${sid}/_astro/a.css"`);
    expect(html).not.toContain(SECRET);
  });

  test('WS /s/<sid>/ws exige cookie; la cookie del claim valida', async () => {
    const relay = startRelay();
    const base = `http://127.0.0.1:${relay.port}`;
    const d = await registeredDaemon(relay.port);
    d.send({ v: 1, kind: 'ui-publish', urlCode: CODE, exp: Date.now() + 600_000 });
    await d.next((m) => m.kind === 'ui-published');
    await fetch(`${base}/ui/${CODE}`);
    const req = await d.next((m) => m.kind === 'ui-request');
    d.send({ v: 1, kind: 'ui-decision', reqId: req.reqId, allow: true });
    await d.next((m) => m.kind === 'ui-decision-ack');
    d.send({ v: 1, kind: 'ui-bind', urlCode: CODE, sid: SID, secret: SECRET, exp: Date.now() + 600_000 });
    await d.next((m) => m.kind === 'ui-bound');
    const st = await (await fetch(`${base}/ui/${CODE}/status`)).json();
    const claim = await fetch(`${base}/s/${SID}/claim?ticket=${st.ticket}`, { redirect: 'manual' });
    const setCookie = claim.headers.get('set-cookie') ?? '';
    const cookie = setCookie.split(';')[0];
    expect(cookie).toContain('bundeck_s=');
    // La cookie del claim valida a nivel de estado (misma función que usa el upgrade WS).
    const secretFromCookie = decodeURIComponent(cookie.split('=').slice(1).join('='));
    expect(relay.tunnel.validateSid(SID, secretFromCookie)).toBe(true);
    expect(relay.tunnel.validateSid(SID, '00'.repeat(32))).toBe(false);
    expect(relay.tunnel.validateSid('ff'.repeat(16), secretFromCookie)).toBe(false);

    // Sin cookie: el upgrade WS se rechaza (401 en vez de 101).
    let failed = false;
    try {
      const bad = new WebSocket(`ws://127.0.0.1:${relay.port}/s/${SID}/ws`);
      sockets.push(bad);
      await new Promise<void>((resolve, reject) => {
        bad.addEventListener('open', () => resolve(), { once: true });
        bad.addEventListener('error', () => reject(new Error('expected fail')), { once: true });
        setTimeout(() => reject(new Error('expected fail')), 1500);
      });
    } catch { failed = true; }
    expect(failed).toBe(true);
    // Nota: el cliente WS de Bun en tests no permite fijar `Cookie` a mano,
    // pero el navegador real sí la envía sola en el handshake (mismo origen).
    // El gate es el mismo `validateSid` ya probado arriba + el proxy HTTP con cookie.
  });

  test('unbind por sid revoca cookie y claim futuros', async () => {
    const relay = startRelay();
    const base = `http://127.0.0.1:${relay.port}`;
    const d = await registeredDaemon(relay.port);
    d.httpHandler = (m) => {
      d.send({ v: 1, kind: 'http-res', id: m.id, status: 200, headers: {}, bodyB64: Buffer.from('x', 'utf8').toString('base64') });
    };
    const { sid, ticket } = await approveSid(d, base);
    const claim = await fetch(`${base}/s/${sid}/claim?ticket=${ticket}`, { redirect: 'manual' });
    const cookie = (claim.headers.get('set-cookie') ?? '').split(';')[0];
    expect((await fetch(`${base}/s/${sid}/p`, { headers: { cookie } })).status).toBe(200);

    d.send({ v: 1, kind: 'ui-unbind', sid, sessionToken: sid });
    await d.next((m) => m.kind === 'ui-unbound');
    expect((await fetch(`${base}/s/${sid}/p`, { headers: { cookie } })).status).toBe(401);
  });

  test('legacy /t/* sigue funcionando tras el cambio', async () => {
    const relay = startRelay();
    const base = `http://127.0.0.1:${relay.port}`;
    const d = await registeredDaemon(relay.port);
    d.httpHandler = (m) => {
      d.send({ v: 1, kind: 'http-res', id: m.id, status: 200, headers: {}, bodyB64: Buffer.from(`echo:${m.path}`, 'utf8').toString('base64') });
    };
    const TOK = 'ab'.repeat(32);
    d.send({ v: 1, kind: 'ui-publish', urlCode: CODE, exp: Date.now() + 600_000 });
    await d.next((m) => m.kind === 'ui-published');
    await fetch(`${base}/ui/${CODE}`);
    const req = await d.next((m) => m.kind === 'ui-request');
    d.send({ v: 1, kind: 'ui-decision', reqId: req.reqId, allow: true });
    await d.next((m) => m.kind === 'ui-decision-ack');
    d.send({ v: 1, kind: 'ui-bind', urlCode: CODE, sessionToken: TOK, exp: Date.now() + 600_000 });
    await d.next((m) => m.kind === 'ui-bound');
    const st = await (await fetch(`${base}/ui/${CODE}/status`)).json();
    expect(st.sessionToken).toBe(TOK);
    const res = await fetch(`${base}/t/${TOK}/hello`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('echo:/hello');
  });

  test('/s/<sid>/ws con cookie válida se queda abierto (regresión 4401)', async () => {
    const relay = startRelay();
    const base = `http://127.0.0.1:${relay.port}`;
    const d = await registeredDaemon(relay.port);
    const { sid, ticket } = await approveSid(d, base);
    const claim = await fetch(`${base}/s/${sid}/claim?ticket=${ticket}`, { redirect: 'manual' });
    expect(claim.status).toBe(200);
    const cookie = (claim.headers.get('set-cookie') ?? '').split(';')[0];
    expect(cookie).toContain('bundeck_s=');

    // Puente /s/ con cookie válida: el upgrade abre y el relay NO lo cierra
    // (antes: onTunnelBridgeOpen solo miraba sesiones legacy y cerraba con 4401 'expired').
    const ws = new WebSocket(`ws://127.0.0.1:${relay.port}/s/${sid}/ws`, { headers: { cookie } } as any);
    sockets.push(ws);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true });
      ws.addEventListener('error', () => reject(new Error('ws /s/ open failed')), { once: true });
      setTimeout(() => reject(new Error('ws /s/ open timeout')), 3000);
    });
    // El daemon recibe el ws-open del puente.
    const opened = await d.next((m) => m.kind === 'ws-open');
    expect(typeof opened.id).toBe('string');
    // Sigue abierto tras el handshake.
    await new Promise((r) => setTimeout(r, 500));
    expect(ws.readyState).toBe(WebSocket.OPEN);

    // Sid desconocido: el upgrade se rechaza (ni siquiera abre).
    let rejected = false;
    try {
      const bad = new WebSocket(`ws://127.0.0.1:${relay.port}/s/${'ff'.repeat(16)}/ws`, { headers: { cookie } } as any);
      sockets.push(bad);
      await new Promise<void>((resolve, reject) => {
        bad.addEventListener('open', () => reject(new Error('no debería abrir')), { once: true });
        bad.addEventListener('error', () => resolve(), { once: true });
        setTimeout(() => reject(new Error('timeout esperando rechazo')), 3000);
      });
      rejected = true;
    } catch { rejected = false; }
    expect(rejected).toBe(true);
  });

  test('onTunnelBridgeOpen acepta puentes sid vigentes y cierra 4401 los desconocidos', async () => {
    const relay = startRelay();
    const base = `http://127.0.0.1:${relay.port}`;
    const d = await registeredDaemon(relay.port);
    await approveSid(d, base);
    const srv = relay as any;
    // Sid vigente: no se cierra y el puente queda registrado.
    let closed: { code: number; reason: string } | null = null;
    srv.onTunnelBridgeOpen({ close: (c: number, r: string) => { closed = { code: c, reason: r }; } }, { id: 'ws-sid-1', token: SID, deviceId: 'daemon-1' });
    expect(closed).toBeNull();
    expect(srv.tunnel.getBridge('ws-sid-1')).toBeDefined();
    // Sid desconocido: 4401 'expired' (no cuelga, no registra).
    closed = null;
    srv.onTunnelBridgeOpen({ close: (c: number, r: string) => { closed = { code: c, reason: r }; } }, { id: 'ws-sid-2', token: 'ff'.repeat(16), deviceId: 'daemon-1' });
    expect(closed).toEqual({ code: 4401, reason: 'expired' });
    expect(srv.tunnel.getBridge('ws-sid-2')).toBeUndefined();
  });
});
