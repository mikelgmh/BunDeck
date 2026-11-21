/**
 * relay-wire.test.ts — Integración real daemon ↔ relay por el cable.
 *
 * Levanta un `RelayServer` de verdad (puerto efímero) y conecta dos
 * `RelayClient` del daemon: register, roundtrip de sobre E2E (`signal`
 * con `payloadEncrypted`), error `offline` sin romper, y auth del upgrade
 * (`?token=` cuando el relay exige secreto, abierto cuando no).
 *
 * Este es el test que habría cazado la divergencia de protocolos:
 * el cliente hablaba `register` sin `v/nonce/exp` y esperaba `envelope`,
 * mientras el relay exige el sobre versionado y reenvía `signal`.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Relay real (solo bun:sqlite + node:crypto; sin dependencias nativas extra).
// eslint-disable-next-line @typescript-eslint/no-require-imports
import { RelayServer } from '../../../relay/src/relay';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import { DeviceStore } from '../../../relay/src/store';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import { PairingStore } from '../../../relay/src/pairing';

import { RelayClient, type RelayEnvelopeMsg } from '../remote/relay-client';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ld-relay-wire-test-'));

let servers: RelayServer[] = [];
let stores: DeviceStore[] = [];
let clients: RelayClient[] = [];
let savedEnv: Record<string, string | undefined> = {};

function fakeDb() {
  return { getSetting: (_k: string) => null } as any;
}

function startRelay(token = ''): RelayServer {
  const dir = fs.mkdtempSync(path.join(ROOT, 'r-'));
  const store = new DeviceStore(dir);
  stores.push(store);
  const relay = new RelayServer({ token, store, pairing: new PairingStore() });
  relay.listen(0, '127.0.0.1');
  servers.push(relay);
  return relay;
}

function makeClient(deviceId: string): { client: RelayClient; received: RelayEnvelopeMsg[] } {
  const received: RelayEnvelopeMsg[] = [];
  const client = new RelayClient(fakeDb(), { deviceId, publicKeyB64: `pub-${deviceId}` });
  client.onEnvelope((env) => { received.push(env); });
  clients.push(client);
  return { client, received };
}

async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (cond()) return;
    if (Date.now() - start > timeoutMs) throw new Error('timeout esperando condición del relay');
    await new Promise((r) => setTimeout(r, 50));
  }
}

beforeEach(() => {
  savedEnv = { RELAY_URL: process.env.RELAY_URL, RELAY_TOKEN: process.env.RELAY_TOKEN };
});

afterEach(async () => {
  for (const c of clients.splice(0)) {
    try { c.stop(); } catch { /* noop */ }
  }
  for (const r of servers.splice(0)) {
    try { r.stop(); } catch { /* noop */ }
  }
  for (const s of stores.splice(0)) {
    try { s.close(); } catch { /* noop */ }
  }
  if (savedEnv.RELAY_URL === undefined) delete process.env.RELAY_URL;
  else process.env.RELAY_URL = savedEnv.RELAY_URL;
  if (savedEnv.RELAY_TOKEN === undefined) delete process.env.RELAY_TOKEN;
  else process.env.RELAY_TOKEN = savedEnv.RELAY_TOKEN;
  await new Promise((r) => setTimeout(r, 100));
});

describe('relay-wire: daemon ↔ relay por el cable', () => {
  test('register + roundtrip de sobre E2E (signal/payloadEncrypted)', async () => {
    const relay = startRelay('');
    process.env.RELAY_URL = `ws://127.0.0.1:${relay.port}`;
    delete process.env.RELAY_TOKEN;

    const a = makeClient('dev-a');
    const b = makeClient('dev-b');
    a.client.start();
    b.client.start();
    await waitFor(() => a.client.getState() === 'connected' && b.client.getState() === 'connected');

    const ok = a.client.sendEnvelope('dev-b', {
      from: 'dev-a',
      nonce: 'n1',
      ciphertext: 'Y2lwaGVy',
      ts: Date.now(),
      seq: 1,
      v: 1,
    } as any);
    expect(ok).toBe(true);
    await waitFor(() => b.received.length > 0);
    expect(b.received[0].type).toBe('envelope');
    expect(b.received[0].from).toBe('dev-a');
    expect(b.received[0].to).toBe('dev-b');
    expect(b.received[0].ciphertext).toBe('Y2lwaGVy');
    // El relay nunca ve el contenido: solo reenvía.
    expect(JSON.stringify(b.received[0])).not.toMatch(/plaintext/i);
  });

  test('destino offline no rompe la conexión', async () => {
    const relay = startRelay('');
    process.env.RELAY_URL = `ws://127.0.0.1:${relay.port}`;
    delete process.env.RELAY_TOKEN;

    const a = makeClient('dev-a2');
    a.client.start();
    await waitFor(() => a.client.getState() === 'connected');
    const ok = a.client.sendEnvelope('ghost-device', {
      from: 'dev-a2',
      nonce: 'n9',
      ciphertext: 'eA==',
      ts: Date.now(),
      seq: 1,
      v: 1,
    } as any);
    expect(ok).toBe(true);
    await new Promise((r) => setTimeout(r, 500));
    expect(a.client.getState()).toBe('connected');
  });

  test('relay con secreto: sin token no conecta; con ?token sí', async () => {
    const relay = startRelay('s3cr3t');
    process.env.RELAY_URL = `ws://127.0.0.1:${relay.port}`;

    delete process.env.RELAY_TOKEN;
    const blocked = makeClient('dev-noauth');
    blocked.client.start();
    await new Promise((r) => setTimeout(r, 1500));
    expect(blocked.client.getState()).not.toBe('connected');
    blocked.client.stop();

    process.env.RELAY_TOKEN = 's3cr3t';
    const allowed = makeClient('dev-auth');
    allowed.client.start();
    await waitFor(() => allowed.client.getState() === 'connected');
  });
});
