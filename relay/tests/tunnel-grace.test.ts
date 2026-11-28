import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeviceStore } from '../src/store';
import { PairingStore } from '../src/pairing';
import { RelayServer } from '../src/relay';

/**
 * Ventana de gracia post-redespliegue (fix "Sesión no válida al recargar
 * tras redesplegar el relay"):
 * - Token/sid desconocido recién arrancado → 502 daemon-offline +
 *   Retry-After (reintentable: el daemon aún no re-anunció con ui-rebind).
 * - Pasada la gracia → 401 invalid-token definitivo (pedir QR nuevo).
 * - Caducado (expired) sigue 401 definitivo incluso en gracia.
 * - /health expone {storage, graceActive} para verificar el despliegue.
 * - DeviceStore grita su modo (persistent vs fallback efímero).
 */

const TOKEN = 'test-relay-token';
const servers: RelayServer[] = [];
const stores: DeviceStore[] = [];
const sockets: WebSocket[] = [];

const TOK = 'ab'.repeat(32); // 64 hex
const SID = 'cd'.repeat(16); // 32 hex (>= 16, sid público)

function startGraceRelay(opts: { graceMs?: number; now?: () => number } = {}): { relay: RelayServer; base: string } {
  const dir = mkdtempSync(join(tmpdir(), 'relay-grace-test-'));
  const store = new DeviceStore(dir);
  stores.push(store);
  const relay = new RelayServer({
    token: TOKEN,
    store,
    pairing: new PairingStore(),
    unknownTokenGraceMs: opts.graceMs ?? 60_000,
    ...(opts.now ? { now: opts.now } : {}),
  });
  relay.listen(0, '127.0.0.1');
  servers.push(relay);
  return { relay, base: `http://127.0.0.1:${relay.port}` };
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

class FakeDaemon {
  ws!: WebSocket;
  buf: unknown[] = [];
  httpHandler: ((m: { id: string }) => void) | null = null;

  async connect(port: number): Promise<this> {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${TOKEN}`);
    sockets.push(this.ws);
    this.ws.addEventListener('message', (e) => {
      let m: { kind?: string; id?: string } | null = null;
      try {
        m = JSON.parse(String((e as MessageEvent).data)) as { kind?: string; id?: string };
      } catch {
        return;
      }
      this.buf.push(m);
      try {
        if (m?.kind === 'http-req' && this.httpHandler) this.httpHandler(m as { id: string });
      } catch {
        /* test */
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

  next(pred: (m: { kind?: string }) => boolean, timeoutMs = 3000): Promise<{ kind?: string } & Record<string, unknown>> {
    const take = (): (({ kind?: string } & Record<string, unknown>) | undefined) => {
      const i = this.buf.findIndex((x) => pred(x as { kind?: string }));
      return i >= 0 ? (this.buf.splice(i, 1)[0] as { kind?: string } & Record<string, unknown>) : undefined;
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

async function registeredDaemon(port: number, deviceId = 'daemon-1'): Promise<FakeDaemon> {
  const d = await new FakeDaemon().connect(port);
  d.send({ v: 1, kind: 'tunnel-register', deviceId });
  const ack = await d.next((m) => m.kind === 'tunnel-registered');
  expect(ack.deviceId).toBe(deviceId);
  return d;
}

describe('ventana de gracia post-arranque (unknown token)', () => {
  test('/t/<token> desconocido en gracia → 502 daemon-offline + Retry-After (JSON)', async () => {
    const { base } = startGraceRelay();
    const res = await fetch(`${base}/t/${TOK}/api/v1/profiles`, { headers: { accept: 'application/json' } });
    expect(res.status).toBe(502);
    expect(res.headers.get('retry-after')).toBeTruthy();
    expect(await res.json()).toEqual({ error: 'daemon-offline' });
  });

  test('/t/<token> desconocido en gracia, navegación → HTML daemon-offline con auto-reintento', async () => {
    const { base } = startGraceRelay();
    const res = await fetch(`${base}/t/${TOK}/`, { headers: { accept: 'text/html' } });
    expect(res.status).toBe(502);
    expect(res.headers.get('retry-after')).toBeTruthy();
    const html = await res.text();
    expect(html).toContain('data-tunnel-gone="daemon-offline"');
    // Auto-reintento con backoff + parada en 401 definitivo.
    expect(html).toContain('tunnel-retry-note');
    expect(html).not.toContain(TOK);
  });

  test('/t/<token> desconocido PASADA la gracia → 401 invalid-token (pedir QR nuevo)', async () => {
    let nowMs = 1_000_000;
    const { base } = startGraceRelay({ graceMs: 60_000, now: () => nowMs });
    nowMs += 300_000; // 5 min después: fuera de gracia
    const res = await fetch(`${base}/t/${TOK}/api/v1/profiles`, { headers: { accept: 'application/json' } });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'invalid-token' });
  });

  test('gracia desactivada (0) → 401 inmediato', async () => {
    const { base } = startGraceRelay({ graceMs: 0 });
    const res = await fetch(`${base}/t/${TOK}/p`);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'invalid-token' });
  });

  test('WS /t/<token>/ws desconocido en gracia → 502 (no upgrade)', async () => {
    const { base } = startGraceRelay();
    const res = await fetch(`${base}/t/${TOK}/ws`, { headers: { upgrade: 'websocket' } });
    expect(res.status).toBe(502);
    expect(res.headers.get('retry-after')).toBeTruthy();
  });

  test('/s/<sid> desconocido en gracia → 502 daemon-offline + Retry-After', async () => {
    const { base } = startGraceRelay();
    const res = await fetch(`${base}/s/${SID}/api/v1/profiles`, { headers: { accept: 'application/json' } });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'daemon-offline' });
  });

  test('sesión CADUCADA en gracia → 401 expired definitivo (no reintenta)', async () => {
    let nowMs = 5_000_000;
    const { base, relay } = startGraceRelay({ graceMs: 60_000, now: () => nowMs });
    const d = await registeredDaemon(relay.port);
    d.send({ v: 1, kind: 'ui-rebind', sessionToken: TOK, exp: nowMs + 500 });
    await d.next((m) => m.kind === 'ui-rebound');
    nowMs += 60_000; // sesión vencida (pero aún dentro de la gracia de arranque)
    const res = await fetch(`${base}/t/${TOK}/p`, { headers: { accept: 'application/json' } });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'expired' });
  });

  test('e2e recarga en ventana de reconexión: 502 → rebind del daemon → 200 sin QR nuevo', async () => {
    // Simula redespliegue con base vacía: el relay arranca sin la sesión,
    // el navegador recarga (502 + Retry-After + poll), el daemon reconecta
    // y re-anuncia con ui-rebind, y el siguiente poll ya da 200.
    const { base, relay } = startGraceRelay({ graceMs: 120_000 });
    const gone = await fetch(`${base}/t/${TOK}/`, { headers: { accept: 'text/html' } });
    expect(gone.status).toBe(502);

    const d = await registeredDaemon(relay.port, 'daemon-1');
    d.httpHandler = (m) => {
      d.send({
        v: 1,
        kind: 'http-res',
        id: m.id,
        status: 200,
        headers: { 'content-type': 'text/plain' },
        bodyB64: Buffer.from('ok-reconnect', 'utf8').toString('base64'),
      });
    };
    d.send({ v: 1, kind: 'ui-rebind', sessionToken: TOK, exp: Date.now() + 600_000 });
    await d.next((m) => m.kind === 'ui-rebound');

    const ok = await fetch(`${base}/t/${TOK}/p`);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe('ok-reconnect');
  });

  test('puente WS con token desconocido en gracia → 1013 reintentable; caducado → 4401', async () => {
    let nowMs = 9_000_000;
    const { relay } = startGraceRelay({ graceMs: 60_000, now: () => nowMs });
    const srv = relay as unknown as {
      onTunnelBridgeOpen: (ws: { close: (c: number, r: string) => void }, br: { id: string; token: string; deviceId: string }) => void;
    };
    let closed: { code: number; reason: string } | null = null;
    const ws = { close: (c: number, r: string) => { closed = { code: c, reason: r }; } };
    srv.onTunnelBridgeOpen(ws, { id: 'ws-g1', token: TOK, deviceId: 'daemon-1' });
    expect(closed).toEqual({ code: 1013, reason: 'daemon offline, retry' });

    // Pasada la gracia: 4401 definitivo.
    nowMs += 300_000;
    closed = null;
    srv.onTunnelBridgeOpen(ws, { id: 'ws-g2', token: TOK, deviceId: 'daemon-1' });
    expect(closed).toEqual({ code: 4401, reason: 'invalid token' });
  });

  test('/health expone storage + graceActive para verificar el despliegue', async () => {
    let nowMs = 7_000_000;
    const { base } = startGraceRelay({ graceMs: 60_000, now: () => nowMs });
    const h1 = (await (await fetch(`${base}/health`)).json()) as Record<string, unknown>;
    expect(h1.ok).toBe(true);
    expect(h1.storage).toBe('persistent');
    expect(h1.graceActive).toBe(true);
    nowMs += 300_000;
    const h2 = (await (await fetch(`${base}/health`)).json()) as Record<string, unknown>;
    expect(h2.graceActive).toBe(false);
  });
});

describe('persistencia del relay (a prueba de pérdida)', () => {
  test('DeviceStore en dir escribible → storageMode persistent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-store-mode-'));
    const store = new DeviceStore(dir);
    stores.push(store);
    expect(store.storageMode).toBe('persistent');
    expect(store.storageDir).toBe(dir);
  });

  test('DeviceStore con DATA_DIR no escribible (fichero) → fallback-tmp y grita', () => {
    const file = join(tmpdir(), `relay-store-file-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    writeFileSync(file, 'x');
    const store = new DeviceStore(file);
    stores.push(store);
    // mkdirSync/accessSync sobre un fichero fallan → cae al tmpdir efímero.
    expect(store.storageMode).toBe('fallback-tmp');
    expect(store.storageDir).not.toBe(file);
  });

  test('persist-restore tras reinicio: la sesión sigue y el proxy da 502 hasta el rebind y 200 después', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-grace-persist-'));
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
    d.send({ v: 1, kind: 'ui-publish', urlCode: 'grace-code-abc1', exp: Date.now() + 600_000 });
    await d.next((m) => m.kind === 'ui-published');
    d.send({ v: 1, kind: 'ui-bind', urlCode: 'grace-code-abc1', sessionToken: TOK, exp: Date.now() + 600_000 });
    await d.next((m) => m.kind === 'ui-bound');
    expect(store.listTunnelSessions().some((s) => s.token === TOK)).toBe(true);

    relay.stop();
    servers.splice(servers.indexOf(relay), 1);
    const relay2 = mk();
    const base2 = `http://127.0.0.1:${relay2.port}`;
    // Sesión restaurada de SQLite pero daemon aún no reconectado.
    const res = await fetch(`${base2}/t/${TOK}/p`);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'daemon-offline' });

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
});
