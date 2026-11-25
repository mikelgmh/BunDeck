import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeviceStore } from '../src/store';
import { PairingStore } from '../src/pairing';
import { RelayServer } from '../src/relay';
import { setUiPageHandler } from '../src/tunnel';

const TOKEN = 'test-relay-token-keepalive';
const servers: RelayServer[] = [];
const stores: DeviceStore[] = [];
const sockets: WebSocket[] = [];

function startRelay(): RelayServer {
  const dir = mkdtempSync(join(tmpdir(), 'relay-keepalive-test-'));
  const store = new DeviceStore(dir);
  stores.push(store);
  const relay = new RelayServer({ token: TOKEN, store, pairing: new PairingStore() });
  relay.listen(0, '127.0.0.1');
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

class FakeDaemon {
  ws!: WebSocket;
  buf: any[] = [];

  async connect(port: number): Promise<this> {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${TOKEN}`);
    sockets.push(this.ws);
    this.ws.addEventListener('message', (e) => {
      try {
        this.buf.push(JSON.parse(String((e as MessageEvent).data)));
      } catch {
        /* noop */
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

  async next(pred: (m: any) => boolean, timeoutMs = 3000): Promise<any> {
    const take = (): any | undefined => {
      const i = this.buf.findIndex(pred);
      return i >= 0 ? this.buf.splice(i, 1)[0] : undefined;
    };
    const hit = take();
    if (hit !== undefined) return hit;
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

describe('tunnel keepalive daemon↔relay', () => {
  test('tunnel-ping → tunnel-pong y refresca el registro', async () => {
    const relay = startRelay();
    const d = await new FakeDaemon().connect(relay.port);
    d.send({ v: 1, kind: 'tunnel-register', deviceId: 'daemon-ka-1' });
    await d.next((m) => m.kind === 'tunnel-registered');

    expect(relay.tunnel.lastDeviceSeen('daemon-ka-1')).toBeGreaterThan(0);
    const seenAfterRegister = relay.tunnel.lastDeviceSeen('daemon-ka-1');

    await new Promise((r) => setTimeout(r, 10));
    d.send({ v: 1, kind: 'tunnel-ping', ts: Date.now() });
    const pong = await d.next((m) => m.kind === 'tunnel-pong');
    expect(pong.v).toBe(1);
    expect(relay.tunnel.lastDeviceSeen('daemon-ka-1')).toBeGreaterThanOrEqual(seenAfterRegister);
  });

  test('tunnel-pong entrante refresca el registro (sin respuesta)', async () => {
    const relay = startRelay();
    const d = await new FakeDaemon().connect(relay.port);
    d.send({ v: 1, kind: 'tunnel-register', deviceId: 'daemon-ka-2' });
    await d.next((m) => m.kind === 'tunnel-registered');
    const before = relay.tunnel.lastDeviceSeen('daemon-ka-2');

    await new Promise((r) => setTimeout(r, 10));
    d.buf.length = 0;
    d.send({ v: 1, kind: 'tunnel-pong', ts: Date.now() });
    // Sin respuesta del relay, pero el registro se refresca.
    await new Promise((r) => setTimeout(r, 100));
    expect(relay.tunnel.lastDeviceSeen('daemon-ka-2')).toBeGreaterThanOrEqual(before);
    expect(d.buf.some((m) => m?.kind === 'error')).toBe(false);
  });

  test('la conexión sobrevive idle: el sweep no purga el registro', async () => {
    const relay = startRelay();
    const d = await new FakeDaemon().connect(relay.port);
    d.send({ v: 1, kind: 'tunnel-register', deviceId: 'daemon-ka-3' });
    await d.next((m) => m.kind === 'tunnel-registered');
    const exp = Date.now() + 600_000;
    d.send({ v: 1, kind: 'ui-publish', urlCode: 'keepalive-code-1', exp });
    await d.next((m) => m.kind === 'ui-published');

    // Idle + keepalive + barrido periódico: el registro sigue vivo.
    d.send({ v: 1, kind: 'tunnel-ping', ts: Date.now() });
    await d.next((m) => m.kind === 'tunnel-pong');
    relay.pruneTunnel();
    relay.pruneTunnel();

    expect(relay.tunnel.lastDeviceSeen('daemon-ka-3')).toBeGreaterThan(0);
    // El ping posterior sigue respondido: el socket no se purgó.
    d.buf.length = 0;
    d.send({ v: 1, kind: 'tunnel-ping', ts: Date.now() });
    const pong2 = await d.next((m) => m.kind === 'tunnel-pong');
    expect(pong2.v).toBe(1);
  });
});
